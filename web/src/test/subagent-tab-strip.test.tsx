import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubagentTabStrip } from "../components/SubagentTabStrip";
import type { SubagentTab } from "../hooks/use-subagent-tabs";
import { makeSubagentRun } from "./helpers/fixtures";

const run = makeSubagentRun;

describe("SubagentTabStrip", () => {
  it("运行中标签带 data-status 钩子与标签内 spinner，未选中时加 attention 类", () => {
    const tabs: SubagentTab[] = [{ toolCallId: "call-1", prompt: "调查代码结构", agent: "scout" }];
    const { container } = render(
      <SubagentTabStrip
        tabs={tabs}
        runs={{ "task-1": run({ status: "running" }) }}
        selected={undefined}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const tab = container.querySelector(".subagent-tab");
    expect(tab).toHaveAttribute("data-status", "running");
    expect(tab).toHaveClass("attention");
    // 低饱和着色与 spinner 样式挂接的类名钩子（不断言具体颜色）
    expect(tab!.querySelector(".subagent-tab-spinner")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "true");
  });

  it("选中的运行中标签不加 attention；终态标签渲染状态圆点", () => {
    const tabs: SubagentTab[] = [
      { toolCallId: "call-1", prompt: "任务一" },
      { toolCallId: "call-2", prompt: "任务二" },
      { toolCallId: "call-3", prompt: "任务三" },
    ];
    const runs = {
      "t-1": run({ taskId: "t-1", toolCallId: "call-1", status: "running" }),
      "t-2": run({ taskId: "t-2", toolCallId: "call-2", status: "done", turns: 2 }),
      "t-3": run({ taskId: "t-3", toolCallId: "call-3", status: "failed", error: "boom" }),
    };
    const { container } = render(
      <SubagentTabStrip tabs={tabs} runs={runs} selected="call-1" onSelect={vi.fn()} onClose={vi.fn()} />,
    );

    const elements = container.querySelectorAll(".subagent-tab");
    expect(elements[0]).toHaveAttribute("data-status", "running");
    expect(elements[0]).not.toHaveClass("attention");
    expect(elements[1]).toHaveAttribute("data-status", "done");
    expect(elements[1]!.querySelector(".subagent-tab-dot")).toHaveAttribute("data-status", "done");
    expect(elements[2]).toHaveAttribute("data-status", "failed");
    expect(elements[2]!.querySelector(".subagent-tab-dot")).toHaveAttribute("data-status", "failed");
  });
});
