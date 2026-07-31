import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComposerChips } from "../components/ComposerChips";
import type { BackgroundTaskInfo, LiveSubagentRun, TodoItem } from "../lib/contracts";
import { makeTestClient, renderWithClient } from "./helpers/with-client";

function task(overrides: Partial<BackgroundTaskInfo>): BackgroundTaskInfo {
  return {
    taskId: "task-abcdef01",
    sessionId: "s1",
    cmd: "npm test",
    cwd: "/workspace",
    status: "running",
    startedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function subagent(overrides: Partial<LiveSubagentRun>): LiveSubagentRun {
  return {
    taskId: "agent-1",
    toolCallId: "call-1",
    prompt: "探查 env-sim 扩展",
    status: "running",
    turns: 1,
    toolsUsed: [],
    ...overrides,
  };
}

function renderChips({ tasks = [], todos = [], subagents }: {
  tasks?: BackgroundTaskInfo[];
  todos?: TodoItem[];
  subagents?: Record<string, LiveSubagentRun>;
}): ReturnType<typeof renderWithClient> {
  const client = makeTestClient();
  client.setQueryData(["tasks", "s1"], tasks);
  client.setQueryData(["todos", "s1"], todos);
  return renderWithClient(<ComposerChips sessionId="s1" subagents={subagents} />, client);
}

describe("ComposerChips", () => {
  it("零计数时三个芯片均置灰不可点", () => {
    renderChips({});
    const bash = screen.getByRole("button", { name: /后台 Bash/ });
    const agents = screen.getByRole("button", { name: /子 Agent/ });
    const todos = screen.getByRole("button", { name: /待办/ });
    expect(bash).toBeDisabled();
    expect(agents).toBeDisabled();
    expect(todos).toBeDisabled();
    expect(bash).toHaveTextContent("(0)");
    expect(agents).toHaveTextContent("(0)");
    expect(todos).toHaveTextContent("(0/0)");
  });

  it("计数运行中的后台任务与子代理，待办显示 完成/总数", () => {
    renderChips({
      tasks: [task({}), task({ taskId: "task-abcdef02", status: "done" }), task({ taskId: "task-abcdef03" })],
      todos: [
        { content: "读代码", status: "done" },
        { content: "改样式", status: "in_progress" },
        { content: "跑测试", status: "pending" },
      ],
      subagents: { "agent-1": subagent({}), "agent-2": subagent({ taskId: "agent-2", status: "done" }) },
    });
    expect(screen.getByRole("button", { name: /后台 Bash/ })).toHaveTextContent("(2)");
    expect(screen.getByRole("button", { name: /子 Agent/ })).toHaveTextContent("(1)");
    expect(screen.getByRole("button", { name: /待办/ })).toHaveTextContent("(1/3)");
  });

  it("点击芯片弹出条目速览：命令、提示词与状态", () => {
    renderChips({
      tasks: [task({ cmd: "npm run build" }), task({ taskId: "task-abcdef02", cmd: "ctest", status: "failed" })],
      subagents: { "agent-1": subagent({}) },
    });
    fireEvent.click(screen.getByRole("button", { name: /后台 Bash/ }));
    expect(screen.getByText("npm run build")).toBeInTheDocument();
    expect(screen.getByText("ctest")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /子 Agent/ }));
    expect(screen.getByText("探查 env-sim 扩展")).toBeInTheDocument();
  });

  it("待办浮层列出内容与状态标签", () => {
    renderChips({
      todos: [
        { content: "实现芯片", status: "done" },
        { content: "视觉自验", status: "in_progress" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /待办/ }));
    expect(screen.getByText("实现芯片")).toBeInTheDocument();
    expect(screen.getByText("视觉自验")).toBeInTheDocument();
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });
});
