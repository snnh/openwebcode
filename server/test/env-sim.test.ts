import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { BUILTIN_PERSONAS, listPersonas, resolvePersona } from "../src/extensions/env-sim/index.js";
import { deleteUserPreset, loadUserPresets, personasDir, saveUserPreset } from "../src/extensions/env-sim/preset-store.js";
import { ContextManager } from "../src/context/context-manager.js";
import { updateEvictionPolicy } from "../src/extensions/context-saver/index.js";
import { Compactor } from "../src/context/compactor.js";
import { getOfficialUserAgent, getUserAgent, setSimulatedUserAgent } from "../src/user-agent.js";
import { getServerVersion } from "../src/version.js";
import { makeFakeFastModel } from "./helpers/fake-fast-model.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot as tempRootHelper } from "./helpers/temp-roots.js";

const tempRoot = (): Promise<string> => tempRootHelper("owc-envsim-");

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

function fakeCore(runCalls: Array<Record<string, unknown>>, editCalls: Array<Record<string, unknown>> = []): CoreClientLike {
  return makeFakeCore({
    async readFile() { return { content: "file content", totalLines: 1, encoding: "utf-8" as const, truncated: false }; },
    async run(request) { runCalls.push({ ...request }); return { exitCode: 0, durationMs: 0, truncated: false }; },
    async editFile(request) { editCalls.push({ ...request }); return { matches: 1 }; },
  });
}

