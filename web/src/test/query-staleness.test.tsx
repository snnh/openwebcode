import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { qk, useContextViewQuery, useInteractionsQuery, usePendingPermissionsQuery, useQueueQuery, useSessionQuery, useSessionsQuery, useTodosQuery } from "../app/queries";
import { sessionMeta, sessionStore } from "../app/session-store";
vi.mock("../lib/api", () => ({
  api: {
    session: vi.fn(async () => ({ id: "s1", messages: [] })), context: vi.fn(async () => ({ ledger: {}, stats: {}, preferences: {} })),
    queue: vi.fn(async () => []), interactions: vi.fn(async () => []), pendingPermissions: vi.fn(async () => []), todos: vi.fn(async () => []),
    sessions: vi.fn(async () => [
      { id: "s1", title: "会话一", attention: { permissions: 1, interactions: 2 } }, { id: "s2", title: "会话二" },
      { id: "s3", title: "会话三", attention: { permissions: 0, interactions: 0 } },
    ]),
  },
}));
// 只查 staleTime：给足 gcTime，避免后台 GC 干扰断言
const makeClient = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } });
const wrapperOf = (client: QueryClient) => ({ children }: { children: ReactNode }): ReactElement =>
  <QueryClientProvider client={client}>{children}</QueryClientProvider>;
/** 读取某 queryKey 生效的 staleTime。 */
const staleTimeOf = (client: QueryClient, key: readonly unknown[]): number | undefined =>
  (client.getQueryCache().find({ queryKey: key })?.options as { staleTime?: number } | undefined)?.staleTime;
describe("会话级查询的 staleTime 分级（切回会话不再重复拉取）", () => {
  let client: QueryClient;
  beforeEach(() => { client = makeClient(); });
  it("会话详情 10s、上下文视图 15s、运行态小查询 10s；10s 内切回命中缓存", async () => {
    renderHook(() => ({
      session: useSessionQuery("s1"), context: useContextViewQuery("s1"), queue: useQueueQuery("s1"),
      interactions: useInteractionsQuery("s1"), permissions: usePendingPermissionsQuery("s1"), todos: useTodosQuery("s1"),
    }), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(staleTimeOf(client, qk.session("s1"))).toBe(10_000));
    expect(staleTimeOf(client, qk.context("s1"))).toBe(15_000);
    for (const key of [qk.queue("s1"), qk.interactions("s1"), qk.permissions("s1"), qk.todos("s1")]) expect(staleTimeOf(client, key)).toBe(10_000);
    const first = renderHook(() => useSessionQuery("s1"), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const fetchedOnce = client.getQueryCache().find({ queryKey: qk.session("s1") })!.state.dataUpdatedAt;
    first.unmount();
    renderHook(() => useSessionQuery("s1"), { wrapper: wrapperOf(client) });
    expect(client.getQueryCache().find({ queryKey: qk.session("s1") })!.state.dataUpdatedAt).toBe(fetchedOnce);
  });
});
describe("attention 角标播种与增量", () => {
  it("列表响应的 attention 整表写入 session-store（零值不建条目）；bump 增减、清零移除、clear/removeSession 清理且不出现负数", async () => {
    sessionStore.set({ attention: { stale: { permissions: 9, interactions: 9 } } });
    renderHook(() => useSessionsQuery(), { wrapper: wrapperOf(makeClient()) });
    await waitFor(() => expect(sessionStore.get().attention.s1).toEqual({ permissions: 1, interactions: 2 }));
    expect(sessionStore.get().attention.s2).toBeUndefined(); expect(sessionStore.get().attention.s3).toBeUndefined();
    // 整表替换：服务端是唯一真相，上一轮的残留被清掉
    expect(sessionStore.get().attention.stale).toBeUndefined();
    sessionMeta.bumpAttention("s5", "permissions", 1); sessionMeta.bumpAttention("s5", "interactions", 1);
    expect(sessionStore.get().attention.s5).toEqual({ permissions: 1, interactions: 1 });
    sessionMeta.bumpAttention("s5", "permissions", -1); sessionMeta.bumpAttention("s5", "interactions", -1);
    expect(sessionStore.get().attention.s5).toBeUndefined();
    sessionMeta.bumpAttention("s2", "permissions", -1); expect(sessionStore.get().attention.s2).toBeUndefined();
    sessionMeta.bumpAttention("s3", "permissions", 1); sessionMeta.clearAttention("s3"); expect(sessionStore.get().attention.s3).toBeUndefined();
    sessionMeta.bumpAttention("s4", "interactions", 1); sessionMeta.removeSession("s4"); expect(sessionStore.get().attention.s4).toBeUndefined();
  });
});
