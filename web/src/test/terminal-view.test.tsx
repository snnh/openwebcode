import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView, deriveTerminalEntries } from "../components/TerminalView";
import type { ChatMessage, SessionDetail } from "../lib/contracts";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: { runShell: vi.fn() },
}));

const runShell = vi.mocked(api.runShell);

const AT = "2026-07-28T00:00:00.000Z";

function makeSession(messages: ChatMessage[]): SessionDetail {
  return {
    id: "s1",
    cwd: "/workspace/project",
    provider: "anthropic",
    model: "claude-opus-4-8",
    title: "终端测试",
    createdAt: AT,
    updatedAt: AT,
    messages,
  };
}

function shellPair(id: string, cmd: string, output: string, isError = false): ChatMessage[] {
  return [
    { id: `u-${id}`, role: "user", createdAt: AT, content: [{ type: "text", text: `!${cmd}` }] },
    { id: `t-${id}`, role: "tool", createdAt: AT, content: [{ type: "tool_result", content: output, isError }] },
  ];
}

describe("TerminalView", () => {
  beforeEach(() => {
    runShell.mockReset();
  });

  it("从消息派生历史配对：$ cmd + 输出块，普通消息不进入终端", () => {
    const session = makeSession([
      ...shellPair("1", "ls -la", "total 0\ndrwxr-xr-x"),
      { id: "u-plain", role: "user", createdAt: AT, content: [{ type: "text", text: "普通对话消息" }] },
      { id: "a-plain", role: "assistant", createdAt: AT, content: [{ type: "text", text: "助手回复" }] },
    ]);
    const { container } = render(<TerminalView session={session} />);

    const cmds = [...container.querySelectorAll(".terminal-cmd")].map((node) => node.textContent);
    expect(cmds).toEqual(["$ ls -la"]);
    expect(container.querySelector(".terminal-output")).toHaveTextContent("total 0");
    expect(screen.queryByText("普通对话消息")).toBeNull();
    // 会话 cwd 小字行
    expect(container.querySelector(".terminal-cwd")).toHaveTextContent("/workspace/project");
  });

  it("tool_result isError 渲染错误样式", () => {
    const session = makeSession(shellPair("1", "false", "exit code 1", true));
    const { container } = render(<TerminalView session={session} />);

    const output = container.querySelector(".terminal-output.error");
    expect(output).toBeInTheDocument();
    expect(output).toHaveTextContent("exit code 1");
  });

  it("无配对的 !cmd 视为执行中（无输出块）", () => {
    const entries = deriveTerminalEntries([
      { id: "u-1", role: "user", createdAt: AT, content: [{ type: "text", text: "!sleep 10" }] },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ cmd: "sleep 10" });
    expect(entries[0]!.output).toBeUndefined();
  });

  it("Enter 提交调用 runShell 并乐观展示执行中，输入框清空", async () => {
    runShell.mockResolvedValue({ accepted: true });
    const session = makeSession([]);
    render(<TerminalView session={session} />);

    const input = screen.getByLabelText("终端命令输入");
    fireEvent.change(input, { target: { value: "echo hi" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(runShell).toHaveBeenCalledWith("s1", "echo hi"));
    expect(await screen.findByText("执行中…")).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("提交失败（如 409 agent 运行中）经 onNotice 反馈且不产生记录", async () => {
    runShell.mockRejectedValue(new Error("agent 运行中，无法执行 shell"));
    const onNotice = vi.fn();
    const session = makeSession([]);
    const { container } = render(<TerminalView session={session} onNotice={onNotice} />);

    const input = screen.getByLabelText("终端命令输入");
    fireEvent.change(input, { target: { value: "make test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("agent 运行中，无法执行 shell", "error"));
    expect(container.querySelector(".terminal-entry")).toBeNull();
    expect(input).not.toBeDisabled();
  });

  it("↑ 回查历史 shell 命令（仅 !cmd，最新在前）", () => {
    const session = makeSession([
      ...shellPair("1", "ls", "a"),
      { id: "u-plain", role: "user", createdAt: AT, content: [{ type: "text", text: "普通消息" }] },
      ...shellPair("2", "pwd", "/workspace/project"),
    ]);
    render(<TerminalView session={session} />);

    const input = screen.getByLabelText("终端命令输入");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((input as HTMLInputElement).value).toBe("pwd");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((input as HTMLInputElement).value).toBe("ls");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((input as HTMLInputElement).value).toBe("pwd");
  });
});