/** 写一份用户预设文件（自动建目录；对象自动序列化）。 */
async function writePreset(root: string, filename: string, content: string | Record<string, unknown>): Promise<void> {
  await mkdir(personasDir(root), { recursive: true });
  await writeFile(path.join(personasDir(root), filename), typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

interface HarnessOptions {
  enableEnvSim?: boolean;
  persona?: string;
  agentMode?: "plan" | "code";
  fileBaseOverride?: string;
  presetFiles?: Array<{ filename: string; content: string | Record<string, unknown> }>;
  script?: ToolCallSpec[][];
}

async function setup(options: HarnessOptions = {}) {
  const root = await tempRoot();
  const dataDir = path.join(root, "data");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
  // yolo 直达 fake core；manual 避免无关的 GitShadow 检查点
  await sessions.updateConfig(session.id, { provider: "fake", model: "model", agentMode: options.agentMode ?? "code", snapshotMode: "manual" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  if (options.fileBaseOverride !== undefined) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "system-prompt.md"), options.fileBaseOverride, "utf8");
  }
  for (const preset of options.presetFiles ?? []) {
    await writePreset(dataDir, preset.filename, preset.content);
  }
  const requests: StreamChatRequest[] = [];
  const providers = new ProviderRegistry();
  providers.register(scriptProvider(requests, options.script ?? []));
  const runCalls: Array<Record<string, unknown>> = [];
  const editCalls: Array<Record<string, unknown>> = [];
  const core = fakeCore(runCalls, editCalls);
  const manager = new ExtensionManager(dataDir, events, { sessions });
  await manager.initialize();
  if (options.enableEnvSim) await manager.configure("env-sim", { enabled: true, config: { persona: options.persona ?? "" } });
  const agent = new AgentRunner(
    sessions, providers, core, events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined,
    dataDir, undefined, undefined, undefined, undefined, undefined, undefined, manager,
  );
  return { root, dataDir, sessions, session, events, requests, runCalls, editCalls, manager, agent };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** setup + 自动关闭 manager，消除各用例重复的 try/finally 样板。 */
async function withHarness<T>(options: HarnessOptions, fn: (harness: Harness) => T | Promise<T>): Promise<T> {
  const harness = await setup(options);
  try {
    return await fn(harness);
  } finally {
    await harness.manager.close();
  }
}

function toolResults(detail: { messages: Array<{ role: string; content: Array<{ type: string }> }> } | null) {
  return (detail?.messages ?? [])
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .filter((block): block is { type: "tool_result"; toolCallId: string; content: string; isError?: boolean } => block.type === "tool_result");
}

/** setup + 装配 buildServer（REST 与 /init、/compact 命令用例共用；注入 compactor/dataDir 供命令用例）。 */
async function setupApp(options: HarnessOptions = {}) {
  const harness = await setup(options);
  // buildServer 的 providers 仅用于 REST 校验；agent 实际走 harness 内部注册表（harness.requests 记录请求）
  const providers = new ProviderRegistry();
  providers.register(scriptProvider([], []));
  const fastModelCalls: Array<{ system: string; prompt: string }> = [];
  const compactor = new Compactor(harness.sessions, makeFakeFastModel("- [工具] bash → 完成", fastModelCalls), {}, 3);
  const app = await buildServer({
    core: fakeCore([]),
    sessions: harness.sessions,
    agent: harness.agent,
    events: harness.events,
    providers,
    pricing: new PricingCatalog(path.join(harness.root, "pricing2.json")),
    extensions: harness.manager,
    compactor,
    dataDir: harness.dataDir,
  });
  return { ...harness, app, fastModelCalls };
}

type AppHarness = Awaited<ReturnType<typeof setupApp>>;

/** setupApp + 自动关闭 app/manager。 */
async function withApp<T>(options: HarnessOptions, fn: (harness: AppHarness) => T | Promise<T>): Promise<T> {
  const harness = await setupApp(options);
  try {
    return await fn(harness);
  } finally {
    await harness.app.close();
    await harness.manager.close();
  }
}

describe("env-sim prompt.beforeBuild", () => {
  it("applies the persona identity and base prompt while keeping the core safety boundary", async () => {
    await withHarness({ enableEnvSim: true, persona: "claude-code" }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "你好");
      const system = requests[0]!.system;
      expect(system).toContain("You are Claude Code, Anthropic's agentic coding tool.");
      expect(system).not.toContain("You are OpenWebCode. The workspace");
      // 核心安全网不可被钩子移除
      expect(system).toContain("## Safety boundary");
      expect(system).toContain("Prompt version:");
    });
  }, 20_000);

  it("lets a user file override a built-in persona end to end (identity + inherited tool shapes)", async () => {
    // 用户目录同 id 覆盖内置：identity/basePrompt 用覆盖版，工具形态（Bash 别名）字段级继承内置
    await withHarness({
      enableEnvSim: true,
      persona: "claude-code",
      presetFiles: [{
        filename: "claude-code.json",
        content: { id: "claude-code", name: "Claude Code (Custom)", identity: "You are MY Claude Code.", basePrompt: "my custom base" },
      }],
    }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "你好");
      const system = requests[0]!.system;
      expect(system).toContain("You are MY Claude Code.");
      expect(system).toContain("my custom base");
      expect(system).not.toContain("Anthropic's agentic coding tool");
      // 覆盖文件未提供 aliases：内置的 Bash/Edit 别名保留
      const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
      expect(names).toContain("Bash");
      expect(names).toContain("Edit");
    });
  }, 20_000);

  it("restores the default prompt when persona is empty or the extension is disabled", async () => {
    // 空 persona（启用扩展）与完全未启用扩展都应回落默认提示词
    const cases: HarnessOptions[] = [{ enableEnvSim: true, persona: "" }, {}];
    for (const options of cases) {
      await withHarness(options, async ({ agent, session, requests }) => {
        await agent.run(session.id, "你好");
        expect(requests[0]!.system).toContain("You are OpenWebCode. The workspace");
      });
    }
  }, 30_000);

  it("composes with the file-based override: persona base wins only when it sets one", async () => {
    await withHarness({ enableEnvSim: true, persona: "", fileBaseOverride: "FILE BASE BODY\n" }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "你好");
      expect(requests[0]!.system).toContain("FILE BASE BODY");
    });
    await withHarness({ enableEnvSim: true, persona: "zcode", fileBaseOverride: "FILE BASE BODY\n" }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "你好");
      const system = requests[0]!.system;
      expect(system).toContain("You are an interactive ZCode agent that helps users with software engineering tasks.");
      expect(system).not.toContain("FILE BASE BODY");
      expect(system).toContain("## Safety boundary");
    });
  }, 30_000);

  it("session-level persona overrides the extension-wide config", async () => {
    await withHarness({ enableEnvSim: true, persona: "codex" }, async ({ agent, session, sessions, requests }) => {
      await sessions.updateConfig(session.id, { provider: "fake", model: "model", persona: "claude-code" });
      await agent.run(session.id, "你好");
      const system = requests[0]!.system;
      expect(system).toContain("You are Claude Code, Anthropic's agentic coding tool.");
      const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
      // 工具形态也跟随会话级 persona（cc 形态而非 codex 形态）
      expect(names).toContain("TodoWrite");
      expect(names).not.toContain("apply_patch");
    });
  }, 20_000);
});

