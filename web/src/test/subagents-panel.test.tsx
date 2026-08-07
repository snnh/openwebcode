import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentsPanel } from "../panels/SubagentsPanel";
import { api } from "../lib/api";
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

  it("tabActions.openSubagentTab 注册时在行/组头渲染「在标签中打开」并按 toolCallId 回调；未注册不渲染", () => {
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
  });

  it("tabActions.openSubagentTab 未注册时不渲染「在标签中打开」", () => {
    seedLive("s-1", { "task-1": run({ status: "done" }) });
    const { container } = renderWithClient(<SubagentsPanel sessionId="s-1" />);
    expect(container.querySelector(".subagents-open-tab")).toBeNull();
  });
});
