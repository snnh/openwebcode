import { describe, expect, it } from "vitest";
import { capLiveSubagentRuns, deriveSubagentRunsFromMessages, LIVE_SUBAGENT_CAP, mergeSubagentRuns } from "../lib/subagent-runs";
import type { ChatMessage, LiveSubagentRun } from "../lib/contracts";
import { makeSubagentRun } from "./helpers/fixtures";

const run = makeSubagentRun;

function message(id: string, role: ChatMessage["role"], content: ChatMessage["content"]): ChatMessage {
  return { id, role, content, createdAt: "2026-07-20T00:00:00.000Z" };
}

describe("deriveSubagentRunsFromMessages", () => {
  it("derives a done spawn_task run from tool_call + tool_result", () => {
    const messages = [
      message("m-1", "assistant", [{ type: "tool_call", id: "call-1", name: "spawn_task", input: { prompt: "调查 a.ts", agent: "scout" } }]),
      message("m-2", "tool", [{ type: "tool_result", toolCallId: "call-1", content: "结论", isError: false, subagentTaskIds: ["task-1"] }]),
    ];

    const runs = deriveSubagentRunsFromMessages(messages);

    expect(Object.keys(runs)).toEqual(["task-1"]);
    expect(runs["task-1"]).toMatchObject({
      taskId: "task-1",
      toolCallId: "call-1",
      prompt: "调查 a.ts",
      agent: "scout",
      status: "done",
      turns: 0,
      toolsUsed: [],
    });
    expect(runs["task-1"]!.swarm).toBeUndefined();
  });

  it("derives swarm runs with per-item index/agent and marks isError results failed", () => {
    const messages = [
      message("m-1", "assistant", [{
        type: "tool_call",
        id: "call-1",
        name: "spawn_swarm",
        input: { prompt_template: "评审 {{item}}", items: [{ task: "a.ts", agent: "reviewer" }, "b.ts"], agent: "scout" },
      }]),
      message("m-2", "tool", [{ type: "tool_result", toolCallId: "call-1", content: "boom happened", isError: true, subagentTaskIds: ["t-1", "t-2"] }]),
    ];

    const runs = deriveSubagentRunsFromMessages(messages);

    expect(Object.keys(runs)).toEqual(["t-1", "t-2"]);
    expect(runs["t-1"]).toMatchObject({ swarm: { index: 1, total: 2 }, prompt: "a.ts", agent: "reviewer", status: "failed", error: "boom happened" });
    // 第 2 项无 agent 覆盖，回退到调用级 scout
    expect(runs["t-2"]).toMatchObject({ swarm: { index: 2, total: 2 }, prompt: "b.ts", agent: "scout", status: "failed" });
  });

  it("ignores non-spawn tools and tool_results without a matching spawn call", () => {
    const messages = [
      message("m-1", "assistant", [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.ts" } }]),
      message("m-2", "tool", [{ type: "tool_result", toolCallId: "call-1", content: "内容", subagentTaskIds: ["task-x"] }]),
      message("m-3", "tool", [{ type: "tool_result", toolCallId: "call-unknown", content: "孤儿", subagentTaskIds: ["task-y"] }]),
    ];

    expect(deriveSubagentRunsFromMessages(messages)).toEqual({});
  });

  it("prefers per-item subagentTasks over the isError heuristic (partial swarm failure)", () => {
    const messages = [
      message("m-1", "assistant", [{
        type: "tool_call",
        id: "call-1",
        name: "spawn_swarm",
        input: { prompt_template: "评审 {{item}}", items: [{ task: "a.ts", agent: "reviewer" }, "b.ts"], agent: "scout" },
      }]),
      message("m-2", "tool", [{
        type: "tool_result",
        toolCallId: "call-1",
        content: "[1/2] 结论：评审 a.ts\n\n[2/2] FAILED: provider boom",
        isError: false,
        subagentTaskIds: ["t-1", "t-2"],
        subagentTasks: [
          { taskId: "t-1", index: 0, status: "done" },
          { taskId: "t-2", index: 1, status: "failed", error: "provider boom" },
        ],
      }]),
    ];

    const runs = deriveSubagentRunsFromMessages(messages);

    // 部分失败：逐项状态独立，swarm 序号取显式 index，agent 覆盖按 item 对齐
    expect(Object.keys(runs)).toEqual(["t-1", "t-2"]);
    expect(runs["t-1"]).toMatchObject({ status: "done", swarm: { index: 1, total: 2 }, prompt: "a.ts", agent: "reviewer" });
    expect(runs["t-2"]).toMatchObject({ status: "failed", error: "provider boom", swarm: { index: 2, total: 2 }, prompt: "b.ts", agent: "scout" });
  });

  it("derives a failed spawn_task run from subagentTasks on an error result (failure after start)", () => {
    const messages = [
      message("m-1", "assistant", [{ type: "tool_call", id: "call-1", name: "spawn_task", input: { prompt: "调查 a.ts" } }]),
      message("m-2", "tool", [{
        type: "tool_result",
        toolCallId: "call-1",
        content: "provider boom",
        isError: true,
        subagentTaskIds: ["task-1"],
        subagentTasks: [{ taskId: "task-1", index: 0, status: "failed", error: "provider boom" }],
      }]),
    ];

    const runs = deriveSubagentRunsFromMessages(messages);

    expect(runs["task-1"]).toMatchObject({ taskId: "task-1", toolCallId: "call-1", prompt: "调查 a.ts", status: "failed", error: "provider boom" });
    expect(runs["task-1"]!.swarm).toBeUndefined();
  });
});

describe("mergeSubagentRuns", () => {
  it("live entries win over derived ones; derived fills the rest", () => {
    const live = { "task-1": run({ taskId: "task-1", status: "running", turns: 3, toolsUsed: ["grep"] }) };
    const derived = {
      "task-1": run({ taskId: "task-1", status: "done", turns: 0 }),
      "task-2": run({ taskId: "task-2", toolCallId: "call-2", status: "done" }),
    };

    const merged = mergeSubagentRuns(live, derived);

    expect(Object.keys(merged).sort()).toEqual(["task-1", "task-2"]);
    expect(merged["task-1"]).toMatchObject({ status: "running", turns: 3, toolsUsed: ["grep"] });
    expect(merged["task-2"]).toMatchObject({ status: "done" });
  });
});

describe("capLiveSubagentRuns", () => {
  it("evicts the oldest entries beyond the cap, keeping insertion order", () => {
    const runs: Record<string, LiveSubagentRun> = {};
    for (let i = 1; i <= 5; i += 1) runs[`task-${i}`] = run({ taskId: `task-${i}` });

    const capped = capLiveSubagentRuns(runs, 3);

    expect(Object.keys(capped)).toEqual(["task-3", "task-4", "task-5"]);
  });

  it("keeps the map unchanged when within the cap", () => {
    const runs = { "task-1": run({}) };
    expect(capLiveSubagentRuns(runs, 3)).toBe(runs);
  });

  it("default cap is LIVE_SUBAGENT_CAP (100)", () => {
    const runs: Record<string, LiveSubagentRun> = {};
    for (let i = 1; i <= LIVE_SUBAGENT_CAP + 2; i += 1) runs[`task-${i}`] = run({ taskId: `task-${i}` });

    const capped = capLiveSubagentRuns(runs);

    expect(Object.keys(capped)).toHaveLength(LIVE_SUBAGENT_CAP);
    expect(capped["task-1"]).toBeUndefined();
    expect(capped[`task-${LIVE_SUBAGENT_CAP + 2}`]).toBeDefined();
  });
});