describe("env-sim tool shaping", () => {
  it("renames aliased built-ins and hides OWC-specific tools in the provider request", async () => {
    await withHarness({ enableEnvSim: true, persona: "claude-code" }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "你好");
      const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
      for (const expected of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite", "Task"]) expect(names).toContain(expected);
      // read_artifact 的可见性由驱逐联动决定（默认驱逐开启时强制放行），不在此断言
      for (const hidden of ["bash", "read_file", "write_file", "edit_file", "glob", "grep", "spawn_swarm", "remember"]) expect(names).not.toContain(hidden);
    });
  }, 20_000);

  it("blocks aliased write tools in plan mode exactly like the originals", async () => {
    await withHarness({
      enableEnvSim: true,
      persona: "claude-code",
      agentMode: "plan",
      script: [[{ id: "call-1", name: "Edit", input: { path: "a.txt", oldText: "a", newText: "b" } }]],
    }, async ({ agent, session, sessions }) => {
      await agent.run(session.id, "改个文件");
      const results = toolResults(await sessions.get(session.id));
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.content).toContain("Plan 模式为只读");
    });
  }, 20_000);

  it("rejects calls to hidden built-ins as unavailable", async () => {
    await withHarness({
      enableEnvSim: true,
      persona: "claude-code",
      script: [[{ id: "call-1", name: "spawn_swarm", input: { mode: "demo" } }]],
    }, async ({ agent, session, sessions }) => {
      await agent.run(session.id, "发起协同");
      const results = toolResults(await sessions.get(session.id));
      expect(results[0]).toMatchObject({ toolCallId: "call-1", isError: true });
      expect(results[0]?.content).toContain("Tool is not available in this turn");
    });
  }, 20_000);

  it("dsh-minimal injects only bash and str_replace_editor on the first turn", async () => {
    await withHarness({ enableEnvSim: true, persona: "dsh-minimal" }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "你好");
      const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
      // 首轮严格双工具形态：bash + str_replace_editor；保留工具（todo_write）与
      // read_artifact 均不注入
      expect(names).toContain("bash");
      expect(names).toContain("str_replace_editor");
      expect(names).not.toContain("read_artifact");
      expect(names).not.toContain("todo_write");
      expect(names).not.toContain("read_file");
      // 首轮极简提示词：只保留 persona 基础提示词（identity + basePrompt）与工具表渲染；
      // 项目上下文、安全边界、尾注（版本/日期/工作目录）一律跳过
      const system = requests[0]!.system;
      expect(system).toContain("You are a helpful software engineer assistant.");
      expect(system).toContain("Available tools:");
      expect(system).not.toContain("## Safety boundary");
      expect(system).not.toContain("Prompt version:");
      expect(system).not.toContain("Current working directory:");
      expect(system).not.toContain("<project_context>");
      // repo map 内容段跟随 repo_map 工具隐藏：systemSuffix 不注入 Repository map
      expect(requests[0]!.systemSuffix ?? "").not.toContain("Repository map");
    });
  }, 20_000);

  it("dsh-minimal keeps the dual-tool shape across tool-loop turns within the first user message", async () => {
    await withHarness({
      enableEnvSim: true,
      persona: "dsh-minimal",
      script: [
        [{ id: "bash-1", name: "bash", input: { command: "echo hi" } }],
        [],
      ],
    }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "用 bash 看看");
      // 两次模型调用（工具循环两轮）都在第一条用户消息内：工具列表保持双工具形态
      expect(requests.length).toBe(2);
      for (const request of requests) {
        const names = (request.tools ?? []).map((tool) => tool.name);
        expect(names).toContain("bash");
        expect(names).toContain("str_replace_editor");
        expect(names).not.toContain("todo_write");
        expect(names).not.toContain("read_artifact");
        // 同一用户消息内的工具循环同样保持极简提示词（首轮形态不提前结束）
        expect(request.system).toContain("Available tools:");
        expect(request.system).not.toContain("## Safety boundary");
        expect(request.system).not.toContain("Prompt version:");
        expect(request.systemSuffix ?? "").not.toContain("Repository map");
      }
    });
  }, 20_000);

  it("dsh-minimal injects retained tools and read_artifact from the second turn (eviction on by default)", async () => {
    await withHarness({ enableEnvSim: true, persona: "dsh-minimal" }, async ({ agent, session, requests }) => {
      await agent.run(session.id, "第一轮");
      await agent.run(session.id, "第二轮");
      const names = (requests[1]!.tools ?? []).map((tool) => tool.name);
      // 次轮恢复保留形态：read_artifact 由驱逐联动强制放行（默认策略 enabled），
      // 仅注入 web 工具与子代理（spawn_task）；待办/提问/技能等已隐藏
      expect(names).toContain("bash");
      expect(names).toContain("str_replace_editor");
      expect(names).toContain("read_artifact");
      expect(names).toContain("spawn_task");
      // 仍保持隐藏的工具
      expect(names).not.toContain("read_file");
      expect(names).not.toContain("git_commit");
      expect(names).not.toContain("todo_write");
      expect(names).not.toContain("ask_user");
      expect(names).not.toContain("load_skill");
      // 第二轮恢复完整提示词：安全边界、项目上下文、尾注重新注入（首轮极简形态结束）
      const system = requests[1]!.system;
      expect(system).toContain("## Safety boundary");
      expect(system).toContain("Prompt version:");
      expect(system).toContain("Current working directory:");
      // repo_map 仍被 hideBuiltIns 永久隐藏：内容段持续不注入
      expect(requests[1]!.systemSuffix ?? "").not.toContain("Repository map");
    });
  }, 20_000);

  it("dsh-minimal keeps read_artifact hidden when auto-eviction is disabled", async () => {
    await withHarness({ enableEnvSim: true, persona: "dsh-minimal" }, async ({ agent, session, sessions, requests }) => {
      await updateEvictionPolicy(new ContextManager(sessions.contextRoot(session.id)), { enabled: false });
      await agent.run(session.id, "第一轮");
      await agent.run(session.id, "第二轮");
      const names = (requests[1]!.tools ?? []).map((tool) => tool.name);
      expect(names).not.toContain("read_artifact");
    });
  }, 20_000);

  it("skips aliases with an unknown from with a warning", async () => {
    const warnings: string[] = [];
    await withHarness({
      enableEnvSim: true,
      persona: "custom-sim",
      presetFiles: [{
        filename: "custom-sim.json",
        content: {
          id: "custom-sim",
          name: "Custom Sim",
          identity: "You are Custom Sim.",
          basePrompt: "custom base body",
          productSections: [],
          hideBuiltIns: [],
          aliases: [{ from: "no_such_tool", as: "Nope" }, { from: "bash", as: "Terminal" }],
        },
      }],
    }, async ({ agent, session, events, requests }) => {
      events.on("event", (event) => {
        if (event.type === "extension.warning") warnings.push((event.payload as { message: string }).message);
      });
      await agent.run(session.id, "你好");
      const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
      expect(names).toContain("Terminal");
      expect(names).not.toContain("Nope");
      expect(warnings.some((message) => message.includes("no_such_tool"))).toBe(true);
    });
  }, 20_000);

  it("translates persona-shaped arguments back to built-in parameters (argMap)", async () => {
    await withHarness({
      enableEnvSim: true,
      persona: "claude-code",
      script: [[
        { id: "call-1", name: "Bash", input: { command: "echo hi", description: "greet" } },
        { id: "call-2", name: "Edit", input: { file_path: "a.txt", old_string: "a", new_string: "b", replace_all: true } },
      ]],
    }, async ({ agent, session, sessions, requests, runCalls }) => {
      await agent.run(session.id, "跑命令再改文件");
      // cc 形态 schema 出现在 provider 请求中
      const bashTool = (requests[0]!.tools ?? []).find((tool) => tool.name === "Bash");
      expect(bashTool?.inputSchema).toMatchObject({ required: ["command"] });
      // command -> cmd 归一后进入 core（bash 一次性路径会前置会话环境变量 export）
      expect(runCalls[0]?.cmd).toContain("OWC_SESSION_ID");
      expect(runCalls[0]?.cmd).toContain("echo hi");
      const results = toolResults(await sessions.get(session.id));
      // file_path/old_string/new_string/replace_all 归一为内置 edit_file 参数后执行成功
      expect(results.find((item) => item.toolCallId === "call-2")).toMatchObject({ isError: false });
    });
  }, 20_000);

  it("rejects third-party manifests carrying toolShaping", async () => {
    await withHarness({}, async ({ manager, root }) => {
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
    });
  }, 20_000);
});

