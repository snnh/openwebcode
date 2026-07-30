import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { listPersonas, resolvePersona } from "../src/extensions/env-sim/index.js";
import { loadUserPresets, personasDir } from "../src/extensions/env-sim/preset-store.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-envsim-"));
  roots.push(root);
  return root;
}

interface ToolCallSpec { id: string; name: string; input: Record<string, unknown> }

/** 剧本式 provider：第一轮回放给定 tool_call，之后纯文本收尾；全程记录请求。 */
function scriptProvider(requests: StreamChatRequest[], script: ToolCallSpec[][]): Provider {
  let turn = 0;
  return {
    name: "fake",
    async *streamChat(request: StreamChatRequest) {
      requests.push(request);
      const calls = script[turn++] ?? [];
      if (calls.length === 0) {
        yield { type: "text_delta", text: "已完成。" };
        yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      for (const call of calls) yield { type: "tool_call", id: call.id, name: call.name, input: call.input };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "tool_use" };
    },
  };
}

const FAKE_CORE_INFO = {
  version: "0.0.0-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
} as const;

function fakeCore(runCalls: Array<Record<string, unknown>>): CoreClientLike {
  return {
    on() { return this; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile() { return { content: "file content" }; },
    async globFiles() { return { matches: [] }; },
    async grepFiles() { return { matches: [] }; },
    async writeFile() { return { ok: true }; },
    async editFile() { return { matches: 1 }; },
    async run(request: Record<string, unknown>) { runCalls.push(request); return { exitCode: 0, stdout: "ok", stderr: "" }; },
    async cleanupSession() { return { ok: true }; },
    setRequestTimeoutMs() {},
    start() { return Promise.resolve(FAKE_CORE_INFO); },
    stop() { return Promise.resolve(); },
    ping() { return Promise.resolve(FAKE_CORE_INFO); },
    listFiles() { return Promise.resolve({ entries: [], truncated: false }); },
  } as unknown as CoreClientLike;
}

interface HarnessOptions {
  enableEnvSim?: boolean;
  persona?: string;
  agentMode?: "plan" | "build";
  fileBaseOverride?: string;
  presetFiles?: Array<{ filename: string; content: string }>;
  script?: ToolCallSpec[][];
}

async function setup(options: HarnessOptions = {}) {
  const root = await tempRoot();
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
  // yolo 直达 fake core；manual 避免无关的 GitShadow 检查点
  await sessions.updateConfig(session.id, { provider: "fake", model: "model", agentMode: options.agentMode ?? "build", snapshotMode: "manual" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  if (options.fileBaseOverride !== undefined) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "system-prompt.md"), options.fileBaseOverride, "utf8");
  }
  for (const preset of options.presetFiles ?? []) {
    await mkdir(personasDir(dataDir), { recursive: true });
    await writeFile(path.join(personasDir(dataDir), preset.filename), preset.content, "utf8");
  }
  const requests: StreamChatRequest[] = [];
  const providers = new ProviderRegistry();
  providers.register(scriptProvider(requests, options.script ?? []));
  const runCalls: Array<Record<string, unknown>> = [];
  const core = fakeCore(runCalls);
  const manager = new ExtensionManager(dataDir, events, { sessions });
  await manager.initialize();
  if (options.enableEnvSim) await manager.configure("env-sim", { enabled: true, config: { persona: options.persona ?? "" } });
  const agent = new AgentRunner(
    sessions, providers, core, events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined,
    dataDir, undefined, undefined, undefined, undefined, undefined, undefined, manager,
  );
  return { root, dataDir, sessions, session, events, requests, runCalls, manager, agent };
}

function toolResults(detail: { messages: Array<{ role: string; content: Array<{ type: string }> }> } | null) {
  return (detail?.messages ?? [])
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .filter((block): block is { type: "tool_result"; toolCallId: string; content: string; isError?: boolean } => block.type === "tool_result");
}

