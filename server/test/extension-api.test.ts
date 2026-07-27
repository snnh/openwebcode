import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { ExtensionPermission } from "../src/extensions/types.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-extapi-"));
  roots.push(root);
  return root;
}

const FAKE_CORE_INFO: CoreInfo = {
  version: "0.2.4-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

/** ext__ 工具链路不需要真实 core；提供最小 CoreClientLike 让 buildServer/AgentRunner 可装配。 */
function fakeCore(): CoreClientLike {
  return {
    on() { return this; },
    async start() { return FAKE_CORE_INFO; },
    async stop() { return undefined; },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async run() { return { exitCode: 0, durationMs: 1, truncated: false }; },
    async ping() { return FAKE_CORE_INFO; },
    async cleanupSession() { return { ok: true as const }; },
    async readFile() { return { content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 0 }; },
    async listFiles() { return { entries: [], truncated: false }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    setRequestTimeoutMs() {},
  } as unknown as CoreClientLike;
}

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
  const root = await tempRoot();
  const events = new EventBus();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const manager = new ExtensionManager(path.join(root, "data"), events, { sessions });
  await manager.initialize();
  await installFixture(manager, root, options);
  return { root, events, sessions, manager };
}

function waitForEvent(events: EventBus, type: string, match?: (event: AppEvent) => boolean): Promise<AppEvent> {
  return new Promise((resolve) => {
    const listener = (event: AppEvent): void => {
      if (event.type !== type) return;
      if (match && !match(event)) return;
      events.removeListener("event", listener);
      resolve(event);
    };
    events.on("event", listener);
  });
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
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: "ext tool" });
  await sessions.updatePermissions(session.id, permissionMode, []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(extToolProvider);
  const core = fakeCore();
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
  const idle = waitForEvent(events, "agent.state", (event) => event.sessionId === sessionId && (event.payload as { state?: string }).state === "idle");
  if (!agent.isRunning(sessionId)) return;
  await idle;
}

describe("ext__ tool permission chain", () => {
  it("ask + allow: suspends on permission.request, then executes via host after respond", async () => {
    const harness = await setupAgent("ask");
    const { app, events, sessions, session, agent, manager } = harness;
    try {
      const permissionEvent = waitForEvent(events, "permission.request", (event) => event.sessionId === session.id);
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
      const permissionEvent = waitForEvent(events, "permission.request", (event) => event.sessionId === session.id);
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
      const permissionEvent = waitForEvent(events, "permission.request", (event) => event.sessionId === session.id);
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
