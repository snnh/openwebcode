import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunControl } from "../src/agent/run-control.js";
import type { EventBus } from "../src/events/event-bus.js";
import { EventBus as EventBusImpl } from "../src/events/event-bus.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * RunControl 单测（goal 续跑计数 / follow-up 队列回收 / ask_user 等待竞态）。
 * 一律用真实 SessionStore + MessageQueue（queue.json/interactions.json 走真实落盘），
 * 只有 run 回调按用例替换。
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
  const settling = new Set<string>();
  let runImpl: (sessionId: string, text: string, options: { queueItemId: string }) => Promise<void> = async () => undefined;
  const control = new RunControl({
    sessions,
    events,
    running,
    settling,
    run: (sessionId, text, options) => runImpl(sessionId, text, options),
    notify: async () => undefined,
  });
  return {
    root,
    sessions,
    session,
    events,
    observed,
    running,
    control,
    setRun: (impl: typeof runImpl) => { runImpl = impl; },
  };
}

const GOAL_INCOMPLETE_ASSISTANT = "还剩收尾工作\nGOAL_INCOMPLETE: 还有两条测试没修";

/** 造一条「目标 + N 次续跑」的活动路径，每次续跑前都插一条 run 启动注入（inj:goal:full）。 */
async function seedGoalPath(sessions: SessionStore, sessionId: string, continuations: number): Promise<void> {
  await sessions.appendMessage(sessionId, "user", [{ type: "text", text: "目标：把 agent 域的 bug 修完" }]);
  for (let index = 0; index < continuations; index += 1) {
    // run 启动注入（user 角色、inj: 前缀）夹在普通用户消息与续跑消息之间
    await sessions.appendMessage(sessionId, "user", [{ type: "text", text: "<system-reminder>\nGOAL mode\n</system-reminder>" }], {
      id: `inj:goal:full:${index}`,
      internal: true,
    });
    await sessions.appendMessage(sessionId, "user", [{ type: "text", text: `[goal-continuation] 目标自评未完成（第 ${index + 1} 次）` }]);
    await sessions.appendMessage(sessionId, "assistant", [{ type: "text", text: GOAL_INCOMPLETE_ASSISTANT }]);
  }
}

describe("RunControl goal 模式自动续跑计数（注入消息不打断计数）", () => {
  it("已续跑 9 次（每次夹一条 inj:goal:full）：仍追加一轮续跑", async () => {
    const { sessions, session, running, control } = await makeControl("owc-goal-count-");
    await sessions.updateConfig(session.id, { provider: "test", model: "test-model", agentMode: "goal" });
    await seedGoalPath(sessions, session.id, 9);
    running.set(session.id, new AbortController());

    await control.maybeScheduleGoalContinuation(session.id);

    const queued = (await control.listQueue(session.id)).filter((item) => item.kind === "follow_up" && item.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content.startsWith("[goal-continuation]")).toBe(true);
  });

  it("已续跑 10 次：达到上限，不再追加并发布 goal.stopped", async () => {
    const { sessions, session, running, control, observed } = await makeControl("owc-goal-max-");
    await sessions.updateConfig(session.id, { provider: "test", model: "test-model", agentMode: "goal" });
    // 每轮 run 启动注入（inj:goal:full）都要被跳过，否则计数被截断为 1、上限失效
    await seedGoalPath(sessions, session.id, 10);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: GOAL_INCOMPLETE_ASSISTANT }]);
    running.set(session.id, new AbortController());

    await control.maybeScheduleGoalContinuation(session.id);

    expect((await control.listQueue(session.id)).filter((item) => item.kind === "follow_up" && item.status === "queued")).toHaveLength(0);
    const stopped = observed.find((event) => event.type === "goal.stopped");
    expect(stopped?.payload).toMatchObject({ reason: "max_continuations", count: 10 });
  });
});

describe("RunControl follow-up 消费失败回收", () => {
  it("run() 的三互斥守卫抛错时队列项回到 queued（不永久卡 consuming）", async () => {
    const { session, running, control, observed, setRun } = await makeControl("owc-follow-up-requeue-");
    running.set(session.id, new AbortController());
    await control.enqueueFollowUp(session.id, "继续下一步");
    running.clear();

    // 模拟 run() 在 try 之外抛错（running/shells/workspaceWrites 守卫路径）
    setRun(async () => { throw new Error("A shell command is pending; respond to its permission request first"); });
    await control.startFollowUp(session.id);

    await vi.waitFor(async () => {
      const items = (await control.listQueue(session.id)).filter((item) => item.kind === "follow_up");
      expect(items).toHaveLength(1);
      expect(items[0]!.status).toBe("queued");
    });
    expect(observed.some((event) => event.type === "queue.run_failed")).toBe(true);
    // 内容不丢：仍可被下一次 startFollowUp 消费
    expect((await control.listQueue(session.id)).filter((item) => item.kind === "follow_up")[0]!.content).toBe("继续下一步");
  });
});

describe("RunControl ask_user 等待竞态", () => {
  it("应答先于 waiter 注册落盘时不会永久挂起", async () => {
    const { sessions, session, control } = await makeControl("owc-interaction-race-");
    const interaction = await control.createInteraction(session.id, { runId: "run-1", kind: "confirm", title: "确认", prompt: "继续吗？" });

    // 白盒：把 list 卡在应答之前的 pending 快照上，强制制造「respond 落在 list 读取与
    // waiter 注册之间」的窗口（修复前该窗口会漏掉应答并永久挂起）。
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
  });

  it("abort 后注册的 waiter 立即以 cancelled 结算，且不留悬挂条目", async () => {
    const { control, session } = await makeControl("owc-interaction-abort-");
    const interaction = await control.createInteraction(session.id, { runId: "run-1", kind: "confirm", title: "确认", prompt: "继续吗？" });
    const controller = new AbortController();
    controller.abort();

    await expect(control.waitForInteractionAnswer(session.id, interaction.id, controller.signal)).resolves.toEqual({ cancelled: true });
    const waiters = (control as unknown as { interactionWaiters: Map<string, unknown> }).interactionWaiters;
    expect(waiters.size).toBe(0);
  });
});
