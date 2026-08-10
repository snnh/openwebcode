import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { ContentLensService } from "../src/extensions/content-lens.js";
import { validateConfigAgainstSchema } from "../src/extensions/config-schema.js";
import { OFFICIAL_DEFAULT_CONFIG, OFFICIAL_EXTENSIONS, optimizeAttention } from "../src/extensions/official.js";
import type { ExtensionPermission } from "../src/extensions/types.js";
import type { FastModelClient } from "../src/fast-model.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";
import { waitForEvent } from "./helpers/wait-event.js";

/** 全功能 fixture：echo/hang 工具 + sessions:read 派生工具 + 事件订阅记录（经 seen 工具回读）。 */
const FULL_ENTRY = `
const seen = [];
export function activate(api) {
  api.registerTool({ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }, (input) => "echo:" + String(input.text ?? ""));
  api.registerTool({ name: "hang", description: "Never resolves" }, () => new Promise(() => {}));
  if (api.manifest.permissions.includes("sessions:read")) {
    api.registerTool({ name: "list_sessions", description: "List sessions" }, async () => JSON.stringify(await api.sessions.list()));
    api.registerTool({ name: "seen", description: "Seen events" }, () => JSON.stringify(seen));
    api.events.subscribe(["tool.start", "message.delta"], (event) => { seen.push(event.type); });
  }
}
`;

async function installFixture(manager: ExtensionManager, root: string, options: { permissions: ExtensionPermission[]; entry?: string }): Promise<void> {
  const source = path.join(root, "fixture-src");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    id: "sample", name: "Sample", version: "1.0.0", description: "test fixture", apiVersion: "1", permissions: options.permissions, entry: "index.js",
  }), "utf8");
  await writeFile(path.join(source, "index.js"), options.entry ?? FULL_ENTRY, "utf8");
  await manager.install(source);
}

async function setupManager(options: { permissions: ExtensionPermission[]; entry?: string }) {
  const root = await tempRoot("owc-extapi-");
  const events = new EventBus();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const manager = new ExtensionManager(path.join(root, "data"), events, { sessions });
  await manager.initialize();
  await installFixture(manager, root, options);
  return { root, events, sessions, manager };
}

