import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "../components/ConfirmDialog";

// 测试宿主：暴露「发起确认」按钮触发 ask()，把确认结果回传给断言。
// 注：useConfirmDialog 的 ask(request) 是回调式 API（request.onConfirm），不返回 Promise；
// 取消路径（取消按钮/Esc/背板）只关闭对话框、不回调，与 window.confirm 的 resolve false 等价语义即「onConfirm 未被调用且对话框关闭」。
function Host({ onConfirm }: { onConfirm(): void }) {
  const { ask, dialogElement } = useConfirmDialog();
  return (
    <>
      <button
        type="button"
        onClick={() => ask({ title: "删除文件", body: "确定删除该文件？", warning: "删除后不可恢复。", confirmLabel: "删除", onConfirm })}
      >
        发起确认
      </button>
      {dialogElement}
    </>
  );
}

function openDialog(onConfirm = vi.fn()): { onConfirm: ReturnType<typeof vi.fn> } {
  render(<Host onConfirm={onConfirm} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "发起确认" }));
  return { onConfirm };
}

describe("useConfirmDialog", () => {
  it("ask() 弹出（标题/正文/警示/初始焦点）；点确认回调并关闭", () => {
    const { onConfirm } = openDialog();
    const dialog = screen.getByRole("dialog", { name: "删除文件" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("确定删除该文件？")).toBeInTheDocument();
    expect(screen.getByText("删除后不可恢复。")).toBeInTheDocument();
    // 初始焦点在「取消」（安全默认）
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("取消三入口（按钮/Esc-close/背板点击）：不回调 onConfirm 并关闭", () => {
    const { onConfirm } = openDialog();
    // 点取消按钮
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Esc（原生 dialog cancel → close 事件）视为取消：jsdom 未实现原生 <dialog> 的
    // Esc → cancel → close 行为链，这里直接派发 close 事件，覆盖组件侧 onClose={onCancel}
    // 的接线（浏览器中 Esc 经原生行为触发同一入口）
    fireEvent.click(screen.getByRole("button", { name: "发起确认" }));
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("close"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    // 点击背板视为取消：事件 target 为 <dialog> 元素本身（内容区点击 target 是内部元素）
    fireEvent.click(screen.getByRole("button", { name: "发起确认" }));
    fireEvent.click(screen.getByRole("dialog"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("再次 ask 可重新打开（同一时刻只持有一个待决请求）", () => {
    const { onConfirm } = openDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "发起确认" }));
    expect(screen.getByRole("dialog", { name: "删除文件" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
