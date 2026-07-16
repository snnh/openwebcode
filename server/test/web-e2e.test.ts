import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
const coreAvailable = existsSync(corePath);
const roots: string[] = [];
const clients: CoreClient[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  sessions: SessionStore;
  events: EventBus;
  core: CoreClient;
  root: string;
}

async function setup(provider: Provider): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-web-e2e-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, ".sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
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

function waitForEvent(events: EventBus, sessionId: string, type: string, predicate: (event: AppEvent) => boolean = () => true): Promise<AppEvent> {
  return new Promise((resolve) => {
    const listener = (event: AppEvent): void => {
      if (event.sessionId !== sessionId || event.type !== type || !predicate(event)) return;
      events.off("event", listener);
      resolve(event);
    };
    events.on("event", listener);
  });
}

function requestId(event: AppEvent): string {
  return (event.payload as { requestId: string }).requestId;
}

// 按消息内容驱动的确定性 provider：识别 write: 指令生成 write_file 工具调用
function scriptProvider(name: string, requests: StreamChatRequest[]): Provider {
  return {
    name,
    async *streamChat(request) {
      requests.push(request);
      const last = request.messages.at(-1);
      const toolResult = last?.content.find((block) => block.type === "tool_result");
      if (toolResult?.type === "tool_result") {
        yield { type: "text_delta", text: toolResult.isError ? "工具失败" : "工具完成" };
        yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      const text = last?.content.find((block) => block.type === "text");
      const content = text?.type === "text" ? text.text : "";
      const match = /^write:\s*(\S+)\s*(.*)$/s.exec(content);
      if (match) {
        yield { type: "tool_call", id: `w-${requests.length}`, name: "write_file", input: { path: match[1], content: match[2] ?? "", createDirs: true } };
        yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
        yield { type: "done", stopReason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: `收到：${content.slice(0, 20)}` };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe.skipIf(!coreAvailable)("stage 4 web E2E", () => {
  it("runs a coding task through permission, file tool, context, file tree, and checkpoint diff", async () => {
    const requests: StreamChatRequest[] = [];
    const harness = await setup(scriptProvider("anthropic", requests));
    const { app, events, root } = harness;

    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "claude-opus-4-8" } });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ id: string }>().id;

    const idle = waitForEvent(events, sessionId, "agent.state", (e) => (e.payload as { state?: string }).state === "idle");
    // 先订阅 permission.request 再 inject，避免错过事件导致挂起（与 stage3-e2e 一致）
    const permissionEvent = waitForEvent(events, sessionId, "permission.request");
    const accepted = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "write: result.txt hello-stage4" } });
    expect(accepted.statusCode).toBe(202);
    const req = requestId(await permissionEvent);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/permissions/respond`, payload: { requestId: req, decision: "allow" } })).statusCode).toBe(200);
    await idle;

    expect(await readFile(path.join(root, "result.txt"), "utf8")).toBe("hello-stage4");
    const context = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/context` })).json<{
      ledger: { usage: { inputTokens: number; outputTokens: number }; cost: { usdMicroUnits: string; unpricedTokens: number } };
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

  it("queues steering over HTTP during a run and applies it at the safe boundary", async () => {
    const requests: StreamChatRequest[] = [];
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const provider: Provider = {
      name: "anthropic",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) { releaseFirst(); await gate; }
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const harness = await setup(provider);
    const { app, events, root } = harness;
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "claude-opus-4-8" } })).json<{ id: string }>();

    const runningIdle = waitForEvent(events, session.id, "agent.state", (e) => (e.payload as { state?: string }).state === "idle");
    const running = app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "初始任务" } });
    await firstEntered;
    const queued = (await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "补充指令" } })).json<{ accepted: boolean; queued: boolean; position: number }>();
    expect(queued).toMatchObject({ accepted: true, queued: true, position: 1 });
    const list = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/steering` })).json<Array<{ content: string }>>();
    expect(list.map((item) => item.content)).toEqual(["补充指令"]);
    finish();
    await running;
    await runningIdle;
    // 第二轮 provider 请求含 steering 文本（按 role=user 追加）
    expect(requests[1]?.messages.some((m) =>
      m.role === "user" && m.content.some((b) => b.type === "text" && b.text === "补充指令"))).toBe(true);
  }, 30_000);

  it("hot-switches model over HTTP and uses the new config on the next run", async () => {
    const requests: StreamChatRequest[] = [];
    const harness = await setup(scriptProvider("anthropic", requests));
    const { app, events, root } = harness;
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "claude-haiku-4-5" } })).json<{ id: string }>();

    const firstIdle = waitForEvent(events, session.id, "agent.state", (e) => (e.payload as { state?: string }).state === "idle");
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "第一轮" } })).statusCode).toBe(202);
    await firstIdle;
    const updated = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "claude-opus-4-8", thinking: "adaptive", effort: "xhigh" } });
    expect(updated.statusCode).toBe(200);
    const secondIdle = waitForEvent(events, session.id, "agent.state", (e) => (e.payload as { state?: string }).state === "idle");
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "第二轮" } })).statusCode).toBe(202);
    await secondIdle;

    expect(requests[0]).toMatchObject({ model: "claude-haiku-4-5" });
    expect(requests[1]).toMatchObject({ model: "claude-opus-4-8", thinking: "adaptive", effort: "xhigh" });
  }, 30_000);

  it("rolls back a checkpoint over HTTP, restoring files and truncating messages", async () => {
    const requests: StreamChatRequest[] = [];
    const harness = await setup(scriptProvider("anthropic", requests));
    const { app, events, root } = harness;
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "claude-opus-4-8" } })).json<{ id: string }>();

    const firstIdle = waitForEvent(events, session.id, "agent.state", (e) => (e.payload as { state?: string }).state === "idle");
    const firstPerm = waitForEvent(events, session.id, "permission.request");
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "write: keep.txt kept" } });
    const firstReq = requestId(await firstPerm);
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/permissions/respond`, payload: { requestId: firstReq, decision: "allow" } });
    await firstIdle;
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);

    // 手动建立"keep.txt 已写入"检查点，用于后续选择性回滚断言。
    // agent.run 开头的自动检查点创建于首条用户消息之前（messageCount=0），无区分度。
    const manual = (await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "after-keep" } })).json<{ id: string; messageCount: number }>();
    expect(manual.messageCount).toBeGreaterThan(0);
    const secondIdle = waitForEvent(events, session.id, "agent.state", (e) => (e.payload as { state?: string }).state === "idle");
    const secondPerm = waitForEvent(events, session.id, "permission.request");
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "write: gone.txt temporary" } });
    const secondReq = requestId(await secondPerm);
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/permissions/respond`, payload: { requestId: secondReq, decision: "allow" } });
    await secondIdle;
    expect(existsSync(path.join(root, "gone.txt"))).toBe(true);

    const restored = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${manual.id}/restore`, payload: { confirm: true } });
    expect(restored.statusCode).toBe(200);
    // 选择性回滚：第二段的 gone.txt 被消除
    expect(existsSync(path.join(root, "gone.txt"))).toBe(false);
    // keep.txt 仍存在，证明仅回滚到手动检查点之后的状态
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
    const detail = await harness.sessions.get(session.id);
    expect(detail?.messages).toHaveLength(manual.messageCount);
  }, 30_000);
});

