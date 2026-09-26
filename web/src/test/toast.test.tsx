import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "../components/Toast";

// Toast 自动关闭策略：error 常驻（只由用户手动关闭），info 6 秒自动消失；用假定时器断言时序与定时器清理。
describe("Toast 自动关闭策略", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("error toast 6 秒后不自动消失，点击关闭按钮才回调 onDismiss", () => {
    const onDismiss = vi.fn();
    render(<Toast notice={{ kind: "error", text: "运行失败：exit 1" }} onDismiss={onDismiss} />);
    expect(screen.getByRole("alert")).toHaveTextContent("运行失败：exit 1");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /关闭/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("info toast 6 秒时自动关闭；未到 6 秒卸载则不再回调（定时器被清理）", () => {
    const onDismiss = vi.fn();
    render(<Toast notice={{ kind: "info", text: "已复制" }} onDismiss={onDismiss} />);
    expect(screen.getByRole("status")).toHaveTextContent("已复制");
    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const unmounted = vi.fn();
    const view = render(<Toast notice={{ kind: "info", text: "已保存" }} onDismiss={unmounted} />);
    view.unmount();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(unmounted).not.toHaveBeenCalled();
  });
});
