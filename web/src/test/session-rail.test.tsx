import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionRail } from "../components/SessionRail";
import type { Session } from "../lib/contracts";

function makeSession(id: string, title: string, pinned = false): Session {
  return {
    id,
    cwd: `/ws/${id}`,
    provider: "anthropic",
    model: "claude",
    title,
    ...(pinned ? { pinned: true } : {}),
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function renderRail(sessions: Session[], overrides: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  const props: Parameters<typeof SessionRail>[0] = {
    sessions,
    runningIds: new Set<string>(),
    theme: "dark",
    collapsed: false,
    width: 260,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onImport: vi.fn(),
    onToggleTheme: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onOpenSettings: vi.fn(),
    onResize: vi.fn(),
    ...overrides,
  };
  render(<SessionRail {...props} />);
  return props;
}

describe("SessionRail 重命名与置顶", () => {
  it("置顶会话排在最前，组内保持原顺序", () => {
    renderRail([makeSession("a", "普通甲"), makeSession("b", "置顶乙", true), makeSession("c", "普通丙")]);
    const titles = Array.from(document.querySelectorAll(".session-item .session-title")).map((node) => node.textContent);
    expect(titles).toEqual(["置顶乙", "普通甲", "普通丙"]);
  });

  it("点重命名按钮出现输入框，Enter 提交（trim 后非空且有变化才回调）", () => {
    const props = renderRail([makeSession("a", "旧标题")]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "  新标题  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("a", "新标题");
    expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull();
  });

  it("标题未变化时提交不回调", () => {
    const props = renderRail([makeSession("a", "旧标题")]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("Esc 取消重命名，不回调且输入框消失", () => {
    const props = renderRail([makeSession("a", "旧标题")]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "改动未提交" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull();
    expect(screen.getByText("旧标题")).toBeInTheDocument();
  });

  it("双击标题进入重命名", () => {
    renderRail([makeSession("a", "旧标题")]);
    fireEvent.doubleClick(screen.getByText("旧标题"));
    expect(screen.getByRole("textbox", { name: "重命名会话" })).toHaveValue("旧标题");
  });

  it("置顶开关：未置顶点击回调置顶，已置顶点击回调取消且按钮常显（active）", () => {
    const props = renderRail([makeSession("a", "普通"), makeSession("b", "已置顶", true)]);
    fireEvent.click(screen.getByRole("button", { name: "置顶 普通" }));
    expect(props.onTogglePin).toHaveBeenCalledWith("a", true);
    const pinnedButton = screen.getByRole("button", { name: "取消置顶 已置顶" });
    expect(pinnedButton.className).toContain("active");
    expect(pinnedButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(pinnedButton);
    expect(props.onTogglePin).toHaveBeenCalledWith("b", false);
  });
});
