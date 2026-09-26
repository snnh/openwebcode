import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRootRetry } from "./helpers/temp-roots.js";
import { waitForEvent } from "./helpers/wait-event.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
const coreAvailable = existsSync(corePath);
const clients: CoreClient[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => undefined)));
});

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  sessions: SessionStore;
  events: EventBus;
  core: CoreClient;
  root: string;
}

/** 真实 Core 的 E2E 装配：注入 anthropic 定价（内置默认不再含 claude 定价）+ runner + app（afterEach 收尾）。 */
async function setup(provider: Provider): Promise<Harness> {
  const root = await tempRootRetry("owc-e2e-");
  const sessions = new SessionStore(path.join(root, ".sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  await pricing.replace({
    version: 1,
    updatedAt: "2026-07-14T00:00:00.000Z",
    entries: [
      { provider: "anthropic", model: "claude-opus-4-8", currency: "USD", effectiveFrom: "2026-01-01", input: "5000000", output: "25000000", cacheRead: "500000", cacheWrite: "6250000" },
      { provider: "anthropic", model: "claude-haiku-4-5", currency: "USD", effectiveFrom: "2025-01-01", input: "1000000", output: "5000000", cacheRead: "100000", cacheWrite: "1250000" },
    ],
  });
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(provider);
  const core = new CoreClient(corePath);
  clients.push(core);
  await core.start();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  apps.push(app);
  return { app, sessions, events, core, root };
}

function requestId(event: AppEvent): string {
  return (event.payload as { requestId: string }).requestId;
}

const idle = (event: AppEvent): boolean => (event.payload as { state?: string }).state === "idle";

function post(harness: Harness, url: string, payload: unknown) {
  return harness.app.inject({ method: "POST", url, payload });
}

async function newSession(app: Harness["app"], payload: Record<string, unknown>): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/api/sessions", payload });
  expect(created.statusCode).toBe(201);
  return created.json<{ id: string }>().id;
}

/** 提交一条消息 → 等权限卡 → 按 decision 应答 → 等 run 回到 idle。 */
async function submitWithPermission(harness: Harness, sessionId: string, content: string, decision: "allow" | "deny", reason?: string) {
  const settled = waitForEvent(harness.events, "agent.state", { sessionId, match: idle });
  const permission = waitForEvent(harness.events, "permission.request", { sessionId }); // 先订阅再 inject，避免错过事件挂起
  expect((await post(harness, `/api/sessions/${sessionId}/messages`, { content })).statusCode).toBe(202);
  const responded = await post(harness, `/api/sessions/${sessionId}/permissions/respond`, { requestId: requestId(await permission), decision, ...(reason ? { reason } : {}) });
  expect(responded.statusCode).toBe(200);
  await settled;
}

// 按消息内容驱动的确定性 provider：识别 write: 指令生成 write_file 工具调用
function scriptProvider(name: string): Provider {
  let turns = 0;
  return {
    name,
    async *streamChat(request) {
      turns += 1;
      const last = request.messages.at(-1);
      const toolResult = last?.content.find((block) => block.type === "tool_result");
      const text = last?.content.find((block) => block.type === "text");
      const content = text?.type === "text" ? text.text : "";
      const write = toolResult ? null : /^write:\s*(\S+)\s*(.*)$/s.exec(content);
      if (write) yield { type: "tool_call" as const, id: `w-${turns}`, name: "write_file", input: { path: write[1], content: write[2] ?? "", createDirs: true } };
      else yield { type: "text_delta" as const, text: toolResult ? (toolResult.isError ? "工具失败" : "工具完成") : `收到：${content.slice(0, 20)}` };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: write ? "tool_use" as const : "end_turn" as const };
    },
  };
}

