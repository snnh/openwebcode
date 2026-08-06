import { describe, expect, it } from "vitest";
import { createStore, useStore } from "../app/store";
import { renderHook } from "@testing-library/react";
import { ui, uiStore } from "../app/ui-store";
import { sessionMeta, sessionStore } from "../app/session-store";

describe("createStore", () => {
  it("get/set/subscribe：浅合并更新并通知订阅者", () => {
    const store = createStore({ a: 1, b: "x" });
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get().a));
    store.set({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: "x" });
    store.set((previous) => ({ a: previous.a + 1 }));
    expect(store.get().a).toBe(3);
    expect(seen).toEqual([2, 3]);
    unsubscribe();
    store.set({ a: 9 });
    expect(seen).toHaveLength(2);
  });

  it("useStore：选择器订阅切片，未触碰字段引用稳定", () => {
    const store = createStore({ a: 1, nested: { v: "keep" } });
    const { result, rerender } = renderHook(() => useStore(store, (state) => state.nested));
    const first = result.current;
    store.set({ a: 2 });
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("ui-store", () => {
  it("notify 同时写 toast 与通知中心；openSettings 携带深链页签", () => {
    ui.notify("出错了", "error");
    const state = uiStore.get();
    expect(state.notice).toEqual({ kind: "error", text: "出错了" });
    expect(state.notifications.at(-1)?.text).toBe("出错了");
    ui.openSettings("models");
    expect(uiStore.get().settingsOpen).toBe(true);
    expect(uiStore.get().settingsTab?.tab).toBe("models");
    ui.closeSettings();
    expect(uiStore.get().settingsOpen).toBe(false);
    // 清理，避免污染其他用例
    ui.clearNotifications();
    ui.setNotice(undefined);
  });
});

describe("session-store", () => {
  it("权限卡 upsert/remove/clear；removeSession 清理全部键控条目", () => {
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: {} });
    sessionMeta.upsertPermission({ requestId: "r2", tool: "write_file", input: {} });
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: { cmd: "ls" } });
    expect(sessionStore.get().pendingPermissions.map((item) => item.requestId)).toEqual(["r2", "r1"]);
    sessionMeta.removePermission("r2");
    expect(sessionStore.get().pendingPermissions.map((item) => item.requestId)).toEqual(["r1"]);
    sessionMeta.clearPermissions();
    expect(sessionStore.get().pendingPermissions).toEqual([]);

    sessionMeta.setAgentState("s1", "thinking");
    sessionMeta.setRunFailure("s1", { message: "boom", retryable: true });
    sessionMeta.removeSession("s1");
    expect(sessionStore.get().agentStates.s1).toBeUndefined();
    expect(sessionStore.get().runFailures.s1).toBeUndefined();
  });

  it("clearAgentStateIfIdle 只清 busy 态", () => {
    sessionMeta.setAgentState("s1", "thinking");
    sessionMeta.setAgentState("s2", "idle");
    sessionMeta.clearAgentStateIfIdle("s1");
    sessionMeta.clearAgentStateIfIdle("s2");
    expect(sessionStore.get().agentStates.s1).toBeUndefined();
    expect(sessionStore.get().agentStates.s2).toBe("idle");
    sessionMeta.removeSession("s2");
  });
});
