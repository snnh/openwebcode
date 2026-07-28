import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubagentRunCard } from "../components/SubagentRunCard";
import type { LiveSubagentRun } from "../lib/contracts";
import type { ReactElement } from "react";

function renderWithClient(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function run(overrides: Partial<LiveSubagentRun>): LiveSubagentRun {
  return {
    taskId: "task-1",
    toolCallId: "call-1",
    prompt: "调查代码结构",
    status: "running",
    turns: 0,
    toolsUsed: [],
    ...overrides,
  };
}

describe("SubagentRunCard", () => {
  it("shows live turn and tool progress for a running spawn_task", () => {
    const { container } = renderWithClient(
      <SubagentRunCard
        name="spawn_task"
        input={{ prompt: "调查代码结构" }}
        live={[run({ status: "running", turns: 2, toolsUsed: ["read_file"] })]}
      />,
    );

    expect(container.querySelector(".subagent-run")).toBeInTheDocument();
    expect(container.querySelector(".subagent-run-status")).toHaveTextContent("运行中");
    expect(container.querySelector(".subagent-run-spinner")).toBeInTheDocument();
    expect(container.querySelector(".subagent-run-stats")).toHaveTextContent("第 2 轮 · 已用 read_file");
  });

  it("shows the agent name and final stats for a done spawn_task, with a lazy transcript link", () => {
    const { container } = renderWithClient(
      <SubagentRunCard
        name="spawn_task"
        input={{ prompt: "评审 a.ts", agent: "reviewer" }}
        sessionId="s-1"
        live={[run({ status: "done", turns: 3, toolsUsed: ["read_file", "grep"], agent: "reviewer" })]}
      />,
    );

    expect(container.querySelector(".subagent-run-agent")).toHaveTextContent("reviewer");
    expect(container.querySelector(".subagent-run-status")).toHaveTextContent("完成");
    expect(container.querySelector(".subagent-run-stats")).toHaveTextContent("3 轮 · read_file, grep");
    // 完成后提供转录链接（懒加载，展开前不拉取）
    expect(container.querySelector("details.subagent-transcript")).toBeInTheDocument();
  });

  it("shows the error for a failed spawn_task", () => {
    const { container } = renderWithClient(
      <SubagentRunCard
        name="spawn_task"
        input={{ prompt: "调查" }}
        live={[run({ status: "failed", error: "provider boom" })]}
      />,
    );

    expect(container.querySelector(".subagent-run-status")).toHaveTextContent("失败");
    expect(container.querySelector(".subagent-run-error")).toHaveTextContent("provider boom");
  });

  it("renders swarm items with per-item status transitions and agent overrides", () => {
    const { container } = renderWithClient(
      <SubagentRunCard
        name="spawn_swarm"
        input={{ prompt_template: "评审 {{item}}", items: [{ task: "a.ts", agent: "reviewer" }, "b.ts", "c.ts"], agent: "scout" }}
        live={[
          run({ taskId: "t-1", status: "done", turns: 2, swarm: { index: 1, total: 3 }, agent: "reviewer" }),
          run({ taskId: "t-2", status: "running", turns: 1, toolsUsed: ["glob"], swarm: { index: 2, total: 3 } }),
        ]}
      />,
    );

    const items = container.querySelectorAll(".subagent-run-item");
    expect(items).toHaveLength(3);
    // 第 1 项：完成，agent 覆盖为 reviewer
    expect(items[0]).toHaveAttribute("data-status", "done");
    expect(items[0]!.querySelector(".subagent-run-agent")).toHaveTextContent("reviewer");
    expect(items[0]!.querySelector(".subagent-run-status")).toHaveTextContent("完成");
    // 第 2 项：运行中，回退到调用级 scout
    expect(items[1]).toHaveAttribute("data-status", "running");
    expect(items[1]!.querySelector(".subagent-run-agent")).toHaveTextContent("scout");
    expect(items[1]!.querySelector(".subagent-run-status")).toHaveTextContent("运行中");
    expect(items[1]!.querySelector(".subagent-run-stats")).toHaveTextContent("第 1 轮 · 已用 glob");
    // 第 3 项：尚未启动 → 排队中
    expect(items[2]).toHaveAttribute("data-status", "pending");
    expect(items[2]!.querySelector(".subagent-run-status")).toHaveTextContent("排队中");
    expect(items[2]!.querySelector(".subagent-run-task")).toHaveTextContent("c.ts");
  });

  it("renders a static historical swarm card without status chips when no live runs exist", () => {
    const { container } = renderWithClient(
      <SubagentRunCard
        name="spawn_swarm"
        input={{ prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"] }}
      />,
    );

    const items = container.querySelectorAll(".subagent-run-item");
    expect(items).toHaveLength(2);
    expect(container.querySelector(".subagent-run-status")).not.toBeInTheDocument();
    expect(items[0]!.querySelector(".subagent-run-task")).toHaveTextContent("a.ts");
  });
});