describe("env-sim preset store", () => {
  it("lists built-ins first, then valid user presets; resolvePersona prefers built-ins", async () => {
    const root = await tempRoot();
    await writePreset(root, "mine.json", {
      id: "mine",
      name: "Mine",
      identity: "You are Mine.",
      basePrompt: "mine base",
      productSections: ["## Extra"],
      hideBuiltIns: ["remember"],
      aliases: [{ from: "bash", as: "Shell" }],
    });
    const personas = await listPersonas(root);
    expect(personas.filter((item) => item.builtin).map((item) => item.id)).toEqual(["claude-code", "kimi-code", "zcode", "codex", "dsh-minimal"]);
    expect(personas.find((item) => item.id === "mine")).toMatchObject({ name: "Mine", builtin: false });
    expect((await resolvePersona(root, { persona: "claude-code" }))?.name).toBe("Claude Code");
    expect((await resolvePersona(root, { persona: "mine" }))?.identity).toBe("You are Mine.");
    expect(await resolvePersona(root, { persona: "" })).toBeNull();
    expect(await resolvePersona(root, {})).toBeNull();
    expect(await resolvePersona(root, { persona: "missing" })).toBeNull();
  });

  it("skips invalid JSON and bad shapes; keeps built-in override files without crashing", async () => {
    const root = await tempRoot();
    await writePreset(root, "broken.json", "{ not json");
    await writePreset(root, "shape.json", { id: "shape", name: 42 });
    // 与内置同 id 的合法文件 = 内置覆盖（不再跳过）：identity/basePrompt 覆盖，其余字段合并继承
    await writePreset(root, "claude-code.json", {
      id: "claude-code", name: "Impostor", identity: "x", basePrompt: "y",
    });
    const warnings: string[] = [];
    const presets = await loadUserPresets(root, (message) => warnings.push(message));
    expect(presets).toHaveLength(1);
    expect(presets[0]?.name).toBe("Impostor");
    expect(warnings).toHaveLength(2);
    // 用户覆盖优先：resolvePersona 返回覆盖版；内置工具形态字段（aliases 等）继承内置
    const resolved = await resolvePersona(root, { persona: "claude-code" });
    expect(resolved?.name).toBe("Impostor");
    expect(resolved?.aliases.some((alias) => alias.as === "Bash")).toBe(true);
    // 清单：内置项合并为单项并标记 overridden
    const list = (await listPersonas(root)).filter((item) => item.id === "claude-code");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ builtin: true, overridden: true });
  });

  it("keeps alias inputSchema/argMap when loading user presets", async () => {
    const root = await tempRoot();
    await writePreset(root, "shaped.json", {
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
    });
    const preset = (await loadUserPresets(root)).find((item) => item.id === "shaped");
    expect(preset?.aliases[0]).toMatchObject({
      from: "bash",
      as: "Terminal",
      inputSchema: { required: ["command"] },
      argMap: { command: "cmd" },
    });
  });

  it("parses the optional command-prompt fields of user presets", async () => {
    const root = await tempRoot();
    await writePreset(root, "prompted.json", {
      id: "prompted",
      name: "Prompted",
      identity: "You are Prompted.",
      basePrompt: "prompted base",
      initPrompt: "custom init prompt",
      compactOverviewPrompt: "custom overview",
      compactToolcallsPrompt: "custom toolcalls",
    });
    const preset = (await loadUserPresets(root)).find((item) => item.id === "prompted");
    expect(preset).toMatchObject({
      initPrompt: "custom init prompt",
      compactOverviewPrompt: "custom overview",
      compactToolcallsPrompt: "custom toolcalls",
    });
  });

  it("saveUserPreset/deleteUserPreset round-trip with validation", async () => {
    const root = await tempRoot();
    const saved = await saveUserPreset(root, {
      id: "mine",
      name: "Mine",
      identity: "You are Mine.",
      basePrompt: "mine base",
      aliases: [{ from: "bash", as: "Shell" }],
    });
    expect(saved.id).toBe("mine");
    expect((await listPersonas(root)).some((item) => item.id === "mine" && !item.builtin)).toBe(true);
    // 同 id 覆盖即编辑
    await saveUserPreset(root, { id: "mine", name: "Mine v2", identity: "You are Mine.", basePrompt: "v2 base" });
    expect((await loadUserPresets(root)).find((item) => item.id === "mine")?.name).toBe("Mine v2");

    // 内置 id 保存 = 自定义内置：写入覆盖文件，解析侧生效
    const override = await saveUserPreset(root, { id: "claude-code", name: "Impostor", identity: "x", basePrompt: "y" });
    expect(override.id).toBe("claude-code");
    expect((await resolvePersona(root, { persona: "claude-code" }))?.name).toBe("Impostor");
    expect((await listPersonas(root)).find((item) => item.id === "claude-code")).toMatchObject({ builtin: true, overridden: true });
    await expect(saveUserPreset(root, { id: "Bad Id", name: "Bad", identity: "x", basePrompt: "y" })).rejects.toThrow(/invalid preset id/);
    await expect(saveUserPreset(root, { id: "no-name", identity: "x", basePrompt: "y" })).rejects.toThrow(/invalid preset shape/);

    // 内置 id 删除 = 还原内置（删覆盖文件）；无覆盖文件返回 false
    expect(await deleteUserPreset(root, "claude-code")).toBe(true);
    expect((await resolvePersona(root, { persona: "claude-code" }))?.name).toBe("Claude Code");
    expect((await listPersonas(root)).find((item) => item.id === "claude-code")?.overridden).toBeUndefined();
    expect(await deleteUserPreset(root, "claude-code")).toBe(false);
    expect(await deleteUserPreset(root, "missing")).toBe(false);
    expect(await deleteUserPreset(root, "mine")).toBe(true);
    expect((await listPersonas(root)).some((item) => item.id === "mine")).toBe(false);
  });
});

