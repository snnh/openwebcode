import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  clearOlderMessages, loadOlderMessages, PAGINATION_MAX_MESSAGES, PAGINATION_MAX_SESSIONS,
  pruneSessionCaches, trimOlderMessages, useOlderMessages,
} from "../chat/pagination-store";
import { api } from "../lib/api";
import type { ChatMessage, MessagesPage } from "../lib/contracts";
const message = (id: string): ChatMessage => ({ id, role: "user", content: [{ type: "text", text: id }], createdAt: "2026-01-01T00:00:00.000Z" });
const page = (count: number, prefix: string): MessagesPage => ({ messages: Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`)), hasMore: true, totalLines: count });
/** 读某会话当前缓存条数（经 store 直接读，避开 Hook 规则） */
const olderCount = (sessionId: string): number => renderHook(() => useOlderMessages(sessionId)).result.current.older.length; beforeEach(() => vi.restoreAllMocks());
describe("分页缓存上限", () => {
  it("单会话截断：未超限原样返回同一引用；超限保留最近部分，hasMore 与游标不动", () => {
    const small = { older: [message("a")], hasMore: false, loading: false }; expect(trimOlderMessages(small)).toBe(small);
    const many = { older: Array.from({ length: PAGINATION_MAX_MESSAGES + 50 }, (_, index) => message(`m${index}`)), hasMore: false, loading: false, cursor: "m0" };
    const trimmed = trimOlderMessages(many);
    expect(trimmed.older).toHaveLength(PAGINATION_MAX_MESSAGES); expect(trimmed.older[0]!.id).toBe("m50");
    // hasMore 只由服务端响应决定（截断复位为真会让「加载更早」永远翻不到头）；游标独立保留
    expect(trimmed.hasMore).toBe(false); expect(trimmed.cursor).toBe("m0");
  });
  it("全局 LRU：只保留最近使用的 N 个会话；未超限返回同一引用", () => {
    const bySession = Object.fromEntries(
      Array.from({ length: PAGINATION_MAX_SESSIONS + 2 }, (_, index) => [`s${index}`, { older: [message(`s${index}`)], hasMore: false, loading: false }]),
    );
    const pruned = pruneSessionCaches(bySession, Object.keys(bySession)); expect(Object.keys(pruned)).toHaveLength(PAGINATION_MAX_SESSIONS);
    expect(pruned.s0).toBeUndefined(); expect(pruned[`s${PAGINATION_MAX_SESSIONS + 1}`]).toBeDefined();
    const small = { s1: { older: [], hasMore: false, loading: false } };
    expect(pruneSessionCaches(small, ["s1"])).toBe(small);
  });
  it("翻页按上限截断后仍用保留游标继续向前（不回退重复请求）；超出会话数上限时释放最久未用的会话", async () => {
    clearOlderMessages("s1");
    const befores: string[] = [];
    vi.spyOn(api, "messagesPage").mockImplementation(async (_sessionId: string, before: string) => { befores.push(before); return page(200, `p${befores.length}`); });
    const rounds = Math.ceil(PAGINATION_MAX_MESSAGES / 200) + 1;
    for (let index = 0; index < rounds; index += 1) await act(async () => { await loadOlderMessages("s1", "seed"); });
    expect(olderCount("s1")).toBe(PAGINATION_MAX_MESSAGES); // 超出部分已从视图释放
    expect(befores[0]).toBe("seed");
    // 第 n 次翻页的 before 必须是上一页的最早一条（游标），而不是截断后列表里的第一条
    expect(befores.at(-1)).toBe(`p${befores.length - 1}-0`);
    vi.spyOn(api, "messagesPage").mockResolvedValue({ ...page(1, "x"), hasMore: false });
    await act(async () => { await loadOlderMessages("s1", "seed"); });
    const state = renderHook(() => useOlderMessages("s1")).result.current; expect(state.hasMore).toBe(false);
    for (let index = 0; index <= PAGINATION_MAX_SESSIONS; index += 1) await act(async () => { await loadOlderMessages(`session-${index}`, "m"); });
    expect(olderCount("s1")).toBe(0);
    for (let index = 0; index <= PAGINATION_MAX_SESSIONS; index += 1) clearOlderMessages(`session-${index}`);
  });
});
