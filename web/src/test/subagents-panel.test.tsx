import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentsPanel } from "../panels/SubagentsPanel";
import { api } from "../lib/api";
import { capLiveSubagentRuns, deriveSubagentRunsFromMessages, LIVE_SUBAGENT_CAP, mergeSubagentRuns } from "../lib/subagent-runs";
import type { ChatMessage, LiveSubagentRun } from "../lib/contracts";
import { liveStore } from "../app/live-store";
import { tabActions } from "../workbench/tab-actions";
import { makeSession, makeSubagentRun } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

const run = makeSubagentRun;

/** 直接写入 live-store（等价于 WS subagent.* 事件路由后的状态） */
function seedLive(sessionId: string, runs: Record<string, LiveSubagentRun>): void {
  liveStore.set((previous) => ({ subagents: { ...previous.subagents, [sessionId]: runs } }));
}

beforeEach(() => {
  vi.spyOn(api, "session").mockResolvedValue(makeSession({ id: "s-1" }));
  vi.spyOn(api, "agents").mockResolvedValue({ agents: [] });
});

afterEach(() => {
  liveStore.set({ subagents: {} });
  delete tabActions.openSubagentTab;
  vi.restoreAllMocks();
});

describe("SubagentsPanel", () => {
  it("renders a live running row with spinner and progress", () => {
    seedLive("s-1", { "task-1": run({ agent: "scout", status: "running", turns: 2, toolsUsed: ["read_file"] }) });
    const { container } = renderWithClient(<SubagentsPanel sessionId="s-1" />);

    expect(container.querySelector(".subagent-run-agent")).toHaveTextContent("scout");
    expect(container.querySelector(".subagent-run-status")).toHaveTextContent("运行中");
    expect(container.querySelector(".subagent-run-pulse")).toBeInTheDocument();
    expect(container.querySelector(".subagent-run-stats")).toHaveTextContent("第 2 轮 · 已用 read_file");
    expect(container.querySelector(".subagent-run-task")).toHaveTextContent("调查代码结构");
  });

  it("groups swarm items under a header with aggregate counts, showing the error on failed rows", () => {
    seedLive("s-1", {
      "t-1": run({ taskId: "t-1", status: "done", turns: 2, swarm: { index: 1, total: 3 }, agent: "reviewer", prompt: "a.ts" }),
      "t-2": run({ taskId: "t-2", status: "failed", error: "provider boom", swarm: { index: 2, total: 3 }, prompt: "b.ts" }),
      "t-3": run({ taskId: "t-3", status: "running", turns: 1, swarm: { index: 3, total: 3 }, prompt: "c.ts" }),
    });
    const { container } = renderWithClient(<SubagentsPanel sessionId="s-1" />);

    expect(container.querySelector(".subagents-group-header")).toHaveTextContent("Swarm 1 共 3 项 · 完成 1 / 失败 1 / 运行中 1");
    const items = container.querySelectorAll(".subagent-run-item");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute("data-status", "done");
    expect(items[0]!.querySelector(".subagent-run-index")).toHaveTextContent("1/3");
    expect(items[1]).toHaveAttribute("data-status", "failed");
    expect(items[1]!.querySelector(".subagent-run-error")).toHaveTextContent("provider boom");
    expect(items[2]).toHaveAttribute("data-status", "running");
    // 完成与失败行都提供转录折叠（失败子代理的转录服务端同样落盘），运行中行不提供
    expect(items[0]!.querySelector("details.subagent-transcript")).toBeInTheDocument();
    expect(items[1]!.querySelector("details.subagent-transcript")).toBeInTheDocument();
    expect(items[2]!.querySelector("details.subagent-transcript")).not.toBeInTheDocument();
  });

  it("lists newest groups first", () => {
    seedLive("s-1", {
      "task-old": run({ taskId: "task-old", toolCallId: "call-old", status: "done", prompt: "旧任务" }),
      "task-new": run({ taskId: "task-new", toolCallId: "call-new", status: "running", prompt: "新任务" }),
    });
    const { container } = renderWithClient(<SubagentsPanel sessionId="s-1" />);

    const items = container.querySelectorAll(".subagent-run-item");
    expect(items[0]!.querySelector(".subagent-run-task")).toHaveTextContent("新任务");
    expect(items[1]!.querySelector(".subagent-run-task")).toHaveTextContent("旧任务");
  });

  it("从会话消息推导历史运行（无实时事件时填充），实时条目优先", async () => {
    vi.mocked(api.session).mockResolvedValue(makeSession({
      id: "s-1",
      messages: [
        { id: "m-1", role: "assistant", createdAt: "2026-07-30T00:00:00.000Z", content: [{ type: "tool_call", id: "call-1", name: "spawn_task", input: { prompt: "历史任务", agent: "explore" } }] },
        { id: "m-2", role: "tool", createdAt: "2026-07-30T00:00:01.000Z", content: [{ type: "tool_result", toolCallId: "call-1", content: "ok", subagentTasks: [{ taskId: "hist-1", index: 0, status: "done" }] }] },
      ] as ChatMessage[],
    }));
    seedLive("s-1", { "live-1": run({ taskId: "live-1", toolCallId: "call-2", status: "running", prompt: "实时任务" }) });
    const { container } = renderWithClient(<SubagentsPanel sessionId="s-1" />);

    expect(await screen.findByText("历史任务")).toBeInTheDocument();
    const items = container.querySelectorAll(".subagent-run-item");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("data-status", "running");
    expect(items[1]).toHaveAttribute("data-status", "done");
  });

  it("shows the empty state when there are no runs or no session", async () => {
    renderWithClient(<SubagentsPanel sessionId="s-1" />);
    expect(await screen.findByText(/还没有子代理运行记录/)).toBeInTheDocument();

    const { container: noSession } = renderWithClient(<SubagentsPanel />);
    expect(noSession.querySelector(".panel-empty")).toHaveTextContent("还没有子代理运行记录");
  });

  it("「在标签中打开」：注册时行/组头渲染并按 toolCallId 回调；未注册不渲染", () => {
    const openSubagentTab = vi.fn();
    tabActions.openSubagentTab = openSubagentTab;
    seedLive("s-1", {
      "t-1": run({ taskId: "t-1", toolCallId: "call-1", status: "running", prompt: "独立任务" }),
      "t-2": run({ taskId: "t-2", toolCallId: "call-2", status: "running", swarm: { index: 1, total: 2 }, prompt: "a.ts" }),
      "t-3": run({ taskId: "t-3", toolCallId: "call-2", status: "running", swarm: { index: 2, total: 2 }, prompt: "b.ts" }),
    });
    const { container } = renderWithClient(<SubagentsPanel sessionId="s-1" />);

    const buttons = container.querySelectorAll<HTMLButtonElement>(".subagents-open-tab");
    // 单行组在行内、swarm 组在组头各一个（swarm 行不重复渲染）
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(openSubagentTab).toHaveBeenCalledWith("call-2");
    fireEvent.click(buttons[1]!);
    expect(openSubagentTab).toHaveBeenCalledWith("call-1");

    // 未注册时不渲染（复位注册，等价于单测间的 afterEach 隔离）
    delete tabActions.openSubagentTab;
    seedLive("s-1", { "task-1": run({ status: "done" }) });
    const noAction = renderWithClient(<SubagentsPanel sessionId="s-1" />).container;
    expect(noAction.querySelector(".subagents-open-tab")).toBeNull();
  });
});