describe("env-sim REST contract", () => {
  it("validates config against the manifest configSchema", async () => {
    await withApp({}, async ({ app }) => {
      const wrongType = await app.inject({ method: "POST", url: "/api/extensions", payload: { id: "env-sim", config: { persona: 123 } } });
      expect(wrongType.statusCode).toBe(400);
      const unknownKey = await app.inject({ method: "POST", url: "/api/extensions", payload: { id: "env-sim", config: { nope: "x" } } });
      expect(unknownKey.statusCode).toBe(400);
      expect((unknownKey.json() as { error: string }).error).toContain("nope");
      const valid = await app.inject({ method: "POST", url: "/api/extensions", payload: { id: "env-sim", enabled: true, config: { persona: "codex" } } });
      expect(valid.statusCode).toBe(200);
      expect((valid.json() as { config: Record<string, unknown> }).config).toMatchObject({ persona: "codex" });
    });
  }, 20_000);

  it("exposes configSchema and availablePersonas on ExtensionInfo", async () => {
    await withApp({}, async ({ app }) => {
      const response = await app.inject({ method: "GET", url: "/api/extensions" });
      expect(response.statusCode).toBe(200);
      const envSim = (response.json() as Array<Record<string, unknown>>).find((item) => item.id === "env-sim");
      expect(envSim).toBeDefined();
      expect(envSim).toMatchObject({ official: true, defaultEnabled: false, enabled: false });
      expect(envSim?.configSchema).toMatchObject({ type: "object", additionalProperties: false });
      const personas = envSim?.availablePersonas as Array<{ id: string; builtin: boolean }>;
      expect(personas.map((item) => item.id)).toEqual(["claude-code", "kimi-code", "zcode", "codex", "dsh-minimal"]);
      expect(personas.every((item) => item.builtin)).toBe(true);
    });
  }, 20_000);

  it("serves the personas endpoint with built-ins, user presets and the drop directory", async () => {
    await withApp({
      presetFiles: [{
        filename: "shared.json",
        content: { id: "shared", name: "Shared Preset", identity: "You are Shared.", basePrompt: "shared base" },
      }],
    }, async ({ app, dataDir }) => {
      const response = await app.inject({ method: "GET", url: "/api/extensions/env-sim/personas" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { personas: Array<{ id: string; builtin: boolean }>; directory: string };
      expect(body.personas.map((item) => item.id)).toEqual(["claude-code", "kimi-code", "zcode", "codex", "dsh-minimal", "shared"]);
      expect(body.personas.at(-1)).toMatchObject({ id: "shared", builtin: false });
      expect(path.isAbsolute(body.directory)).toBe(true);
      expect(body.directory).toBe(personasDir(dataDir));
    });
  }, 20_000);

  it("serves full persona details for preview and 404s unknown ids", async () => {
    await withApp({}, async ({ app }) => {
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
    });
  }, 20_000);

  it("validates and persists session-level persona via PUT config, exposing activePersona on detail", async () => {
    await withApp({}, async ({ app, manager, sessions, session }) => {
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
    });
  }, 20_000);
});

describe("env-sim command prompt shaping", () => {

  it("/init expands to the persona init prompt; user override wins over persona", async () => {
    const cc = BUILTIN_PERSONAS.find((item) => item.id === "claude-code")!;
    await withApp({ enableEnvSim: true, persona: "claude-code" }, async ({ app, agent, session, requests, dataDir }) => {
      const first = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/init" } });
      expect(first.statusCode, first.body).toBe(202);
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 5_000 });
      // provider 收到请求 ≠ run 收尾完成；不等 isRunning 落空就发第二次 /init 会撞 409（Windows CI 高负载抖动）
      await vi.waitFor(() => expect(agent.isRunning(session.id)).toBe(false), { timeout: 15_000 });
      const seen = (): string[] => requests.map((request) => {
        const last = request.messages.at(-1);
        const text = last?.content.find((block) => block.type === "text");
        return text?.type === "text" ? text.text : "";
      });
      expect(seen()).toContain(cc.initPrompt);

      // 用户覆盖（prompt-overrides 面）优先于 persona
      await writeFile(path.join(dataDir, "command-init-prompt.md"), "用户自定义 init 提示词\n", "utf8");
      const second = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/init" } });
      expect(second.statusCode, second.body).toBe(202);
      await vi.waitFor(() => expect(seen()).toContain("用户自定义 init 提示词"), { timeout: 5_000 });
    });
  }, 20_000);

  it("/compact uses the persona compact prompt; user override wins over persona", async () => {
    const cc = BUILTIN_PERSONAS.find((item) => item.id === "claude-code")!;
    await withApp({ enableEnvSim: true, persona: "claude-code" }, async ({ app, session, sessions, fastModelCalls, dataDir }) => {
      for (let index = 0; index < 5; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `消息 ${index + 1}` }]);
      }
      const first = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/compact`, payload: { mode: "toolcalls" } });
      expect(first.statusCode, first.body).toBe(200);
      expect(fastModelCalls[0]?.system).toBe(cc.compactToolcallsPrompt);

      // 用户覆盖（prompt-overrides 面）优先于 persona
      await writeFile(path.join(dataDir, "compact-prompt-toolcalls.md"), "用户自定义工具压缩指令\n", "utf8");
      for (let index = 0; index < 4; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `追加 ${index + 1}` }]);
      }
      const second = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/compact`, payload: { mode: "toolcalls" } });
      expect(second.statusCode, second.body).toBe(200);
      expect(fastModelCalls.at(-1)?.system).toBe("用户自定义工具压缩指令");
    });
  }, 20_000);

  it("creates, lists and deletes user personas over REST", async () => {
    await withApp({}, async ({ app }) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/extensions/env-sim/personas",
        payload: { id: "mine", name: "Mine", identity: "You are Mine.", basePrompt: "mine base", initPrompt: "mine init" },
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({ id: "mine", name: "Mine", builtin: false, initPrompt: "mine init" });

      const list = await app.inject({ method: "GET", url: "/api/extensions/env-sim/personas" });
      expect((list.json() as { personas: Array<{ id: string }> }).personas.map((item) => item.id)).toContain("mine");

      // 内置 id 保存 = 自定义内置（201，overridden 标记）；删除覆盖 = 还原内置
      const override = await app.inject({ method: "POST", url: "/api/extensions/env-sim/personas", payload: { id: "claude-code", name: "Impostor", identity: "x", basePrompt: "y" } });
      expect(override.statusCode).toBe(201);
      expect(override.json()).toMatchObject({ id: "claude-code", builtin: true, overridden: true });
      const overriddenList = await app.inject({ method: "GET", url: "/api/extensions/env-sim/personas" });
      expect((overriddenList.json() as { personas: Array<{ id: string; overridden?: boolean }> }).personas.find((item) => item.id === "claude-code")).toMatchObject({ overridden: true });

      const removeBuiltin = await app.inject({ method: "DELETE", url: "/api/extensions/env-sim/personas/claude-code" });
      expect(removeBuiltin.statusCode).toBe(200);
      // 覆盖已删：再删内置 = 未命中 404（还原后内置本体不可删）
      const removeBuiltinAgain = await app.inject({ method: "DELETE", url: "/api/extensions/env-sim/personas/claude-code" });
      expect(removeBuiltinAgain.statusCode).toBe(404);
      const removeMissing = await app.inject({ method: "DELETE", url: "/api/extensions/env-sim/personas/nope" });
      expect(removeMissing.statusCode).toBe(404);
      const removed = await app.inject({ method: "DELETE", url: "/api/extensions/env-sim/personas/mine" });
      expect(removed.statusCode).toBe(200);
      const after = await app.inject({ method: "GET", url: "/api/extensions/env-sim/personas" });
      expect((after.json() as { personas: Array<{ id: string }> }).personas.map((item) => item.id)).not.toContain("mine");
    });
  }, 20_000);
});