describe("extension tools:register over host IPC", () => {
  it("registers tools, reports them after reload, and round-trips invokeTool", async () => {
    const { manager } = await setupManager({ permissions: ["tools:register", "sessions:read"] });
    try {
      // 未启用时不注入、不可调用
      expect(manager.registeredTools().filter((tool) => tool.name.startsWith("ext__sample__"))).toHaveLength(0);
      await expect(manager.invokeTool("ext__sample__echo", { text: "hi" })).rejects.toThrow("disabled");
      await manager.configure("sample", { enabled: true });
      const tools = manager.registeredTools();
      const echo = tools.find((tool) => tool.name === "ext__sample__echo");
      expect(echo).toBeDefined();
      expect(echo?.description).toBe("[sample] Echo text");
      expect(echo?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
      expect(await manager.invokeTool("ext__sample__echo", { text: "hi" })).toEqual({ content: "echo:hi" });
      await expect(manager.invokeTool("ext__sample__missing", {})).rejects.toThrow("Unknown extension tool");
      // 停用后注册表清理：不再注入也不可调用
      await manager.configure("sample", { enabled: false });
      expect(manager.registeredTools().some((tool) => tool.name.startsWith("ext__sample__"))).toBe(false);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("times out a hanging tool after 5s and rejects", async () => {
    const { manager } = await setupManager({ permissions: ["tools:register"] });
    try {
      await manager.configure("sample", { enabled: true });
      await expect(manager.invokeTool("ext__sample__hang", {})).rejects.toThrow(/timeout/i);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("serves sessions.list through the api channel with a minimized meta shape", async () => {
    const { manager, sessions, root } = await setupManager({ permissions: ["tools:register", "sessions:read"] });
    try {
      await sessions.create({ cwd: root, provider: "p1", model: "m1", title: "T1" });
      await manager.configure("sample", { enabled: true });
      const result = await manager.invokeTool("ext__sample__list_sessions", {});
      const list = JSON.parse(result.content) as Array<Record<string, unknown>>;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ title: "T1", provider: "p1", model: "m1" });
      // 脱敏/最小化：不暴露沙盒策略、setupScript 等内部字段
      expect(list[0]).not.toHaveProperty("sandbox");
      expect(list[0]).not.toHaveProperty("setupScript");
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("extension api permission enforcement", () => {
  it("marks an extension error when it calls sessions.list without sessions:read", async () => {
    const { manager } = await setupManager({
      permissions: [],
      entry: "export function activate(api) { void api.sessions.list(); }\n",
    });
    try {
      const info = (await manager.configure("sample", { enabled: true }));
      expect(info.status).toBe("error");
      expect(info.error).toContain("sessions:read");
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("marks an extension error when it registers a tool without tools:register", async () => {
    const { manager } = await setupManager({
      permissions: [],
      entry: "export function activate(api) { api.registerTool({ name: 'echo', description: 'x' }, () => 'x'); }\n",
    });
    try {
      const info = (await manager.configure("sample", { enabled: true }));
      expect(info.status).toBe("error");
      expect(info.error).toContain("tools:register");
      expect(manager.registeredTools().some((tool) => tool.name.startsWith("ext__sample__"))).toBe(false);
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("extension events.subscribe", () => {
  it("pushes subscribed whitelisted types only", async () => {
    const { manager, events } = await setupManager({ permissions: ["tools:register", "sessions:read"] });
    try {
      await manager.configure("sample", { enabled: true });
      const seen = async (): Promise<string[]> => JSON.parse((await manager.invokeTool("ext__sample__seen", {})).content) as string[];
      events.publish({ source: "agent", type: "tool.start", sessionId: "s1", payload: { toolCallId: "1", name: "bash", input: {} } });
      // 白名单内但未订阅：不推送
      events.publish({ source: "agent", type: "tool.end", sessionId: "s1", payload: { toolCallId: "1" } });
      // 订阅了但不在白名单：不推送
      events.publish({ source: "agent", type: "message.delta", sessionId: "s1", payload: { text: "x" } });
      await vi.waitFor(async () => expect(await seen()).toContain("tool.start"), { timeout: 5_000 });
      const final = await seen();
      expect(final).not.toContain("tool.end");
      expect(final).not.toContain("message.delta");
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("re-subscribing accumulates types (union, matching host-side semantics)", async () => {
    const { manager, events } = await setupManager({
      permissions: ["tools:register", "sessions:read"],
      entry: `
const seen = [];
export function activate(api) {
  api.registerTool({ name: "seen", description: "Seen events" }, () => JSON.stringify(seen));
  api.events.subscribe(["tool.start"], (event) => { seen.push(event.type); });
  api.events.subscribe(["tool.end"], (event) => { seen.push(event.type); });
}
`,
    });
    try {
      await manager.configure("sample", { enabled: true });
      const seen = async (): Promise<string[]> => JSON.parse((await manager.invokeTool("ext__sample__seen", {})).content) as string[];
      // host 侧 events.subscribe 的 api 调用是 fire-and-forget：轮询重发事件直到两次订阅都生效
      await vi.waitFor(async () => {
        events.publish({ source: "agent", type: "tool.start", sessionId: "s1", payload: { toolCallId: "1", name: "bash", input: {} } });
        events.publish({ source: "agent", type: "tool.end", sessionId: "s1", payload: { toolCallId: "1" } });
        const types = await seen();
        expect(types).toContain("tool.start"); // 替换语义下第二次 subscribe 会丢掉 tool.start
        expect(types).toContain("tool.end");
      }, { timeout: 5_000 });
    } finally {
      await manager.close();
    }
  }, 20_000);
});

/** agent 链路：首回合固定调用 ext__sample__echo，第二回合（看到 tool_result）结束。 */
const extToolProvider = makeStubProvider("test-stub", async function* (request) {
  const last = request.messages.at(-1);
  const toolResult = last?.content.find((block) => block.type === "tool_result");
  if (toolResult?.type === "tool_result") {
    yield { type: "text_delta", text: toolResult.isError ? "工具失败" : "工具完成" };
    yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
    yield { type: "done", stopReason: "end_turn" };
    return;
  }
  yield { type: "tool_call", id: `ext-call-${request.messages.length}`, name: "ext__sample__echo", input: { text: "hi" } };
  yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
  yield { type: "done", stopReason: "tool_use" };
});

async function setupAgent(permissionMode: "ask" | "yolo") {
  const root = await tempRoot("owc-extapi-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: "ext tool" });
  await sessions.updatePermissions(session.id, permissionMode, []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(extToolProvider);
  // ext__ 工具链路不需要真实 core；空实现即可装配 buildServer/AgentRunner
  const core = makeFakeCore();
  const manager = new ExtensionManager(path.join(root, "data"), events, { sessions });
  await manager.initialize();
  await installFixture(manager, root, { permissions: ["tools:register", "sessions:read"] });
  await manager.configure("sample", { enabled: true });
  const agent = new AgentRunner(
    sessions, providers, core, events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, manager,
  );
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, session, events, agent, manager, app };
}

async function waitIdle(events: EventBus, agent: AgentRunner, sessionId: string): Promise<void> {
  const idle = waitForEvent(events, "agent.state", { sessionId, match: (event) => (event.payload as { state?: string }).state === "idle" });
  if (!agent.isRunning(sessionId)) return;
  await idle;
}

describe("ext__ tool permission chain", () => {
  it("ask + allow: suspends on permission.request, then executes via host after respond", async () => {
    const harness = await setupAgent("ask");
    const { app, events, sessions, session, agent, manager } = harness;
    try {
      const permissionEvent = waitForEvent(events, "permission.request", { sessionId: session.id });
      const accepted = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "go" } });
      expect(accepted.statusCode).toBe(202);
      const request = await permissionEvent;
      expect((request.payload as { tool: string }).tool).toBe("ext__sample__echo");
      const requestId = (request.payload as { requestId: string }).requestId;
      const respond = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/permissions/respond`, payload: { requestId, decision: "allow" } });
      expect(respond.statusCode).toBe(200);
      await waitIdle(events, agent, session.id);
      const detail = await sessions.get(session.id);
      const toolResult = detail?.messages.find((message) => message.role === "tool")?.content[0];
      expect(toolResult).toMatchObject({ type: "tool_result", content: "echo:hi", isError: false });
    } finally {
      await app.close();
      await manager.close();
    }
  }, 25_000);

  it("ask + deny: persists an error tool_result without invoking the extension", async () => {
    const harness = await setupAgent("ask");
    const { app, events, sessions, session, agent, manager } = harness;
    try {
      const permissionEvent = waitForEvent(events, "permission.request", { sessionId: session.id });
      const accepted = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "go" } });
      expect(accepted.statusCode).toBe(202);
      const requestId = ((await permissionEvent).payload as { requestId: string }).requestId;
      const respond = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/permissions/respond`, payload: { requestId, decision: "deny", reason: "user declined" } });
      expect(respond.statusCode).toBe(200);
      await waitIdle(events, agent, session.id);
      const detail = await sessions.get(session.id);
      const toolResult = detail?.messages.find((message) => message.role === "tool")?.content[0];
      expect(toolResult).toMatchObject({ type: "tool_result", isError: true });
      expect((toolResult as { content: string }).content).toContain("user declined");
    } finally {
      await app.close();
      await manager.close();
    }
  }, 25_000);

  it("ask + allow_always: persists the rule and skips approval on the next identical call", async () => {
    const harness = await setupAgent("ask");
    const { app, events, sessions, session, agent, manager } = harness;
    try {
      const permissionEvent = waitForEvent(events, "permission.request", { sessionId: session.id });
      expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "go" } })).statusCode).toBe(202);
      const requestId = ((await permissionEvent).payload as { requestId: string }).requestId;
      expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/permissions/respond`, payload: { requestId, decision: "allow_always" } })).statusCode).toBe(200);
      await waitIdle(events, agent, session.id);
      expect((await sessions.get(session.id))?.permissionRules).toContainEqual({ tool: "ext__sample__echo" });
      // 第二次相同工具调用：规则命中，直接进入执行，不再有 permission.request
      let requested = false;
      events.on("event", (event: AppEvent) => { if (event.type === "permission.request") requested = true; });
      expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "again" } })).statusCode).toBe(202);
      await waitIdle(events, agent, session.id);
      expect(requested).toBe(false);
      const detail = await sessions.get(session.id);
      const results = detail?.messages.filter((message) => message.role === "tool").map((message) => message.content[0]);
      expect(results).toHaveLength(2);
      expect(results?.[1]).toMatchObject({ type: "tool_result", content: "echo:hi", isError: false });
    } finally {
      await app.close();
      await manager.close();
    }
  }, 25_000);

  it("yolo: executes without a permission request", async () => {
    const harness = await setupAgent("yolo");
    const { app, events, sessions, session, agent, manager } = harness;
    try {
      let requested = false;
      events.on("event", (event: AppEvent) => { if (event.type === "permission.request") requested = true; });
      expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "go" } })).statusCode).toBe(202);
      await waitIdle(events, agent, session.id);
      expect(requested).toBe(false);
      const toolResult = (await sessions.get(session.id))?.messages.find((message) => message.role === "tool")?.content[0];
      expect(toolResult).toMatchObject({ type: "tool_result", content: "echo:hi", isError: false });
    } finally {
      await app.close();
      await manager.close();
    }
  }, 25_000);
});

// ---- extensions 组（合并） ----
function extMessage(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, createdAt: "2026-07-20T00:00:00.000Z", content: [{ type: "text", text }] };
}

describe("official extensions", () => {
  it("copies important references into a bottom anchor without rewriting original messages", () => {
    const messages = [extMessage("u1", "user", "必须保留所有用户修改"), extMessage("a1", "assistant", "收到"), extMessage("u2", "user", "修复测试失败")];
    const result = optimizeAttention({ sessionId: "s1", cwd: "/tmp/work", messages, ledger: { round: 2, entries: [], compacted: { summary: "", instructions: ["不要删除文档"] } } }, { mode: "bottomOnly", anchorBudget: 1000 });
    expect(result.messages).toHaveLength(messages.length + 1);
    expect(result.messages?.slice(0, messages.length)).toEqual(messages);
    expect(result.messages?.at(-1)?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("必须保留") });
  });

  it("runs official hooks in a separate host and persists enable/config state", async () => {
    const root = await tempRoot("owc-ext-");
    const manager = new ExtensionManager(root);
    await manager.initialize();
    try {
      expect(manager.list().map((item) => [item.id, item.enabled])).toEqual([
        ["context-manager", true],
        ["attention-optimizer", false],
        ["content-lens", false],
        ["pdf-to-image", true],
        ["owc-eval", false],
        ["env-sim", false],
        ["compact-vault", false],
      ]);
      expect(manager.list().find((item) => item.id === "pdf-to-image")).toMatchObject({
        permissions: ["ui:messageAttachment"],
        config: { maxPages: 4, dpi: 150, maxDimension: 2048 },
      });
      await manager.configure("attention-optimizer", { enabled: true, config: { mode: "full", anchorBudget: 800 } });
      const transformed = await manager.transformContext({ sessionId: "s1", cwd: root, messages: [extMessage("u1", "user", "必须运行测试")], ledger: { round: 1, entries: [] } });
      expect(transformed.messages.length).toBeGreaterThan(1);
      const persisted = JSON.parse(await readFile(path.join(root, "extensions", "extensions.json"), "utf8")) as { extensions: Record<string, { enabled: boolean }> };
      expect(persisted.extensions["attention-optimizer"]?.enabled).toBe(true);

      const source = path.join(root, "sample-source");
      await mkdir(source);
      await writeFile(path.join(source, "manifest.json"), JSON.stringify({ id: "sample", name: "Sample", version: "1.0.0", description: "test", apiVersion: "1", permissions: [], entry: "index.js" }), "utf8");
      await writeFile(path.join(source, "index.js"), "export function activate(api) { api.on('context.beforeBuild', (payload) => ({ messages: payload.messages })); }\n", "utf8");
      expect((await manager.install(source)).id).toBe("sample");
      expect((await manager.configure("sample", { enabled: true })).status).toBe("error");
      await manager.uninstall("sample");
      expect(manager.list().find((item) => item.id === "context-manager")?.status).toBe("running");

      await writeFile(path.join(source, "manifest.json"), JSON.stringify({ id: "context-manager", name: "Collision", version: "1.0.0", description: "test", apiVersion: "1", permissions: [] }), "utf8");
      await expect(manager.install(source)).rejects.toThrow("Extension ID already exists");
    } finally {
      await manager.close();
    }
  }, 15_000);

  it("keeps content-lens output outside message history and reuses its translation cache", async () => {
    const root = await tempRoot("owc-lens-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test-stub", model: "test-stub" });
    const saved = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "Hello **world**" }]);
    let calls = 0;
    const fastModel = {
      configured: true,
      complete: async () => { calls += 1; return { text: "你好 **world**", usage: { inputTokens: 3, outputTokens: 3 } }; },
    } as unknown as FastModelClient;
    const lens = new ContentLensService(sessions, fastModel);
    expect((await lens.translate(session.id, saved.id, "zh-CN")).cached).toBe(false);
    expect((await lens.translate(session.id, saved.id, "zh-CN")).cached).toBe(true);
    expect(calls).toBe(1);
    expect((await sessions.get(session.id))?.messages).toHaveLength(1);
  });
});

describe("官方扩展 configSchema", () => {
  it("每个官方扩展的默认配置通过自身 schema 校验（防漂移）", () => {
    for (const manifest of OFFICIAL_EXTENSIONS) {
      const defaults = OFFICIAL_DEFAULT_CONFIG[manifest.id];
      expect(defaults, `${manifest.id} 缺少默认配置`).toBeDefined();
      if (!manifest.configSchema) continue;
      const problem = validateConfigAgainstSchema(manifest.configSchema, defaults);
      expect(problem, `${manifest.id} 默认配置未通过 schema: ${problem ?? ""}`).toBeNull();
    }
  });

  it("带表单的官方扩展均声明 configSchema（设置页不再回退 JSON 编辑）", () => {
    // context-manager 按会话在「上下文」面板配置；owc-eval 无可配置项——二者例外
    const exempt = new Set(["context-manager", "owc-eval"]);
    for (const manifest of OFFICIAL_EXTENSIONS) {
      if (exempt.has(manifest.id)) continue;
      expect(manifest.configSchema, `${manifest.id} 缺少 configSchema`).toBeDefined();
    }
  });

  it("schema 属性均带 title 与 description（设置页描述条目）", () => {
    const checkProperties = (properties: Record<string, unknown>, path: string): void => {
      for (const [key, raw] of Object.entries(properties)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const spec = raw as Record<string, unknown>;
        expect(typeof spec.title, `${path}.${key} 缺少 title`).toBe("string");
        expect(spec.title === "" || typeof spec.description === "string", `${path}.${key} 缺少 description`).toBe(true);
        if (spec.properties && typeof spec.properties === "object" && !Array.isArray(spec.properties)) {
          checkProperties(spec.properties as Record<string, unknown>, `${path}.${key}`);
        }
      }
    };
    for (const manifest of OFFICIAL_EXTENSIONS) {
      const properties = manifest.configSchema?.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
      checkProperties(properties as Record<string, unknown>, manifest.id);
    }
  });
});