function message(id: string, role: ChatMessage["role"], content: ChatMessage["content"]): ChatMessage {
  return { id, role, content, createdAt: "2026-07-20T00:00:00.000Z" };
}

describe("deriveSubagentRunsFromMessages", () => {
  it("derives a done subagent run from tool_call + tool_result", () => {
    const messages = [
      message("m-1", "assistant", [{ type: "tool_call", id: "call-1", name: "subagent", input: { prompt: "调查 a.ts", agent: "scout" } }]),
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

  it("derives a failed subagent run from subagentTasks on an error result (failure after start)", () => {
    const messages = [
      message("m-1", "assistant", [{ type: "tool_call", id: "call-1", name: "subagent", input: { prompt: "调查 a.ts" } }]),
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
  it("capLiveSubagentRuns：超限逐出最旧、限量内原引用、默认 100", () => {
    // 超限逐出最旧条目，保持插入顺序
    const runs: Record<string, LiveSubagentRun> = {};
    for (let i = 1; i <= 5; i += 1) runs[`task-${i}`] = run({ taskId: `task-${i}` });

    const capped = capLiveSubagentRuns(runs, 3);

    expect(Object.keys(capped)).toEqual(["task-3", "task-4", "task-5"]);

    // 限量内保持原引用不变
    const few = { "task-1": run({}) };
    expect(capLiveSubagentRuns(few, 3)).toBe(few);

    // 缺省上限为 LIVE_SUBAGENT_CAP (100)
    const many: Record<string, LiveSubagentRun> = {};
    for (let i = 1; i <= LIVE_SUBAGENT_CAP + 2; i += 1) many[`task-${i}`] = run({ taskId: `task-${i}` });

    const defaultCapped = capLiveSubagentRuns(many);

    expect(Object.keys(defaultCapped)).toHaveLength(LIVE_SUBAGENT_CAP);
    expect(defaultCapped["task-1"]).toBeUndefined();
    expect(defaultCapped[`task-${LIVE_SUBAGENT_CAP + 2}`]).toBeDefined();
  });
});
