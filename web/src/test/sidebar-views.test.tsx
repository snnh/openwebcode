import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { Session } from "../lib/contracts";
import { layout, layoutStore } from "../workbench/layout";
import { SidebarViews } from "../workbench/SidebarViews";
import { renderWithClient } from "./helpers/with-client";

function makeSession(id: string): Session {
  return {
    id,
    title: `会话 ${id}`,
    cwd: `D:/work/${id}`,
    provider: "anthropic",
    model: "claude",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const noop = (): void => undefined;

function renderViews(currentId?: string) {
  return renderWithClient(
    <SidebarViews sessions={[makeSession("a")]} currentId={currentId} agentStates={{}} onSelectSession={noop} />,
  );
}

describe("SidebarViews 视图容器", () => {
  beforeEach(() => {
    window.localStorage.clear();
    layoutStore.set({ sidebarView: "sessions", sidebarVisible: true, sidebarWidth: 250 });
  });

  it("默认渲染 sessions 视图（会话列表，无视图标题栏）", () => {
    renderViews();
    expect(screen.getByText("会话 a")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "会话" })).toBeInTheDocument();
    expect(document.querySelector(".sidebar-views-header")).toBeNull();
  });

  it("切换到 files 视图：标题栏 + 无会话空态", () => {
    layout.showView("files");
    renderViews();
    expect(screen.getByRole("heading", { name: "文件" })).toBeInTheDocument();
    expect(screen.getByText("选择会话以浏览工作区文件。")).toBeInTheDocument();
  });

  it("切换到 scm 视图：标题栏 + 无会话空态", () => {
    layout.showView("scm");
    renderViews();
    expect(screen.getByRole("heading", { name: "源代码管理" })).toBeInTheDocument();
    expect(screen.getByText("选择会话以查看源代码管理。")).toBeInTheDocument();
  });

  it("切换到 problems 视图：标题栏 + 无会话空态", () => {
    layout.showView("problems");
    renderViews();
    expect(screen.getByRole("heading", { name: "问题" })).toBeInTheDocument();
    expect(screen.getByText("选择会话以查看诊断问题。")).toBeInTheDocument();
  });

  it("宽度拖拽柄：方向键调整 layout.sidebarWidth（钳制在 200–380）", () => {
    renderViews();
    const handle = screen.getByRole("button", { name: "调整侧栏宽度（方向键左右）" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(layoutStore.get().sidebarWidth).toBe(266);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(layoutStore.get().sidebarWidth).toBe(250);
  });

  it("宽度拖拽柄：鼠标拖拽调宽", () => {
    renderViews();
    const handle = screen.getByRole("button", { name: "调整侧栏宽度（方向键左右）" });
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 130 });
    expect(layoutStore.get().sidebarWidth).toBe(280);
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 999 });
    expect(layoutStore.get().sidebarWidth).toBe(280);
  });

  it("sessions 视图选中会话回调 onSelectSession", () => {
    const onSelect = vi.fn();
    renderWithClient(<SidebarViews sessions={[makeSession("a")]} currentId={undefined} agentStates={{}} onSelectSession={onSelect} />);
    fireEvent.click(screen.getByText("会话 a"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});
