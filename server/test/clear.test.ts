import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { ContextManager } from "../src/context/context-manager.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function manager(): Promise<ContextManager> {
  return new ContextManager(await tempRoot("owc-clear-"));
}

async function clearApp(rootPrefix = "owc-clear-http-") {
  const root = await tempRoot(rootPrefix);
  const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus(); const observed: AppEvent[] = [];
  events.on("event", (event: AppEvent) => observed.push(event));
  const core = { on() { return core; } } as unknown as CoreClient;
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  apps.push(app);
  return { root, sessions, agent, app, observed };
}

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    createdAt: new Date(index * 1000).toISOString(),
    content: [{ type: "text", text: `message ${index}` }],
  }));
}

describe("ContextManager clear boundary", () => {
  it("keeps history but excludes the cleared prefix from the model view", async () => {
    const context = await manager();
    const history = messages(4);
    const ledger = await context.markCleared(3);
    expect(ledger.cleared).toMatchObject({ uptoIndex: 3 });
    expect((await context.buildView(history)).messages.map((message) => message.id)).toEqual(["m3"]);
    expect(history).toHaveLength(4);
  });

  it("uses the later compact or clear boundary without leaking an older summary", async () => {
    const context = await manager();
    const base = await context.load();
    await context.replaceLedger({ ...base, compacted: { uptoIndex: 2, mode: "overview", summary: "old secret", instructions: [], createdAt: new Date().toISOString() }, cleared: { uptoIndex: 4, at: new Date().toISOString() } });
    const clearedView = await context.buildView(messages(6));
    expect(clearedView.messages.map((message) => message.id)).toEqual(["m4", "m5"]);
    expect(JSON.stringify(clearedView.messages)).not.toContain("old secret");

    await context.replaceLedger({ ...base, compacted: { uptoIndex: 5, mode: "overview", summary: "new summary", instructions: [], createdAt: new Date().toISOString() }, cleared: { uptoIndex: 3, at: new Date().toISOString() } });
    const compactedView = await context.buildView(messages(6));
    expect(compactedView.messages[0]?.id).toMatch(/^compaction:/);
    expect(compactedView.messages.at(-1)?.id).toBe("m5");
  });

  it("normalizes malformed clear records and replaceLedger restores an earlier boundary", async () => {
    const context = await manager();
    const original = await context.load();
    await context.replaceLedger({ ...original, cleared: { uptoIndex: -1, at: 3 } });
    expect((await context.load()).cleared).toBeUndefined();
    await context.markCleared(3);
    expect((await context.load()).cleared?.uptoIndex).toBe(3);
    await context.replaceLedger(original);
    expect((await context.load()).cleared).toBeUndefined();
    expect((await context.buildView(messages(3))).messages).toHaveLength(3);
  });
});

describe("/clear checkpoint restore", () => {
  it("restoring a checkpoint taken before /clear rewinds the clear boundary", async () => {
    const { sessions, app, observed } = await clearApp("owc-clear-restore-");
    const workspace = await tempRoot("owc-clear-ws-");
    const session = await sessions.create({ cwd: workspace, title: "Clear restore" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "old question" }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "old answer" }]);
    const checkpoint = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "pre-clear" } });
    expect(checkpoint.statusCode).toBe(201);
    const checkpointId = checkpoint.json<{ id: string }>().id;

    const cleared = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(cleared.statusCode).toBe(200);
    const history = (await sessions.get(session.id))!.messages;
    expect((await new ContextManager(sessions.contextRoot(session.id)).buildView(history)).messages).toEqual([]);

    const restored = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${checkpointId}/restore`, payload: { confirm: true } });
    expect(restored.statusCode, restored.body).toBe(200);
    const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
    expect(ledger.cleared).toBeUndefined();
    const view = await new ContextManager(sessions.contextRoot(session.id)).buildView(history);
    expect(view.messages.map((message) => message.id)).toEqual(history.map((message) => message.id));
    expect(observed.some((event) => event.type === "checkpoint.restored")).toBe(true);
  }, 30_000);
});

describe("/clear composer command", () => {
  it("marks the current message boundary without changing history or starting the agent", async () => {
    const { root, sessions, agent, app, observed } = await clearApp();
    const session = await sessions.create({ cwd: root, title: "Clear route" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "keep me" }]);
    const before = (await sessions.get(session.id))!.messages;
    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, cleared: true, uptoIndex: 1 });
    expect((await sessions.get(session.id))!.messages).toEqual(before);
    expect(agent.isRunning(session.id)).toBe(false);
    expect(observed.find((event) => event.type === "context.cleared")?.payload).toMatchObject({ uptoIndex: 1 });
    expect((await new ContextManager(sessions.contextRoot(session.id)).buildView(before)).messages).toEqual([]);
    vi.spyOn(agent, "isRunning").mockReturnValue(true);
    const running = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(running.statusCode).toBe(409);
  });

  it("uptoIndex 用活动路径长度：存在离路径分支消息时 /clear 后新消息仍进视图", async () => {
    const { root, sessions, app, observed } = await clearApp();
    const session = await sessions.create({ cwd: root, title: "Clear with branches" });
    const m1 = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "q1" }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "a1" }]);
    // 制造分支：checkout 回 m1 再追加，旧 a1 成为离路径消息（全量 3 条，活动路径 2 条）
    await sessions.setActiveLeaf(session.id, m1.id);
    const retry = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "a1-retry" }]);
    const before = (await sessions.get(session.id))!;
    expect(before.messages).toHaveLength(3);
    expect(activePathMessages(before.messages, before.activeLeafId)).toHaveLength(2);

    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(response.statusCode).toBe(200);
    // uptoIndex 仍为活动路径长度（agent 视图/compactor 同口径）；uptoMessageId 锚定最后一条活动路径消息
    expect(response.json()).toMatchObject({ cleared: true, uptoIndex: 2, uptoMessageId: retry.id });
    expect(observed.find((event) => event.type === "context.cleared")?.payload).toMatchObject({ uptoIndex: 2, uptoMessageId: retry.id });

    // REST context 视图（buildView 输入为全量 JSONL，含离路径消息）也必须全清：
    // 仅靠活动路径长度换算全量下标会残留尾部消息（分隔线提早插入的根因）
    const restView = await new ContextManager(sessions.contextRoot(session.id)).buildView(before.messages);
    expect(restView.messages).toEqual([]);

    // 回归断言：/clear 后追加的新消息必须出现在视图中
    // （修复前 uptoIndex=3 > 活动路径长度，会把之后所有消息一并清出视图，模型看不到任何用户消息）
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "q2" }]);
    const after = (await sessions.get(session.id))!;
    const path = activePathMessages(after.messages, after.activeLeafId);
    const view = await new ContextManager(sessions.contextRoot(session.id)).buildView(path);
    expect(view.messages.map((message) => message.content[0])).toEqual([{ type: "text", text: "q2" }]);
    // 全量空间的 REST 视图同样只含新消息：分隔线对应边界 = 最后一条活动路径消息之后
    const restAfter = await new ContextManager(sessions.contextRoot(session.id)).buildView(after.messages);
    expect(restAfter.messages.map((message) => message.content[0])).toEqual([{ type: "text", text: "q2" }]);
  });
});
