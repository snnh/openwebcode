import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent, LiveSubagentRun } from "../lib/contracts";
import { live, liveStore } from "../app/live-store";

function run(taskId: string, toolCallId: string, status: LiveSubagentRun["status"], extra: Partial<LiveSubagentRun> = {}): LiveSubagentRun {
  return { taskId, toolCallId, prompt: `任务 ${taskId}`, status, turns: 1, toolsUsed: [], ...extra };
}

function event(type: string, sessionId: string, payload: Record<string, unknown>): AppEvent {
  return { type, sessionId, payload } as unknown as AppEvent;
}

const started = (taskId: string, toolCallId: string, extra: Record<string, unknown> = {}): AppEvent =>
  event("subagent.started", "s1", { taskId, toolCallId, prompt: `任务 ${taskId}`, ...extra });

const finished = (taskId: string, status: "done" | "failed"): AppEvent =>
  event("subagent.finished", "s1", { taskId, status });

function seed(runs: LiveSubagentRun[]): void {
  liveStore.set({
    subagents: { s1: Object.fromEntries(runs.map((entry) => [entry.taskId, entry])) },
    hiddenSubagents: {},
    spawnedThisRun: {},
  });
}

describe("子代理运行生命周期（新批次清旧批 / clear 清空）", () => {
  beforeEach(() => {
    seed([]);
  });

  it("新一轮 run 的首次 spawn：清掉上一批已终态条目，运行中的保留", () => {
    seed([run("t1", "call-1", "done"), run("t2", "call-2", "failed"), run("t3", "call-3", "running")]);
    live.applySubagentEvent(started("t4", "call-4"));

    const state = liveStore.get();
    expect(Object.keys(state.subagents.s1!).sort()).toEqual(["t3", "t4"]);
    // 被清条目的 taskId 与「整组都已终态」的 toolCallId 记入隐藏集合（挡住消息推导的同批历史条目）
    expect(state.hiddenSubagents.s1).toEqual({ t1: true, t2: true, "call-1": true, "call-2": true });
    expect(state.spawnedThisRun.s1).toBe(true);
  });

  it("同一次 run 内的第二次 spawn 不清（批次内累积）", () => {
    seed([]);
    live.applySubagentEvent(started("t1", "call-1"));
    live.applySubagentEvent(finished("t1", "done"));
    live.applySubagentEvent(started("t2", "call-2"));

    const state = liveStore.get();
    expect(Object.keys(state.subagents.s1!).sort()).toEqual(["t1", "t2"]);
    expect(state.hiddenSubagents.s1).toEqual({});
  });

  it("新一轮 run（agent.state=accepted）后再次 spawn → 清掉上一轮终态条目", () => {
    seed([]);
    live.applySubagentEvent(started("t1", "call-1"));
    live.applySubagentEvent(finished("t1", "done"));
    live.applyActivityEvent(event("agent.state", "s1", { state: "accepted" }));
    expect(liveStore.get().spawnedThisRun.s1).toBeUndefined();

    live.applySubagentEvent(started("t2", "call-2"));
    const state = liveStore.get();
    expect(Object.keys(state.subagents.s1!)).toEqual(["t2"]);
    expect(state.hiddenSubagents.s1).toEqual({ t1: true, "call-1": true });
  });

  it("部分完成的 swarm：组内仍有运行中条目时不按 toolCallId 隐藏（否则会连带隐藏运行中的那个）", () => {
    seed([run("t1", "call-swarm", "done", { swarm: { index: 1, total: 2 } }), run("t2", "call-swarm", "running", { swarm: { index: 2, total: 2 } })]);
    live.applySubagentEvent(started("t3", "call-9"));

    const state = liveStore.get();
    expect(Object.keys(state.subagents.s1!).sort()).toEqual(["t2", "t3"]);
    expect(state.hiddenSubagents.s1).toEqual({ t1: true });
  });

  it("/clear（clearSubagentRuns）：清空全部运行（含运行中）并隐藏其 taskId/toolCallId，随后可重新计批", () => {
    seed([]);
    live.applySubagentEvent(started("t1", "call-1"));
    live.applySubagentEvent(started("t2", "call-2"));
    live.clearSubagentRuns("s1");

    const state = liveStore.get();
    expect(state.subagents.s1).toEqual({});
    expect(state.hiddenSubagents.s1).toEqual({ t1: true, "call-1": true, t2: true, "call-2": true });
    expect(state.spawnedThisRun.s1).toBeUndefined();

    // /clear 之后的新一批：清空不留历史，首个 spawn 不必再清（也不该清掉新批次）
    live.applySubagentEvent(started("t3", "call-3"));
    expect(Object.keys(liveStore.get().subagents.s1!)).toEqual(["t3"]);
  });

  it("removeSession 一并清掉隐藏集合与批次标记", () => {
    seed([run("t1", "call-1", "done")]);
    live.applySubagentEvent(started("t2", "call-2"));
    live.removeSession("s1");
    const state = liveStore.get();
    expect(state.subagents.s1).toBeUndefined();
    expect(state.hiddenSubagents.s1).toBeUndefined();
    expect(state.spawnedThisRun.s1).toBeUndefined();
  });

  it("同一 taskId 的 started 事件只记一次（不重复计入隐藏集合）", () => {
    seed([]);
    const onStarted = vi.fn();
    live.applySubagentEvent(started("t1", "call-1"), onStarted);
    live.applySubagentEvent(started("t1", "call-1"), onStarted);
    expect(onStarted).toHaveBeenCalledTimes(2);
    expect(Object.keys(liveStore.get().subagents.s1!)).toEqual(["t1"]);
    expect(liveStore.get().hiddenSubagents.s1).toEqual({});
  });
});
