import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunControl } from "../src/agent/run-control.js";
import type { EventBus } from "../src/events/event-bus.js";
import { EventBus as EventBusImpl } from "../src/events/event-bus.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * RunControl 单测（goal 续跑计数 / follow-up 队列回收 / ask_user 等待竞态）。
 * 一律用真实 SessionStore + MessageQueue（queue.json/interactions.json 走真实落盘），只有 run 回调按用例替换。
 */
async function makeControl(prefix: string) {
  const root = await tempRoot(prefix);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test", model: "test-model" });
  const events: EventBus = new EventBusImpl();
  const observed: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event) => observed.push({ type: event.type, payload: event.payload }));
  const running = new Map<string, AbortController>();
  let runImpl: (sessionId: string, text: string, options: { queueItemId: string }) => Promise<void> = async () => undefined;
  const control = new RunControl({
    sessions,
    events,
    running,
    settling: new Set<string>(),
    run: (sessionId, text, options) => runImpl(sessionId, text, options),
    notify: async () => undefined,
  });
  return {
    sessions,
    session,
    observed,
    running,
    control,
    setRun: (impl: typeof runImpl) => { runImpl = impl; },
    queuedFollowUps: async () => (await control.listQueue(session.id)).filter((item) => item.kind === "follow_up"),
  };
}

const GOAL_INCOMPLETE_ASSISTANT = "还剩收尾工作\nGOAL_INCOMPLETE: 还有两条测试没修";

/** 造一条「目标 + N 次续跑」的活动路径，每次续跑前都插一条 run 启动注入（inj:goal:full）。 */
async function seedGoalPath(sessions: SessionStore, sessionId: string, continuations: number): Promise<void> {
  await sessions.appendMessage(sessionId, "user", [{ type: "text", text: "目标：把 agent 域的 bug 修完" }]);
  for (let index = 0; index < continuations; index += 1) {
    await sessions.appendMessage(sessionId, "user", [{ type: "text", text: "<system-reminder>\nGOAL mode\n</system-reminder>" }], {
      id: `inj:goal:full:${index}`,
      internal: true,
    });
    await sessions.appendMessage(sessionId, "user", [{ type: "text", text: `[goal-continuation] 目标自评未完成（第 ${index + 1} 次）` }]);
    await sessions.appendMessage(sessionId, "assistant", [{ type: "text", text: GOAL_INCOMPLETE_ASSISTANT }]);
  }
}

describe("RunControl goal 模式自动续跑计数（注入消息不打断计数）", () => {
  it("9 次续跑后仍追加；10 次达到上限时不再追加并发布 goal.stopped", async () => {
    const atNine = await makeControl("owc-goal-count-");
    await atNine.sessions.updateConfig(atNine.session.id, { provider: "test", model: "test-model", agentMode: "goal" });
    await seedGoalPath(atNine.sessions, atNine.session.id, 9);
    atNine.running.set(atNine.session.id, new AbortController());
    await atNine.control.maybeScheduleGoalContinuation(atNine.session.id);
    expect(await atNine.queuedFollowUps()).toMatchObject([{ status: "queued", content: expect.stringContaining("[goal-continuation]") }]);

    const atTen = await makeControl("owc-goal-max-");
    await atTen.sessions.updateConfig(atTen.session.id, { provider: "test", model: "test-model", agentMode: "goal" });
    // 每轮 run 启动注入（inj:goal:full）都要被跳过，否则计数被截断为 1、上限失效
    await seedGoalPath(atTen.sessions, atTen.session.id, 10);
    atTen.running.set(atTen.session.id, new AbortController());
    await atTen.control.maybeScheduleGoalContinuation(atTen.session.id);
    expect(await atTen.queuedFollowUps()).toHaveLength(0);
    expect(atTen.observed.find((event) => event.type === "goal.stopped")?.payload).toMatchObject({ reason: "max_continuations", count: 10 });
  });
});

describe("RunControl follow-up 消费失败回收", () => {
  it("run() 的三互斥守卫抛错时队列项回到 queued（不永久卡 consuming，内容不丢）", async () => {
    const { session, running, control, observed, setRun, queuedFollowUps } = await makeControl("owc-follow-up-requeue-");
    running.set(session.id, new AbortController());
    await control.enqueueFollowUp(session.id, "继续下一步");
    running.clear();

    // 模拟 run() 在 try 之外抛错（running/shells/workspaceWrites 守卫路径）
    setRun(async () => { throw new Error("A shell command is pending; respond to its permission request first"); });
    await control.startFollowUp(session.id);

    await vi.waitFor(async () => expect(await queuedFollowUps()).toMatchObject([{ status: "queued", content: "继续下一步" }]));
    expect(observed.some((event) => event.type === "queue.run_failed")).toBe(true);
  });
});

describe("RunControl ask_user 等待竞态", () => {
  it("应答先于 waiter 注册落盘不会永久挂起；abort 后注册的 waiter 立即以 cancelled 结算且不留悬挂条目", async () => {
    const { sessions, session, control } = await makeControl("owc-interaction-race-");
    const interaction = await control.createInteraction(session.id, { runId: "run-1", kind: "confirm", title: "确认", prompt: "继续吗？" });

    // 白盒卡住 list，强制制造「respond 落在 list 读取与 waiter 注册之间」的窗口（修复前该窗口会漏掉应答）
    const coordinator = (control as unknown as { interactions: { list: (sessionId: string) => Promise<unknown[]> } }).interactions;
    const realList = coordinator.list.bind(coordinator);
    let snapshot: unknown[] | undefined;
    let releaseList!: () => void;
    const gate = new Promise<void>((resolve) => { releaseList = resolve; });
    coordinator.list = async (sessionId: string) => {
      snapshot ??= await realList(sessionId);
      await gate;
      return snapshot;
    };

    const waiting = control.waitForInteractionAnswer(session.id, interaction.id, new AbortController().signal);
    await vi.waitFor(() => expect(snapshot).toBeDefined());
    await control.respondInteraction(session.id, interaction.id, "ok");
    releaseList();
    const outcome = await Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    expect(outcome).toEqual({ cancelled: false, answer: "ok" });
    expect(await sessions.get(session.id)).toBeDefined();

    const aborted = new AbortController();
    aborted.abort();
    await expect(control.waitForInteractionAnswer(session.id, interaction.id, aborted.signal)).resolves.toEqual({ cancelled: true });
    expect((control as unknown as { interactionWaiters: Map<string, unknown> }).interactionWaiters.size).toBe(0);
  });
});
