import { describe, expect, it } from "vitest";
import type { LiveSubagentRun } from "../lib/contracts";
import {
  filterHiddenSubagentRuns, filterSubagentRunsByStatus, subagentRunIds,
} from "../lib/subagent-runs";

function run(taskId: string, toolCallId: string, status: LiveSubagentRun["status"]): LiveSubagentRun {
  return { taskId, toolCallId, prompt: taskId, status, turns: 0, toolsUsed: [] };
}

const runs: Record<string, LiveSubagentRun> = {
  t1: run("t1", "call-a", "done"),
  t2: run("t2", "call-b", "running"),
  t3: run("t3", "call-b", "failed"),
};

describe("filterHiddenSubagentRuns", () => {
  it("无隐藏集合时原样返回同一引用（避免下游无谓重渲）", () => {
    expect(filterHiddenSubagentRuns(runs, undefined)).toBe(runs);
    expect(filterHiddenSubagentRuns(runs, {})).toBe(runs);
  });

  it("按 taskId 隐藏单条", () => {
    expect(Object.keys(filterHiddenSubagentRuns(runs, { t1: true }))).toEqual(["t2", "t3"]);
  });

  it("按 toolCallId 隐藏整组（消息推导的历史条目只有 toolCallId 可用作标识）", () => {
    expect(Object.keys(filterHiddenSubagentRuns(runs, { "call-b": true }))).toEqual(["t1"]);
  });
});

describe("filterSubagentRunsByStatus", () => {
  it("all 原样返回；其余按状态筛", () => {
    expect(filterSubagentRunsByStatus(runs, "all")).toBe(runs);
    expect(Object.keys(filterSubagentRunsByStatus(runs, "running"))).toEqual(["t2"]);
    expect(Object.keys(filterSubagentRunsByStatus(runs, "done"))).toEqual(["t1"]);
    expect(Object.keys(filterSubagentRunsByStatus(runs, "failed"))).toEqual(["t3"]);
  });
});

describe("subagentRunIds", () => {
  it("收集 taskId 与 toolCallId 并去重", () => {
    expect(subagentRunIds(runs).sort()).toEqual(["call-a", "call-b", "t1", "t2", "t3"]);
  });
});
