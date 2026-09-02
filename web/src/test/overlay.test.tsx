import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Overlay } from "../components/Overlay";

function renderOverlay({ onClose = vi.fn(), initialFocus }: { onClose?: () => void; initialFocus?: string } = {}) {
  const view = render(
    <Overlay
      open
      label="测试浮层"
      onClose={onClose}
      {...(initialFocus !== undefined ? { initialFocus } : {})}
    >
      <button type="button">第一个</button>
      <button type="button" data-initial-focus>第二个</button>
    </Overlay>,
  );
  const dialog = screen.getByRole("dialog", { name: "测试浮层" });
  const backdrop = dialog.parentElement!;
  return { view, dialog, backdrop, onClose };
}

describe("Overlay", () => {
  it("Esc 在 capture 阶段拦截并触发 onClose，不再传播到 document 冒泡监听（避免触发全局快捷键）", () => {
    const { dialog, onClose } = renderOverlay();
    const bubbleListener = vi.fn();
    document.addEventListener("keydown", bubbleListener);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // capture 阶段 stopPropagation：冒泡阶段的监听收不到这次 Esc
    expect(bubbleListener).not.toHaveBeenCalled();
    document.removeEventListener("keydown", bubbleListener);
  });

  it("点击 backdrop（非内容区）触发 onClose；点击内容区不触发", () => {
    const { dialog, backdrop, onClose } = renderOverlay();
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(screen.getByRole("button", { name: "第一个" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab 焦点困在弹层内：末位回首位、弹层外按下收回首位", () => {
    const firstView = renderOverlay();
    const first = screen.getByRole("button", { name: "第一个" });
    const last = screen.getByRole("button", { name: "第二个" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    firstView.view.unmount();

    // 焦点意外落在弹层外（如第三方代码抢焦点）时按 Tab 回收到首位（不逃到遮罩下的页面）
    render(
      <>
        <button type="button">外部按钮</button>
        <Overlay open label="测试浮层" onClose={() => undefined}>
          <button type="button">第一个</button>
          <button type="button">第二个</button>
        </Overlay>
      </>,
    );
    const trapFirst = screen.getByRole("button", { name: "第一个" });
    const outside = screen.getByRole("button", { name: "外部按钮" });
    outside.focus();
    expect(document.activeElement).toBe(outside);
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(document.activeElement).toBe(trapFirst);
  });

  it("焦点管理：默认/initialFocus 初始聚焦；关闭归还打开前元素", () => {
    const { view, dialog } = renderOverlay();
    expect(document.activeElement).toBe(dialog);
    view.unmount();

    const focused = renderOverlay({ initialFocus: "[data-initial-focus]" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "第二个" }));
    focused.view.unmount();

    function Host({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">打开前的按钮</button>
          <Overlay open={open} label="测试浮层" onClose={() => undefined}>
            <button type="button">内部按钮</button>
          </Overlay>
        </>
      );
    }
    const hostView = render(<Host open={false} />);
    const trigger = screen.getByRole("button", { name: "打开前的按钮" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    hostView.rerender(<Host open />);
    // 打开后焦点进入弹层
    expect(document.activeElement).not.toBe(trigger);

    hostView.rerender(<Host open={false} />);
    expect(document.activeElement).toBe(trigger);
  });

  it("open=false 不渲染", () => {
    const { container } = render(
      <Overlay open={false} label="测试浮层" onClose={() => undefined}>
        <button type="button">内部按钮</button>
      </Overlay>,
    );
    expect(container.firstChild).toBeNull();
  });
});
