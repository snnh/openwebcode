import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Session } from "../lib/contracts";
import { SessionsView } from "../workbench/SessionsView";

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `会话 ${id}`,
    cwd: `D:/work/${id}`,
    provider: "anthropic",
    model: "claude",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const noop = (): void => undefined;

describe("SessionsView", () => {
  it("渲染会话列表（标题 + provider · model 元信息）", () => {
    render(<SessionsView sessions={[makeSession("a"), makeSession("b")]} currentId={undefined} agentStates={{}} onSelect={noop} onCreate={noop} />);
    expect(screen.getByText("会话 a")).toBeInTheDocument();
    expect(screen.getByText("会话 b")).toBeInTheDocument();
    expect(screen.getAllByText("anthropic · claude")).toHaveLength(2);
  });

  it("置顶会话排在前面（组内保持原顺序）", () => {
    const sessions = [makeSession("a"), makeSession("b", { pinned: true }), makeSession("c")];
    const { container } = render(<SessionsView sessions={sessions} currentId={undefined} agentStates={{}} onSelect={noop} onCreate={noop} />);
    const titles = [...container.querySelectorAll(".session-title")].map((node) => node.textContent);
    expect(titles).toEqual(["会话 b", "会话 a", "会话 c"]);
  });

  it("运行中的会话显示运行点（busy 态判定走 lib/agent-state）", () => {
    render(<SessionsView sessions={[makeSession("a"), makeSession("b"), makeSession("c")]} currentId={undefined} agentStates={{ a: "streaming", b: "idle", c: "failed" }} onSelect={noop} onCreate={noop} />);
    expect(screen.getAllByRole("status", { name: "运行中" })).toHaveLength(1);
  });

  it("选中态高亮 + 点击回调 onSelect", () => {
    const onSelect = vi.fn();
    const { container } = render(<SessionsView sessions={[makeSession("a"), makeSession("b")]} currentId="b" agentStates={{}} onSelect={onSelect} onCreate={noop} />);
    expect(container.querySelector(".session-item.active .session-title")?.textContent).toBe("会话 b");
    fireEvent.click(screen.getByText("会话 a"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("底部「新建会话」按钮触发 onCreate", () => {
    const onCreate = vi.fn();
    render(<SessionsView sessions={[]} currentId={undefined} agentStates={{}} onSelect={noop} onCreate={onCreate} />);
    expect(screen.getByText("还没有会话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("sessions 为 undefined 时显示加载中", () => {
    render(<SessionsView sessions={undefined} currentId={undefined} agentStates={{}} onSelect={noop} onCreate={noop} />);
    expect(screen.getByText("加载中…")).toBeInTheDocument();
  });
});
