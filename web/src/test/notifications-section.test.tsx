import { describe, expect, it, afterEach } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { NotificationsSection } from "../settings/sections/NotificationsSection";
import { uiStore } from "../app/ui-store";
import type { AppNotification } from "../lib/notifications";

function item(overrides: Partial<AppNotification> = {}): AppNotification {
  return { id: "n1", kind: "info", text: "后台任务已结束", at: Date.UTC(2026, 6, 25, 10, 30), read: false, ...overrides };
}

function renderSection(notifications: AppNotification[]) {
  uiStore.set({ notifications });
  return render(<NotificationsSection />);
}

afterEach(() => {
  uiStore.set({ settingsOpen: false, notifications: [] });
});

describe("通知中心（设置页签）", () => {
  it("列出通知、未读高亮、逐条清除与全部清除", () => {
    const view = renderSection([item(), item({ id: "n2", kind: "error", text: "诊断更新：2 项失败", read: true })]);
    expect(view.getByRole("region", { name: "通知中心" })).toBeInTheDocument();
    const items = view.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1].className).not.toContain("unread");
    // 挂载即全部已读（角标清零）
    expect(uiStore.get().notifications.every((entry) => entry.read)).toBe(true);
    fireEvent.click(view.getAllByRole("button", { name: "清除该通知" })[0]);
    expect(uiStore.get().notifications.map((entry) => entry.id)).toEqual(["n2"]);
    fireEvent.click(view.getByRole("button", { name: "全部清除" }));
    expect(uiStore.get().notifications).toEqual([]);
  });

  it("点击条目触发跳转（标记已读 + 关设置 + 切会话/视图）", () => {
    uiStore.set({ settingsOpen: true });
    const target = { sessionId: "s1", view: "problems" as const };
    const view = renderSection([item({ target })]);
    fireEvent.click(view.getByRole("button", { name: /点击跳转/ }));
    const state = uiStore.get();
    expect(state.settingsOpen).toBe(false);
    expect(state.sessionId).toBe("s1");
  });

  it("空列表显示空态，不显示全部清除", () => {
    const view = renderSection([]);
    expect(view.getByText(/暂无通知/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "全部清除" })).toBeNull();
  });
});