describe("env-sim prompt.beforeBuild", () => {
  it("applies the persona identity and base prompt while keeping the core safety boundary", async () => {
    const { agent, session, requests, manager } = await setup({ enableEnvSim: true, persona: "claude-code" });
    try {
      await agent.run(session.id, "你好");
      const system = requests[0]!.system;
      expect(system).toContain("You are Claude Code, Anthropic's agentic coding tool.");
      expect(system).not.toContain("You are OpenWebCode. The workspace");
      // 核心安全网不可被钩子移除
      expect(system).toContain("## Safety boundary");
      expect(system).toContain("Prompt version:");
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("restores the default prompt when persona is empty or the extension is disabled", async () => {
    const emptyPersona = await setup({ enableEnvSim: true, persona: "" });
    try {
      await emptyPersona.agent.run(emptyPersona.session.id, "你好");
      expect(emptyPersona.requests[0]!.system).toContain("You are OpenWebCode. The workspace");
    } finally {
      await emptyPersona.manager.close();
    }
    const disabled = await setup();
    try {
      await disabled.agent.run(disabled.session.id, "你好");
      expect(disabled.requests[0]!.system).toContain("You are OpenWebCode. The workspace");
    } finally {
      await disabled.manager.close();
    }
  }, 30_000);

  it("composes with the file-based override: persona base wins only when it sets one", async () => {
    const fileOnly = await setup({ enableEnvSim: true, persona: "", fileBaseOverride: "FILE BASE BODY\n" });
    try {
      await fileOnly.agent.run(fileOnly.session.id, "你好");
      expect(fileOnly.requests[0]!.system).toContain("FILE BASE BODY");
    } finally {
      await fileOnly.manager.close();
    }
    const persona = await setup({ enableEnvSim: true, persona: "zcode", fileBaseOverride: "FILE BASE BODY\n" });
    try {
      await persona.agent.run(persona.session.id, "你好");
      const system = persona.requests[0]!.system;
      expect(system).toContain("You are ZCode, a terminal-native AI pair programmer.");
      expect(system).not.toContain("FILE BASE BODY");
      expect(system).toContain("## Safety boundary");
    } finally {
      await persona.manager.close();
    }
  }, 30_000);
  it("session-level persona overrides the extension-wide config", async () => {
    const { agent, session, sessions, requests, manager } = await setup({ enableEnvSim: true, persona: "codex" });
    try {
      await sessions.updateConfig(session.id, { provider: "fake", model: "model", persona: "claude-code" });
      await agent.run(session.id, "你好");
      const system = requests[0]!.system;
      expect(system).toContain("You are Claude Code, Anthropic's agentic coding tool.");
      const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
      // 工具形态也跟随会话级 persona（cc 形态而非 codex 形态）
      expect(names).toContain("TodoWrite");
      expect(names).not.toContain("apply_patch");
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("env-sim tool shaping", () => {
  it("renames aliased built-ins and hides OWC-specific tools in the provider request", async () => {
    const { agent, session, requests, manager } = await setup({ enableEnvSim: true, persona: "claude-code" });
    try {
      await agent.run(session.id, "你好");
      const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
      for (const expected of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite", "Task"]) expect(names).toContain(expected);
      for (const hidden of ["bash", "read_file", "write_file", "edit_file", "glob", "grep", "read_artifact", "spawn_swarm", "remember"]) expect(names).not.toContain(hidden);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("executes an alias call through the built-in bash implementation", async () => {
    const { agent, session, sessions, runCalls, manager } = await setup({
      enableEnvSim: true,
      persona: "claude-code",
      script: [[{ id: "call-1", name: "Bash", input: { cmd: "echo hi" } }]],
    });
    try {
      await agent.run(session.id, "跑个命令");
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0]).toMatchObject({ cmd: "echo hi" });
      const results = toolResults(await sessions.get(session.id));
      expect(results[0]).toMatchObject({ toolCallId: "call-1", isError: false });
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("keeps the original permission class for aliased tools", async () => {
    const seen: AppEvent[] = [];
    const { agent, session, events, manager } = await setup({
      enableEnvSim: true,
      persona: "claude-code",
      script: [[{ id: "call-1", name: "Edit", input: { path: "a.txt", oldText: "a", newText: "b" } }]],
    });
    events.on("event", (event) => { if (event.type === "tool.scheduling") seen.push(event); });
    try {
      await agent.run(session.id, "改个文件");
      const scheduling = seen.find((event) => (event.payload as { toolCallId?: string }).toolCallId === "call-1");
      // 别名 Edit 保留 edit_file 的 workspace_write 分级，不降级为 external
      expect(scheduling?.payload).toMatchObject({ name: "edit_file", execution: "workspace_write" });
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("blocks aliased write tools in plan mode exactly like the originals", async () => {
    const { agent, session, sessions, manager } = await setup({
      enableEnvSim: true,
      persona: "claude-code",
      agentMode: "plan",
      script: [[{ id: "call-1", name: "Edit", input: { path: "a.txt", oldText: "a", newText: "b" } }]],
    });
    try {
      await agent.run(session.id, "改个文件");
      const results = toolResults(await sessions.get(session.id));
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.content).toContain("Plan 模式为只读");
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("rejects calls to hidden built-ins as unavailable", async () => {
    const { agent, session, sessions, manager } = await setup({
      enableEnvSim: true,
      persona: "claude-code",
      script: [[{ id: "call-1", name: "read_artifact", input: { artifactId: "a", offset: 0, limit: 10 } }]],
    });
    try {
      await agent.run(session.id, "读 artifact");
      const results = toolResults(await sessions.get(session.id));
      expect(results[0]).toMatchObject({ toolCallId: "call-1", isError: true });
      expect(results[0]?.content).toContain("Tool is not available in this turn");
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("skips aliases with an unknown from with a warning", async () => {
    const warnings: string[] = [];
    const harness = await setup({
      enableEnvSim: true,
      persona: "custom-sim",
      presetFiles: [{
        filename: "custom-sim.json",
        content: JSON.stringify({
          id: "custom-sim",
          name: "Custom Sim",
          identity: "You are Custom Sim.",
          basePrompt: "custom base body",
          productSections: [],
          hideBuiltIns: [],
          aliases: [{ from: "no_such_tool", as: "Nope" }, { from: "bash", as: "Terminal" }],
        }),
      }],
    });
    harness.events.on("event", (event) => {
      if (event.type === "extension.warning") warnings.push((event.payload as { message: string }).message);
    });
    try {
      await harness.agent.run(harness.session.id, "你好");
      const names = (harness.requests[0]!.tools ?? []).map((tool) => tool.name);
      expect(names).toContain("Terminal");
      expect(names).not.toContain("Nope");
      expect(warnings.some((message) => message.includes("no_such_tool"))).toBe(true);
    } finally {
      await harness.manager.close();
    }
  }, 20_000);

  it("translates persona-shaped arguments back to built-in parameters (argMap)", async () => {
    const { agent, session, sessions, requests, runCalls, manager } = await setup({
      enableEnvSim: true,
      persona: "claude-code",
      script: [[
        { id: "call-1", name: "Bash", input: { command: "echo hi", description: "greet" } },
        { id: "call-2", name: "Edit", input: { file_path: "a.txt", old_string: "a", new_string: "b", replace_all: true } },
      ]],
    });
    try {
      await agent.run(session.id, "跑命令再改文件");
      // cc 形态 schema 出现在 provider 请求中
      const bashTool = (requests[0]!.tools ?? []).find((tool) => tool.name === "Bash");
      expect(bashTool?.inputSchema).toMatchObject({ required: ["command"] });
      // command -> cmd 归一后进入 core
      expect(runCalls[0]).toMatchObject({ cmd: "echo hi" });
      const results = toolResults(await sessions.get(session.id));
      // file_path/old_string/new_string/replace_all 归一为内置 edit_file 参数后执行成功
      expect(results.find((item) => item.toolCallId === "call-2")).toMatchObject({ isError: false });
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("rejects third-party manifests carrying toolShaping", async () => {
    const { manager, root } = await setup();
    try {
      const source = path.join(root, "malicious-src");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "manifest.json"), JSON.stringify({
        id: "masquerade",
        name: "Masquerade",
        version: "1.0.0",
        description: "tries to alias built-ins",
        apiVersion: "1",
        permissions: [],
        entry: "index.js",
        toolShaping: { aliases: [{ from: "bash", as: "Bash" }] },
      }), "utf8");
      await writeFile(path.join(source, "index.js"), "export function activate() {}\n", "utf8");
      await expect(manager.install(source)).rejects.toThrow(/toolShaping/);
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("env-sim preset store", () => {
  it("lists built-ins first, then valid user presets; resolvePersona prefers built-ins", async () => {
    const root = await tempRoot();
    await mkdir(personasDir(root), { recursive: true });
    await writeFile(path.join(personasDir(root), "mine.json"), JSON.stringify({
      id: "mine",
      name: "Mine",
      identity: "You are Mine.",
      basePrompt: "mine base",
      productSections: ["## Extra"],
      hideBuiltIns: ["remember"],
      aliases: [{ from: "bash", as: "Shell" }],
    }), "utf8");
    const personas = await listPersonas(root);
    expect(personas.filter((item) => item.builtin).map((item) => item.id)).toEqual(["claude-code", "kimi-code", "zcode", "codex"]);
    expect(personas.find((item) => item.id === "mine")).toMatchObject({ name: "Mine", builtin: false });
    expect((await resolvePersona(root, { persona: "claude-code" }))?.name).toBe("Claude Code");
    expect((await resolvePersona(root, { persona: "mine" }))?.identity).toBe("You are Mine.");
    expect(await resolvePersona(root, { persona: "" })).toBeNull();
    expect(await resolvePersona(root, {})).toBeNull();
    expect(await resolvePersona(root, { persona: "missing" })).toBeNull();
  });

  it("skips invalid JSON, bad shapes and built-in id collisions without crashing", async () => {
    const root = await tempRoot();
    await mkdir(personasDir(root), { recursive: true });
    await writeFile(path.join(personasDir(root), "broken.json"), "{ not json", "utf8");
    await writeFile(path.join(personasDir(root), "shape.json"), JSON.stringify({ id: "shape", name: 42 }), "utf8");
    await writeFile(path.join(personasDir(root), "claude-code.json"), JSON.stringify({
      id: "claude-code", name: "Impostor", identity: "x", basePrompt: "y",
    }), "utf8");
    const warnings: string[] = [];
    const presets = await loadUserPresets(root, (message) => warnings.push(message));
    expect(presets).toHaveLength(0);
    expect(warnings).toHaveLength(3);
    // 内置预设不受用户目录干扰
    expect((await resolvePersona(root, { persona: "claude-code" }))?.name).toBe("Claude Code");
    expect((await listPersonas(root)).filter((item) => item.id === "claude-code")).toHaveLength(1);
  });

  it("keeps alias inputSchema/argMap when loading user presets", async () => {
    const root = await tempRoot();
    await mkdir(personasDir(root), { recursive: true });
    await writeFile(path.join(personasDir(root), "shaped.json"), JSON.stringify({
      id: "shaped",
      name: "Shaped",
      identity: "You are Shaped.",
      basePrompt: "shaped base",
      aliases: [{
        from: "bash",
        as: "Terminal",
        inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        argMap: { command: "cmd" },
      }],
    }), "utf8");
    const preset = (await loadUserPresets(root)).find((item) => item.id === "shaped");
    expect(preset?.aliases[0]).toMatchObject({
      from: "bash",
      as: "Terminal",
      inputSchema: { required: ["command"] },
      argMap: { command: "cmd" },
    });
  });
});

describe("env-sim REST contract", () => {
  async function setupRest(presetFiles?: Array<{ filename: string; content: string }>) {
    const harness = await setup({ presetFiles });
    // PUT /sessions/:id/config 会按注册表校验会话 provider/model，需与 harness 同源注册
    const providers = new ProviderRegistry();
    providers.register(scriptProvider([], []));
    const app = await buildServer({
      core: fakeCore([]),
      sessions: harness.sessions,
      agent: harness.agent,
      events: harness.events,
      providers,
      pricing: new PricingCatalog(path.join(harness.root, "pricing2.json")),
      extensions: harness.manager,
    });
    return { ...harness, app };
  }

  it("validates config against the manifest configSchema", async () => {
    const { app, manager } = await setupRest();
    try {
      const wrongType = await app.inject({ method: "POST", url: "/api/extensions", payload: { id: "env-sim", config: { persona: 123 } } });
      expect(wrongType.statusCode).toBe(400);
      const unknownKey = await app.inject({ method: "POST", url: "/api/extensions", payload: { id: "env-sim", config: { nope: "x" } } });
      expect(unknownKey.statusCode).toBe(400);
      expect((unknownKey.json() as { error: string }).error).toContain("nope");
      const valid = await app.inject({ method: "POST", url: "/api/extensions", payload: { id: "env-sim", enabled: true, config: { persona: "codex" } } });
      expect(valid.statusCode).toBe(200);
      expect((valid.json() as { config: Record<string, unknown> }).config).toMatchObject({ persona: "codex" });
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);

  it("exposes configSchema and availablePersonas on ExtensionInfo", async () => {
    const { app, manager } = await setupRest();
    try {
      const response = await app.inject({ method: "GET", url: "/api/extensions" });
      expect(response.statusCode).toBe(200);
      const envSim = (response.json() as Array<Record<string, unknown>>).find((item) => item.id === "env-sim");
      expect(envSim).toBeDefined();
      expect(envSim).toMatchObject({ official: true, defaultEnabled: false, enabled: false });
      expect(envSim?.configSchema).toMatchObject({ type: "object", additionalProperties: false });
      const personas = envSim?.availablePersonas as Array<{ id: string; builtin: boolean }>;
      expect(personas.map((item) => item.id)).toEqual(["claude-code", "kimi-code", "zcode", "codex"]);
      expect(personas.every((item) => item.builtin)).toBe(true);
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);

  it("serves the personas endpoint with built-ins, user presets and the drop directory", async () => {
    const { app, manager, dataDir } = await setupRest([{
      filename: "shared.json",
      content: JSON.stringify({ id: "shared", name: "Shared Preset", identity: "You are Shared.", basePrompt: "shared base" }),
    }]);
    try {
      const response = await app.inject({ method: "GET", url: "/api/extensions/env-sim/personas" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { personas: Array<{ id: string; builtin: boolean }>; directory: string };
      expect(body.personas.map((item) => item.id)).toEqual(["claude-code", "kimi-code", "zcode", "codex", "shared"]);
      expect(body.personas.at(-1)).toMatchObject({ id: "shared", builtin: false });
      expect(path.isAbsolute(body.directory)).toBe(true);
      expect(body.directory).toBe(personasDir(dataDir));
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);

  it("serves full persona details for preview and 404s unknown ids", async () => {
    const { app, manager } = await setupRest();
    try {
      const detail = await app.inject({ method: "GET", url: "/api/extensions/env-sim/personas/claude-code" });
      expect(detail.statusCode).toBe(200);
      const body = detail.json() as Record<string, unknown>;
      expect(body).toMatchObject({ id: "claude-code", name: "Claude Code", builtin: true });
      expect(typeof body.identity).toBe("string");
      expect(typeof body.basePrompt).toBe("string");
      const aliases = body.aliases as Array<Record<string, unknown>>;
      const read = aliases.find((alias) => alias.as === "Read");
      // 详情含拟态参数形态（供 UI 预览与外部消费）
      expect(read).toMatchObject({ from: "read_file", argMap: { file_path: "path" } });
      expect(read?.inputSchema).toMatchObject({ required: ["file_path"] });
      const missing = await app.inject({ method: "GET", url: "/api/extensions/env-sim/personas/nope" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);

  it("validates and persists session-level persona via PUT config, exposing activePersona on detail", async () => {
    const { app, manager, sessions, session } = await setupRest();
    try {
      await manager.configure("env-sim", { enabled: true, config: { persona: "codex" } });
      const unknown = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { persona: "no-such-persona" } });
      expect(unknown.statusCode).toBe(400);
      const invalidType = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { persona: 42 } });
      expect(invalidType.statusCode).toBe(400);
      const set = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { persona: "kimi-code" } });
      expect(set.statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ persona: "kimi-code" });
      // 会话详情暴露当前生效 persona（会话级覆盖优先于扩展全局 codex）
      const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ persona: "kimi-code", activePersona: { id: "kimi-code", name: "Kimi Code", builtin: true } });
      // 空串清除会话级覆盖，回落到扩展全局配置
      const cleared = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { persona: "" } });
      expect(cleared.statusCode).toBe(200);
      expect(await sessions.get(session.id)).not.toHaveProperty("persona");
      const fallback = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      expect(fallback.json()).toMatchObject({ activePersona: { id: "codex" } });
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);
});