describe("stage 3 vertical acceptance", () => {
  it.skipIf(!coreAvailable)("真实 Core：提交→权限→工具→账本→检查点回退→再提交拒绝写入", async () => {
    let request = 0;
    const provider: Provider = {
      name: "anthropic",
      async *streamChat() {
        request += 1;
        if (request === 1) {
          yield { type: "tool_call", id: "write-allowed", name: "write_file", input: { path: "src/result.txt", content: "stage-three\n", createDirs: true } };
          yield { type: "usage", inputTokens: 100, outputTokens: 20, cacheRead: 10, cacheWrite: 5 };
          yield { type: "done", stopReason: "tool_use" };
        } else if (request === 2) {
          yield { type: "text_delta", text: "编码任务完成" };
          yield { type: "usage", inputTokens: 50, outputTokens: 10, cacheRead: 0, cacheWrite: 0 };
          yield { type: "done", stopReason: "end_turn" };
        } else if (request === 3) {
          yield { type: "tool_call", id: "write-denied", name: "write_file", input: { path: "denied.txt", content: "must-not-exist" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "已遵守拒绝决定" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const captured: AppEvent[] = [];
    const harness = await setup(provider);
    harness.events.on("event", (event) => captured.push(event));
    const sessionId = await newSession(harness.app, { cwd: harness.root, provider: "anthropic", model: "claude-opus-4-8" });

    await submitWithPermission(harness, sessionId, "创建阶段三验收文件", "allow");
    expect(await readFile(path.join(harness.root, "src/result.txt"), "utf8")).toBe("stage-three\n");
    const context = await harness.app.inject({ method: "GET", url: `/api/sessions/${sessionId}/context` });
    expect(context.statusCode).toBe(200);
    const { ledger } = context.json<{ ledger: { usage: { inputTokens: number; outputTokens: number }; cost: { usdMicroUnits: string; unpricedTokens: number } } }>();
    expect(ledger).toMatchObject({ usage: { inputTokens: 150, outputTokens: 30 } });
    expect(BigInt(ledger.cost.usdMicroUnits)).toBeGreaterThan(0n);
    expect(ledger.cost.unpricedTokens).toBe(0);
    expect(captured.map((event) => event.type)).toEqual(expect.arrayContaining(["context.usage", "tool.end"]));

    const checkpoint = (await harness.app.inject({ method: "GET", url: `/api/sessions/${sessionId}/checkpoints` })).json<Array<{ id: string }>>()[0];
    expect(checkpoint).toBeDefined();
    const restored = await harness.app.inject({
      method: "POST", url: `/api/sessions/${sessionId}/checkpoints/${checkpoint!.id}/restore`, payload: { confirm: true },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    await expect(readFile(path.join(harness.root, "src/result.txt"), "utf8")).rejects.toThrow();
    expect((await harness.sessions.get(sessionId))?.messages).toHaveLength(0);

    await submitWithPermission(harness, sessionId, "尝试写入但等待拒绝", "deny", "验收拒绝");
    await expect(readFile(path.join(harness.root, "denied.txt"), "utf8")).rejects.toThrow();
    expect((await harness.sessions.get(sessionId))?.messages.some((message) => message.role === "tool" && message.content.some((block) =>
      block.type === "tool_result" && block.isError && block.content === "验收拒绝"))).toBe(true);
  }, 30_000);
});

describe.skipIf(!coreAvailable)("stage 4 web E2E", () => {
  it("权限卡可经 REST 恢复，写盘→上下文→文件树→预览→检查点 diff 全链路可用", async () => {
    const harness = await setup(scriptProvider("anthropic"));
    const { app, events, root } = harness;
    const sessionId = await newSession(app, { cwd: root, provider: "anthropic", model: "claude-opus-4-8" });

    const settled = waitForEvent(events, "agent.state", { sessionId, match: idle });
    const permission = waitForEvent(events, "permission.request", { sessionId });
    expect((await post(harness, `/api/sessions/${sessionId}/messages`, { content: "write: result.txt hello-stage4" })).statusCode).toBe(202);
    const req = requestId(await permission);
    // 待确认权限可通过 REST 恢复（前端刷新后重新播种权限卡）
    const pending = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/permissions` })).json<Array<{ requestId: string; tool: string }>>();
    expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: req, tool: "write_file" })]));
    expect((await post(harness, `/api/sessions/${sessionId}/permissions/respond`, { requestId: req, decision: "allow" })).statusCode).toBe(200);
    await settled;
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/permissions` })).json<unknown[]>()).toHaveLength(0);

    expect(await readFile(path.join(root, "result.txt"), "utf8")).toBe("hello-stage4");
    const context = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/context` })).json<{
      ledger: { usage: { inputTokens: number; outputTokens: number }; cost: { usdMicroUnits: string } };
    }>();
    expect(context.ledger.usage.inputTokens + context.ledger.usage.outputTokens).toBeGreaterThan(0);
    expect(BigInt(context.ledger.cost.usdMicroUnits)).toBeGreaterThan(0n);
    const files = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files?path=.` })).json<{ entries: Array<{ name: string; type: string }> }>();
    expect(files.entries.some((entry) => entry.name === "result.txt" && entry.type === "file")).toBe(true);
    const preview = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files/content?path=result.txt` })).json<{ content: string }>();
    expect(preview.content).toBe("hello-stage4");
    const checkpoints = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/checkpoints` })).json<Array<{ id: string }>>();
    const diff = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/checkpoints/${checkpoints[0]!.id}/diff` })).json<{ diff: string }>();
    expect(typeof diff.diff).toBe("string");
  }, 30_000);
});

type WsClient = import("ws").WebSocket;

/** WS E2E rig：真实监听端口 + 可选事件环形缓冲容量（app 由 afterEach 关闭）。 */
async function wsRig(eventBufferSize?: number) {
  const { WebSocket } = await import("ws");
  const stubCore = { on() { return stubCore; } } as unknown as CoreClient;
  const root = await tempRootRetry("owc-ws-");
  const sessions = new SessionStore(path.join(root, ".sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus(eventBufferSize);
  const app = await buildServer({
    core: stubCore, sessions, agent: { isRunning: () => false } as unknown as AgentRunner, events, providers: new ProviderRegistry(), pricing,
  });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const base = typeof address === "object" && address ? `ws://127.0.0.1:${address.port}` : "";
  return { events, open: (query: string) => new WebSocket(`${base}/api/events${query}`) as unknown as WsClient };
}

