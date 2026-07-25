import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { NotificationsOverlay } from "../components/NotificationsOverlay";
import type { AppNotification } from "../lib/notifications";

function item(overrides: Partial<AppNotification> = {}): AppNotification {
  return { id: "n1", kind: "info", text: "后台任务已结束", at: Date.UTC(2026, 6, 25, 10, 30), read: false, ...overrides };
}

function renderOverlay(notifications: AppNotification[]) {
  const onActivate = vi.fn();
  const onDismiss = vi.fn();
  const onClearAll = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <NotificationsOverlay open notifications={notifications} onActivate={onActivate} onDismiss={onDismiss} onClearAll={onClearAll} onClose={onClose} />,
  );
  return { view, onActivate, onDismiss, onClearAll, onClose };
}

describe("通知中心浮层", () => {
  it("列出通知、未读高亮、逐条清除与全部清除", () => {
    const { view, onDismiss, onClearAll } = renderOverlay([item(), item({ id: "n2", kind: "error", text: "诊断更新：2 项失败", read: true })]);
    expect(view.getByRole("dialog", { name: "通知中心" })).toBeInTheDocument();
    const items = view.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].className).toContain("unread");
    expect(items[1].className).not.toContain("unread");
    fireEvent.click(view.getAllByRole("button", { name: "清除该通知" })[0]);
    expect(onDismiss).toHaveBeenCalledWith("n1");
    fireEvent.click(view.getByRole("button", { name: "全部清除" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("点击条目触发跳转回调", () => {
    const target = { sessionId: "s1", view: "problems" as const };
    const { view, onActivate } = renderOverlay([item({ target })]);
    fireEvent.click(view.getByRole("button", { name: /点击跳转/ }));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "n1", target }));
  });

  it("空列表显示空态，不显示全部清除", () => {
    const { view } = renderOverlay([]);
    expect(view.getByText(/暂无通知/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "全部清除" })).toBeNull();
  });

  it("open=false 不渲染", () => {
    const { container } = render(
      <NotificationsOverlay open={false} notifications={[]} onActivate={vi.fn()} onDismiss={vi.fn()} onClearAll={vi.fn()} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
