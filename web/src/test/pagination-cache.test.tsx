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
  it("单会话截断：未超限原样返回同一引用；超限保留最近部分并把 hasMore 复位为真", () => {
    const small = { older: [message("a")], hasMore: false, loading: false }; expect(trimOlderMessages(small)).toBe(small);
    const many = { older: Array.from({ length: PAGINATION_MAX_MESSAGES + 50 }, (_, index) => message(`m${index}`)), hasMore: false, loading: false };
    const trimmed = trimOlderMessages(many);
    expect(trimmed.older).toHaveLength(PAGINATION_MAX_MESSAGES); expect(trimmed.older[0]!.id).toBe("m50");
    // 丢掉最旧页后服务端仍有更早消息：hasMore 必须为真，否则再往上翻不动了
    expect(trimmed.hasMore).toBe(true);
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
  it("翻页后按上限截断；超出会话数上限时释放最久未用的会话", async () => {
    clearOlderMessages("s1");
    // 每次翻页返回 200 条：两次到 400 条，超过 300 上限，应被截断
    vi.spyOn(api, "messagesPage").mockResolvedValue(page(200, "older"));
    await act(async () => { await loadOlderMessages("s1", "m"); }); expect(olderCount("s1")).toBe(200);
    await act(async () => { await loadOlderMessages("s1", "m"); }); expect(olderCount("s1")).toBe(PAGINATION_MAX_MESSAGES);
    vi.spyOn(api, "messagesPage").mockResolvedValue(page(1, "x"));
    for (let index = 0; index <= PAGINATION_MAX_SESSIONS; index += 1) await act(async () => { await loadOlderMessages(`session-${index}`, "m"); });
    expect(olderCount("s1")).toBe(0);
    for (let index = 0; index <= PAGINATION_MAX_SESSIONS; index += 1) clearOlderMessages(`session-${index}`);
  });
});
