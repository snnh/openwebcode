import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { buildServer } from "../src/app.js";
import { makeAbortPendingProvider } from "./helpers/agent-harness.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** goal 会话 + 按轮次脚本化回复的 provider：第 N 次请求回复 texts[min(N, len-1)]。 */
async function setupGoal(texts: string[]) {
  const root = await tempRoot("owc-goal-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "goal-stub", model: "model", agentMode: "goal" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const published: AppEvent[] = [];
  events.on("event", (event: AppEvent) => published.push(event));
  const requests: StreamChatRequest[] = [];
  const provider: Provider = {
    name: "goal-stub",
    async *streamChat(request: StreamChatRequest) {
      const turn = requests.length;
      requests.push(request);
      yield { type: "text_delta", text: texts[Math.min(turn, texts.length - 1)]! };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const runner = new AgentRunner(sessions, providers, makeFakeCore(), events, pricing);
  return { sessions, session, runner, requests, published };
}

/** 等待会话所有续跑收敛（不在运行且 run 状态 completed）。 */
async function waitSettled(h: Awaited<ReturnType<typeof setupGoal>>): Promise<void> {
  await vi.waitFor(async () => {
    expect(h.runner.isRunning(h.session.id)).toBe(false);
    expect((await h.runner.getRun(h.session.id))?.state).toBe("completed");
  }, { timeout: 5_000 });
}

describe("goal mode — 自动续跑", () => {
  it("assistant 末行 GOAL_INCOMPLETE → 自动入队续跑，消息带 [goal-continuation] 前缀与理由", async () => {
    const h = await setupGoal(["第一部分完成\nGOAL_INCOMPLETE: 还剩收尾工作", "全部完成\nGOAL_COMPLETE"]);
    await h.runner.run(h.session.id, "实现功能 X");
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    await waitSettled(h);

    // goal 提示词注入：首轮 system 含自评机制说明
    expect(h.requests[0]?.system).toContain("GOAL_INCOMPLETE");
    // 续跑经 follow_up 队列：落盘 user 消息带前缀与自评理由
    const detail = await h.sessions.get(h.session.id);
    const continuation = detail?.messages.find((message) => message.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text.startsWith("[goal-continuation]")));
    expect(continuation).toBeTruthy();
    expect(continuation?.content.some((block) => block.type === "text" && block.text.includes("还剩收尾工作"))).toBe(true);
    // 第二轮 GOAL_COMPLETE → 不再续跑
    expect(h.requests).toHaveLength(2);
  });

  it("GOAL_COMPLETE → 不续跑", async () => {
    const h = await setupGoal(["全部完成\nGOAL_COMPLETE"]);
    await h.runner.run(h.session.id, "实现功能 X");
    await waitSettled(h);
    expect(h.requests).toHaveLength(1);
    expect(await h.runner.listQueue(h.session.id)).toEqual([]);
  });

  it("无自评标记 → 不续跑", async () => {
    const h = await setupGoal(["普通回复，没有标记"]);
    await h.runner.run(h.session.id, "实现功能 X");
    await waitSettled(h);
    expect(h.requests).toHaveLength(1);
    expect(await h.runner.listQueue(h.session.id)).toEqual([]);
  });

  it("续跑计数达 10 → 不再续跑并发布 goal.stopped", async () => {
    const h = await setupGoal(["推进了一点\nGOAL_INCOMPLETE: 还有更多"]);
    await h.runner.run(h.session.id, "长跑目标");
    // 首轮 + 10 次续跑 = 11 次请求后停止
    await vi.waitFor(() => expect(h.requests).toHaveLength(11), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.published.some((event) => event.type === "goal.stopped" &&
      (event.payload as { reason?: string; count?: number }).reason === "max_continuations" &&
      (event.payload as { count?: number }).count === 10)).toBe(true));
    await waitSettled(h);
    expect(h.requests).toHaveLength(11);
  });

  it("abort 的 run → 不续跑", async () => {
    const root = await tempRoot("owc-goal-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "goal-stub", model: "model", agentMode: "goal" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const { provider, entered: firstEntered } = makeAbortPendingProvider("goal-stub");
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, makeFakeCore(), new EventBus(), pricing);

    const running = runner.run(session.id, "实现功能 X");
    await firstEntered;
    expect(runner.abort(session.id)).toBe(true);
    await expect(running).rejects.toBeTruthy();
    // abort 路径不触发自评续跑
    expect(await runner.listQueue(session.id)).toEqual([]);
    const detail = await sessions.get(session.id);
    expect(detail?.messages.some((message) => message.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text.startsWith("[goal-continuation]")))).toBe(false);
  });
});

describe("goal mode — REST 校验", () => {
  async function setupApp() {
    const root = await tempRoot("owc-goal-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* () { yield { type: "done", stopReason: "end_turn" }; }));
    const core = makeFakeCore();
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    return { app, sessions, root };
  }

  // 非法 agentMode → 400 由 plan-mode.test.ts 覆盖，此处只验 goal 特有行为（接受/落盘）
  it("PUT config 接受 goal 并落盘", async () => {
    const { app, sessions, root } = await setupApp();
    const session = await sessions.create({ cwd: root, provider: "test-stub", model: "model" });

    const goal = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "goal" } });
    expect(goal.statusCode).toBe(200);
    expect(JSON.parse(goal.body).agentMode).toBe("goal");
    // goal 像 plan 一样持久化
    expect((await sessions.get(session.id))?.agentMode).toBe("goal");
  });

  it("POST /api/sessions 接受 goal", async () => {
    const { app, root } = await setupApp();
    const goal = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "test-stub", model: "model", agentMode: "goal" } });
    expect(goal.statusCode).toBe(201);
    expect(goal.json<{ agentMode?: string }>().agentMode).toBe("goal");
  });
});
