import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";

describe("删除会话确认对话框", () => {
  it("展示会话标题与不可恢复警示，初始焦点在取消按钮", () => {
    render(<ConfirmDeleteDialog open title="我的会话" onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByText(/删除会话「我的会话」？/)).toBeInTheDocument();
    expect(screen.getByText("删除后不可恢复。")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  });

  it("运行中的会话：提示先中断，删除按钮禁用（服务端会以 409 拒绝）", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDeleteDialog open title="我的会话" running onCancel={() => undefined} onConfirm={onConfirm} />);
    expect(screen.getByText(/请先在会话中中断任务，再删除/)).toBeInTheDocument();
    const deleteButton = screen.getByRole("button", { name: "删除" });
    expect(deleteButton).toBeDisabled();
    fireEvent.click(deleteButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("确认路径：点删除回调 onConfirm；全程不触达原生 window.confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const onConfirm = vi.fn();
    render(<ConfirmDeleteDialog open title="我的会话" onCancel={() => undefined} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("取消路径：取消按钮与背板点击都回调 onCancel", () => {
    const onCancel = vi.fn();
    render(<ConfirmDeleteDialog open title="我的会话" onCancel={onCancel} onConfirm={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("open=false 不渲染", () => {
    render(<ConfirmDeleteDialog open={false} title="我的会话" onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
