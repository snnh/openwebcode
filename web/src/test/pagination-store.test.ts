import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MessagesPage } from "../lib/contracts";

vi.mock("../lib/api", () => ({
  api: { messagesPage: vi.fn() },
}));

import { api } from "../lib/api";
import { clearOlderMessages, loadOlderMessages, useOlderMessages } from "../chat/pagination-store";

const messagesPage = vi.mocked(api.messagesPage);

function msg(id: string): ChatMessage {
  return { id, role: "user", content: [{ type: "text", text: id }], createdAt: "2026-08-01T00:00:00.000Z" };
}

function page(ids: string[], hasMore: boolean): MessagesPage {
  return { messages: ids.map(msg), hasMore, totalLines: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearOlderMessages("s1");
  clearOlderMessages("s2");
});

describe("pagination-store", () => {
  it("loadOlderMessages 前插合并更早消息并更新 hasMore", async () => {
    messagesPage.mockResolvedValueOnce(page(["m1", "m2"], true));
    await loadOlderMessages("s1", "m3");

    const { result, rerender } = renderHook(() => useOlderMessages("s1"));
    expect(result.current.older.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(false);

    messagesPage.mockResolvedValueOnce(page(["m0"], false));
    await loadOlderMessages("s1", "m1");
    rerender();
    expect(result.current.older.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("loading 中重入直接跳过（不并发请求）", async () => {
    let resolve: ((value: MessagesPage) => void) | undefined;
    messagesPage.mockImplementationOnce(() => new Promise<MessagesPage>((r) => { resolve = r; }));

    const first = loadOlderMessages("s1", "m9");
    await loadOlderMessages("s1", "m9"); // 重入：应被跳过
    expect(messagesPage).toHaveBeenCalledTimes(1);
    expect(messagesPage).toHaveBeenCalledWith("s1", "m9", 100);

    resolve!(page(["m8"], false));
    await first;
  });

  it("网络错误静默：loading 复位、已有缓存保留，可重试", async () => {
    messagesPage.mockResolvedValueOnce(page(["m1"], true));
    await loadOlderMessages("s1", "m2");

    messagesPage.mockRejectedValueOnce(new Error("network down"));
    await loadOlderMessages("s1", "m1");

    const { result } = renderHook(() => useOlderMessages("s1"));
    expect(result.current.loading).toBe(false);
    expect(result.current.older.map((m) => m.id)).toEqual(["m1"]);
    expect(result.current.hasMore).toBe(true);
  });

  it("按会话键控隔离；clearOlderMessages 清空该会话缓存", async () => {
    messagesPage.mockResolvedValueOnce(page(["a1"], true));
    await loadOlderMessages("s1", "a2");
    messagesPage.mockResolvedValueOnce(page(["b1"], false));
    await loadOlderMessages("s2", "b2");

    const { result, rerender } = renderHook(() => useOlderMessages("s1"));
    expect(result.current.older.map((m) => m.id)).toEqual(["a1"]);

    clearOlderMessages("s1");
    rerender();
    expect(result.current.older).toEqual([]);
    expect(result.current.hasMore).toBe(false);

    const other = renderHook(() => useOlderMessages("s2"));
    expect(other.result.current.older.map((m) => m.id)).toEqual(["b1"]);
  });

  it("未知会话与 undefined 返回共享空态", () => {
    const { result } = renderHook(() => useOlderMessages(undefined));
    expect(result.current).toEqual({ older: [], hasMore: false, loading: false });
    const unknown = renderHook(() => useOlderMessages("nope"));
    expect(unknown.result.current.older).toEqual([]);
  });
});
