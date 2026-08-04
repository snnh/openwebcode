import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentsPanel } from "../components/panels/SubagentsPanel";
import { makeSubagentRun } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

const run = makeSubagentRun;
const renderPanel = renderWithClient;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SubagentsPanel", () => {
  it("renders a live running row with spinner and progress", () => {
    const { container } = renderPanel(
      <SubagentsPanel
        sessionId="s-1"
        runs={{ "task-1": run({ agent: "scout", status: "running", turns: 2, toolsUsed: ["read_file"] }) }}
      />,
    );

    expect(container.querySelector(".subagent-run-agent")).toHaveTextContent("scout");
    expect(container.querySelector(".subagent-run-status")).toHaveTextContent("运行中");
    expect(container.querySelector(".subagent-run-pulse")).toBeInTheDocument();
    expect(container.querySelector(".subagent-run-stats")).toHaveTextContent("第 2 轮 · 已用 read_file");
    expect(container.querySelector(".subagent-run-task")).toHaveTextContent("调查代码结构");
  });

  it("groups swarm items under a header with aggregate counts, showing the error on failed rows", () => {
    const { container } = renderPanel(
      <SubagentsPanel
        sessionId="s-1"
        runs={{
          "t-1": run({ taskId: "t-1", status: "done", turns: 2, swarm: { index: 1, total: 3 }, agent: "reviewer", prompt: "a.ts" }),
          "t-2": run({ taskId: "t-2", status: "failed", error: "provider boom", swarm: { index: 2, total: 3 }, prompt: "b.ts" }),
          "t-3": run({ taskId: "t-3", status: "running", turns: 1, swarm: { index: 3, total: 3 }, prompt: "c.ts" }),
        }}
      />,
    );

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
    const { container } = renderPanel(
      <SubagentsPanel
        sessionId="s-1"
        runs={{
          "task-old": run({ taskId: "task-old", toolCallId: "call-old", status: "done", prompt: "旧任务" }),
          "task-new": run({ taskId: "task-new", toolCallId: "call-new", status: "running", prompt: "新任务" }),
        }}
      />,
    );

    const items = container.querySelectorAll(".subagent-run-item");
    expect(items[0]!.querySelector(".subagent-run-task")).toHaveTextContent("新任务");
    expect(items[1]!.querySelector(".subagent-run-task")).toHaveTextContent("旧任务");
  });

  it("shows the empty state when there are no runs or no session", () => {
    const { container } = renderPanel(<SubagentsPanel sessionId="s-1" runs={{}} />);
    expect(container.querySelector(".panel-empty")).toHaveTextContent("还没有子代理运行记录");

    const { container: noSession } = renderPanel(
      <SubagentsPanel runs={{ "task-1": run({ status: "done" }) }} />,
    );
    expect(noSession.querySelector(".panel-empty")).toHaveTextContent("还没有子代理运行记录");
  });

  it("onOpenInTab 提供时在行/组头渲染「在标签中打开」并按 toolCallId 回调；缺省不渲染", () => {
    const onOpenInTab = vi.fn();
    const { container } = renderPanel(
      <SubagentsPanel
        sessionId="s-1"
        onOpenInTab={onOpenInTab}
        runs={{
          "t-1": run({ taskId: "t-1", toolCallId: "call-1", status: "running", prompt: "独立任务" }),
          "t-2": run({ taskId: "t-2", toolCallId: "call-2", status: "running", swarm: { index: 1, total: 2 }, prompt: "a.ts" }),
          "t-3": run({ taskId: "t-3", toolCallId: "call-2", status: "running", swarm: { index: 2, total: 2 }, prompt: "b.ts" }),
        }}
      />,
    );

    const buttons = container.querySelectorAll<HTMLButtonElement>(".subagents-open-tab");
    // 单行组在行内、swarm 组在组头各一个（swarm 行不重复渲染）
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onOpenInTab).toHaveBeenCalledWith("call-2");
    fireEvent.click(buttons[1]!);
    expect(onOpenInTab).toHaveBeenCalledWith("call-1");

    const without = renderPanel(<SubagentsPanel sessionId="s-1" runs={{ "task-1": run({ status: "done" }) }} />);
    expect(without.container.querySelector(".subagents-open-tab")).toBeNull();
  });
});
