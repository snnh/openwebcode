import { describe, expect, it } from "vitest";
import {
  clearNotifications, markAllRead, markRead, NOTIFICATION_LIMIT, pushNotification, removeNotification, unreadCount,
  type AppNotification,
} from "../lib/notifications";

describe("通知中心数据层（Phase 5b §6.6）", () => {
  it("pushNotification：前插新条目累计未读，超上限丢弃最旧", () => {
    let list: AppNotification[] = [];
    list = pushNotification(list, { kind: "info", text: "第一条", at: 1 });
    list = pushNotification(list, { kind: "error", text: "第二条", at: 2, target: { sessionId: "s1", view: "problems" } });
    expect(list).toHaveLength(2);
    expect(list[0].text).toBe("第二条");
    expect(list[0].read).toBe(false);
    expect(list[0].target).toEqual({ sessionId: "s1", view: "problems" });
    expect(unreadCount(list)).toBe(2);
    // id 唯一
    expect(new Set(list.map((item) => item.id)).size).toBe(2);

    // 超出上限丢弃最旧条目
    let capped: AppNotification[] = [];
    for (let i = 0; i < NOTIFICATION_LIMIT + 10; i += 1) {
      capped = pushNotification(capped, { kind: "info", text: `n${i}`, at: i });
    }
    expect(capped).toHaveLength(NOTIFICATION_LIMIT);
    expect(capped[0].text).toBe(`n${NOTIFICATION_LIMIT + 9}`);
    expect(capped.at(-1)?.text).toBe("n10");
  });

  it("已读与删除操作：markRead/markAllRead 清未读、remove/clear 清条目", () => {
    let list: AppNotification[] = [];
    list = pushNotification(list, { kind: "info", text: "a" });
    list = pushNotification(list, { kind: "info", text: "b" });
    list = markRead(list, list[1].id);
    expect(unreadCount(list)).toBe(1);
    expect(list[1].read).toBe(true);
    list = markAllRead(list);
    expect(unreadCount(list)).toBe(0);
    // 全已读时不产生新数组内容变化
    expect(markAllRead(list)).toEqual(list);

    // removeNotification 逐条清除；clearNotifications 清空
    let removal: AppNotification[] = [];
    removal = pushNotification(removal, { kind: "info", text: "a" });
    removal = pushNotification(removal, { kind: "error", text: "b" });
    removal = removeNotification(removal, removal[0].id);
    expect(removal).toHaveLength(1);
    expect(removal[0].text).toBe("a");
    expect(clearNotifications()).toEqual([]);
  });
});