describe("WebSocket event replay and resync", () => {
  it("replays buffered events to a reconnecting client and signals resync when evicted", async () => {
    const { WebSocket } = await import("ws");
    const stubCore = { on() { return stubCore; } } as unknown as CoreClient;
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-ws-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, ".sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus(2);
    const providers = new ProviderRegistry();
    const app = await buildServer({ core: stubCore, sessions, agent: { isRunning: () => false } as unknown as AgentRunner, events, providers, pricing });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const base = typeof address === "object" && address ? `ws://127.0.0.1:${address.port}` : "";

    events.publish({ source: "session", type: "one", sessionId: "s1", payload: null });
    events.publish({ source: "agent", type: "two", sessionId: "s1", payload: null });

    const collect = (ws: WebSocket, count: number): Promise<AppEvent[]> => new Promise((resolve) => {
      const received: AppEvent[] = [];
      ws.on("message", (data: Buffer) => {
        const event = JSON.parse(data.toString()) as AppEvent;
        if (event.type === "connected") return;
        received.push(event);
        if (received.length === count) resolve(received);
      });
    });

    const replayWs = new WebSocket(`${base}/api/events?after=0&sessionId=s1`);
    const received = await collect(replayWs, 2);
    replayWs.close();
    expect(received.map((e) => e.type)).toEqual(["one", "two"]);

    events.publish({ source: "session", type: "three", sessionId: "s1", payload: null });
    events.publish({ source: "session", type: "four", sessionId: "s1", payload: null });
    const resyncWs = new WebSocket(`${base}/api/events?after=1&sessionId=s1`);
    const resyncType = await new Promise<string>((resolve) => {
      resyncWs.on("message", (data: Buffer) => resolve((JSON.parse(data.toString()) as AppEvent).type));
    });
    resyncWs.close();
    expect(resyncType).toBe("resync.required");
  }, 15_000);
});