/** 收集 count 条非 connected 事件；count = 0 表示 timeoutMs 内必须保持静默（收到事件即 reject）。 */
function collectEvents(ws: WsClient, count: number, timeoutMs = 5_000): Promise<AppEvent[]> {
  return new Promise((resolve, reject) => {
    const received: AppEvent[] = [];
    const finish = (error?: string) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      if (error) reject(new Error(error));
      else resolve(received);
    };
    const onMessage = (data: Buffer) => {
      const event = JSON.parse(data.toString()) as AppEvent;
      if (event.type === "connected") return;
      received.push(event);
      if (count === 0) finish(`unexpected event: ${event.type}`);
      else if (received.length >= count) finish();
    };
    const timer = setTimeout(() => finish(received.length >= count ? undefined : `expected ${count} events, got ${received.length}`), timeoutMs);
    ws.on("message", onMessage);
  });
}

/** 等 connected 帧（服务端此时已注册该客户端）。 */
function waitConnected(ws: WsClient): Promise<void> {
  return new Promise((resolve) => {
    ws.on("message", function onMessage(data: Buffer) {
      if ((JSON.parse(data.toString()) as AppEvent).type !== "connected") return;
      ws.off("message", onMessage);
      resolve();
    });
  });
}

describe("WebSocket event replay / resync / session isolation", () => {
  it("重连客户端收到缓冲事件；缓冲淘汰后改为 resync.required", async () => {
    const { events, open } = await wsRig(2);
    events.publish({ source: "session", type: "one", sessionId: "s1", payload: null });
    events.publish({ source: "agent", type: "two", sessionId: "s1", payload: null });

    const replayWs = open("?after=0&sessionId=s1");
    expect((await collectEvents(replayWs, 2)).map((event) => event.type)).toEqual(["one", "two"]);
    replayWs.close();

    events.publish({ source: "session", type: "three", sessionId: "s1", payload: null });
    events.publish({ source: "session", type: "four", sessionId: "s1", payload: null });
    const resyncWs = open("?after=1&sessionId=s1");
    expect((await collectEvents(resyncWs, 1))[0]?.type).toBe("resync.required");
    resyncWs.close();
  }, 15_000);

  it("带 sessionId 的客户端仅收本会话与全局事件；无订阅客户端收全量", async () => {
    const { events, open } = await wsRig();
    const subscribed = open("?sessionId=s1");
    const globalClient = open("");
    await Promise.all([waitConnected(subscribed), waitConnected(globalClient)]);

    // 其他会话的运行状态不会越过会话边界，但全量客户端仍会收到。
    const filtered = collectEvents(subscribed, 0, 200);
    const foreign = collectEvents(globalClient, 3);
    events.publish({ source: "agent", type: "agent.state", sessionId: "s2", payload: { state: "running" } });
    events.publish({ source: "agent", type: "run.accepted", sessionId: "s2", payload: {} });
    events.publish({ source: "agent", type: "tool.end", sessionId: "s2", payload: {} });
    expect((await foreign).map((event) => event.type)).toEqual(["agent.state", "run.accepted", "tool.end"]);
    await filtered;

    const own = collectEvents(subscribed, 1);
    events.publish({ source: "agent", type: "agent.state", sessionId: "s1", payload: { state: "running" } });
    expect((await own)[0]?.sessionId).toBe("s1");
    subscribed.close();
    globalClient.close();
  }, 15_000);
});
