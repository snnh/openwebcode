import { describe, expect, it } from "vitest";
import type { LiveSubagentRun } from "../lib/contracts";
import { filterHiddenSubagentRuns, filterSubagentRunsByStatus, subagentRunIds } from "../lib/subagent-runs";
const run = (taskId: string, toolCallId: string, status: LiveSubagentRun["status"]): LiveSubagentRun => ({ taskId, toolCallId, prompt: taskId, status, turns: 0, toolsUsed: [] });
const runs: Record<string, LiveSubagentRun> = { t1: run("t1", "call-a", "done"), t2: run("t2", "call-b", "running"), t3: run("t3", "call-b", "failed") };
describe("子代理运行过滤", () => {
  it("无隐藏集合原样返回同一引用（避免下游无谓重渲）；隐藏集合按 taskId 隐藏单条、按 toolCallId 隐藏整组；状态筛 all 原样返回、其余按状态过滤；subagentRunIds 收集 taskId 与 toolCallId 并去重", () => {
    expect(filterHiddenSubagentRuns(runs, undefined)).toBe(runs); expect(filterHiddenSubagentRuns(runs, {})).toBe(runs);
    expect(Object.keys(filterHiddenSubagentRuns(runs, { t1: true }))).toEqual(["t2", "t3"]);
    expect(Object.keys(filterHiddenSubagentRuns(runs, { "call-b": true }))).toEqual(["t1"]);
    expect(filterSubagentRunsByStatus(runs, "all")).toBe(runs);
    expect(Object.keys(filterSubagentRunsByStatus(runs, "running"))).toEqual(["t2"]);
    expect(Object.keys(filterSubagentRunsByStatus(runs, "failed"))).toEqual(["t3"]);
    expect(subagentRunIds(runs).sort()).toEqual(["call-a", "call-b", "t1", "t2", "t3"]);
  });
});