describe("env-sim outbound UA simulation", () => {
  const official = (): string => `owc/openwebcode${getServerVersion()}`;

  afterEach(() => {
    setSimulatedUserAgent(null);
  });

  it("applies the persona UA only when the manual toggle is on and restores the default on disable", async () => {
    await withHarness({}, async ({ manager }) => {
      await manager.configure("env-sim", { enabled: true, config: { persona: "claude-code" } });
      expect(getUserAgent()).toBe(official());
      await manager.configure("env-sim", { config: { simulateUserAgent: true } });
      expect(getUserAgent()).toBe("claude-code/2.1.232");
      expect(getOfficialUserAgent()).toBe(official());
      await manager.configure("env-sim", { config: { simulateUserAgent: false } });
      expect(getUserAgent()).toBe(official());
      await manager.configure("env-sim", { config: { simulateUserAgent: true, persona: "" } });
      expect(getUserAgent()).toBe(official());
      await manager.configure("env-sim", { enabled: true, config: { persona: "codex", simulateUserAgent: true } });
      expect(getUserAgent()).toBe("codex/0.147.0");
      await manager.configure("env-sim", { enabled: false });
      expect(getUserAgent()).toBe(official());
    });
  }, 30_000);

  it("uses the userAgent field of a user preset when the toggle is on", async () => {
    await withHarness({
      presetFiles: [
        {
          filename: "mine.json",
          content: {
            id: "mine",
            name: "Mine",
            identity: "You are Mine.",
            basePrompt: "mine base",
            userAgent: "mine-cli/3.2.1",
          },
        },
        {
          filename: "plain.json",
          content: {
            id: "plain",
            name: "Plain",
            identity: "You are Plain.",
            basePrompt: "plain base",
          },
        },
      ],
    }, async ({ manager }) => {
      // 用户预设解析需读预设目录（异步 I/O），configure 返回后轮询等待落地
      // 用户预设带 userAgent 且开关开启 → 生效（parsePreset 透传）
      await manager.configure("env-sim", { enabled: true, config: { persona: "mine", simulateUserAgent: true } });
      await vi.waitFor(() => expect(getUserAgent()).toBe("mine-cli/3.2.1"), { timeout: 5_000 });
      // 用户预设未带 userAgent 时，开关开启也不覆盖
      await manager.configure("env-sim", { config: { persona: "plain" } });
      await vi.waitFor(() => expect(getUserAgent()).toBe(official()), { timeout: 5_000 });
    });
  }, 30_000);

  it("ignores session-level persona overrides for the global UA", async () => {
    await withHarness({}, async ({ manager, sessions, session }) => {
      await manager.configure("env-sim", { enabled: true, config: { persona: "claude-code", simulateUserAgent: true } });
      expect(getUserAgent()).toBe("claude-code/2.1.232");
      // 会话级覆盖（SessionMeta.persona 回退通道）只作用于提示词与工具形态，
      // 不参与全局出站 UA——出站请求无会话上下文，避免并发会话串扰
      await sessions.updateConfig(session.id, { persona: "codex" });
      expect(getUserAgent()).toBe("claude-code/2.1.232");
    });
  }, 30_000);
});
