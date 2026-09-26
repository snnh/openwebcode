import { describe, expect, it } from "vitest";
import type { AppEvent, LiveSubagentRun } from "../lib/contracts";
import { live, liveStore } from "../app/live-store";
function run(taskId: string, toolCallId: string, status: LiveSubagentRun["status"], extra: Partial<LiveSubagentRun> = {}): LiveSubagentRun {
  return { taskId, toolCallId, prompt: `任务 ${taskId}`, status, turns: 1, toolsUsed: [], ...extra };
}
const event = (type: string, payload: Record<string, unknown>): AppEvent => ({ type, sessionId: "s1", payload }) as unknown as AppEvent;
const started = (taskId: string, toolCallId: string): AppEvent => event("subagent.started", { taskId, toolCallId, prompt: `任务 ${taskId}` });
const finished = (taskId: string, status: "done" | "failed"): AppEvent => event("subagent.finished", { taskId, status });
function seed(runs: LiveSubagentRun[]): void {
  liveStore.set({ subagents: { s1: Object.fromEntries(runs.map((entry) => [entry.taskId, entry])) }, hiddenSubagents: {}, spawnedThisRun: {} });
}
describe("子代理运行生命周期（新批次清旧批 / clear 清空）", () => {
  it("新一轮 run 的首次 spawn 清掉上一批终态条目（运行中的保留）并记入隐藏集合；accepted 复位批次标记后再清", () => {
    seed([run("t1", "call-1", "done"), run("t2", "call-2", "failed"), run("t3", "call-3", "running")]);
    live.applySubagentEvent(started("t4", "call-4"));
    const state = liveStore.get();
    expect(Object.keys(state.subagents.s1!).sort()).toEqual(["t3", "t4"]);
    // 被清条目的 taskId 与「整组都已终态」的 toolCallId 记入隐藏集合（挡住消息推导的同批历史条目）
    expect(state.hiddenSubagents.s1).toEqual({ t1: true, t2: true, "call-1": true, "call-2": true }); expect(state.spawnedThisRun.s1).toBe(true);
    seed([]);
    live.applySubagentEvent(started("t1", "call-1")); live.applySubagentEvent(finished("t1", "done"));
    live.applyActivityEvent(event("agent.state", { state: "accepted" }));
    expect(liveStore.get().spawnedThisRun.s1).toBeUndefined();
    live.applySubagentEvent(started("t2", "call-2"));
    expect(Object.keys(liveStore.get().subagents.s1!)).toEqual(["t2"]); expect(liveStore.get().hiddenSubagents.s1).toEqual({ t1: true, "call-1": true });
  });
  it("同一次 run 内多次 spawn 累积不清；同 taskId 的 started 只记一次；部分完成的 swarm 组内仍有运行中条目不按 toolCallId 隐藏", () => {
    seed([]);
    live.applySubagentEvent(started("t1", "call-1")); live.applySubagentEvent(finished("t1", "done")); live.applySubagentEvent(started("t2", "call-2"));
    expect(Object.keys(liveStore.get().subagents.s1!).sort()).toEqual(["t1", "t2"]); expect(liveStore.get().hiddenSubagents.s1).toEqual({});
    seed([]);
    live.applySubagentEvent(started("t5", "call-5")); live.applySubagentEvent(started("t5", "call-5"));
    expect(Object.keys(liveStore.get().subagents.s1!)).toEqual(["t5"]);
    seed([run("t1", "call-swarm", "done", { swarm: { index: 1, total: 2 } }), run("t2", "call-swarm", "running", { swarm: { index: 2, total: 2 } })]);
    live.applySubagentEvent(started("t3", "call-9"));
    expect(Object.keys(liveStore.get().subagents.s1!).sort()).toEqual(["t2", "t3"]); expect(liveStore.get().hiddenSubagents.s1).toEqual({ t1: true });
  });
  it("/clear：清空全部运行（含运行中）并隐藏其 taskId/toolCallId，随后可重新计批", () => {
    seed([]);
    live.applySubagentEvent(started("t1", "call-1")); live.applySubagentEvent(started("t2", "call-2"));
    live.clearSubagentRuns("s1");
    const state = liveStore.get();
    expect(state.subagents.s1).toEqual({});
    expect(state.hiddenSubagents.s1).toEqual({ t1: true, "call-1": true, t2: true, "call-2": true }); expect(state.spawnedThisRun.s1).toBeUndefined();
    live.applySubagentEvent(started("t3", "call-3")); expect(Object.keys(liveStore.get().subagents.s1!)).toEqual(["t3"]);
    // removeSession 一并清掉隐藏集合与批次标记
    live.applySubagentEvent(started("t4", "call-4")); live.removeSession("s1");
    const after = liveStore.get();
    expect(after.subagents.s1).toBeUndefined(); expect(after.hiddenSubagents.s1).toBeUndefined(); expect(after.spawnedThisRun.s1).toBeUndefined();
  });
});
