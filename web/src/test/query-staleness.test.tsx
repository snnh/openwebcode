import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import {
  qk, useContextViewQuery, useInteractionsQuery, usePendingPermissionsQuery, useQueueQuery,
  useSessionQuery, useSessionsQuery, useTodosQuery,
} from "../app/queries";
import { sessionMeta, sessionStore } from "../app/session-store";

vi.mock("../lib/api", () => ({
  api: {
    session: vi.fn(async () => ({ id: "s1", messages: [] })),
    context: vi.fn(async () => ({ ledger: {}, stats: {}, preferences: {} })),
    queue: vi.fn(async () => []),
    interactions: vi.fn(async () => []),
    pendingPermissions: vi.fn(async () => []),
    todos: vi.fn(async () => []),
    sessions: vi.fn(async () => [
      { id: "s1", title: "会话一", attention: { permissions: 1, interactions: 2 } },
      { id: "s2", title: "会话二" },
      { id: "s3", title: "会话三", attention: { permissions: 0, interactions: 0 } },
    ]),
  },
}));

function makeClient(): QueryClient {
  // 只查 staleTime：给足 gcTime，避免后台 GC 干扰断言
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } });
}

function wrapperOf(client: QueryClient): (props: { children: ReactNode }) => ReactElement {
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function staleTimeOf(client: QueryClient, key: readonly unknown[]): number | undefined {
  const options = client.getQueryCache().find({ queryKey: key })?.options as { staleTime?: number } | undefined;
  return options?.staleTime;
}

describe("会话级查询的 staleTime 分级（切回会话不再重复拉取）", () => {
  let client: QueryClient;
  beforeEach(() => {
    client = makeClient();
  });

  it("会话详情 10s、上下文视图 15s、运行态小查询 10s", async () => {
    renderHook(() => ({
      session: useSessionQuery("s1"),
      context: useContextViewQuery("s1"),
      queue: useQueueQuery("s1"),
      interactions: useInteractionsQuery("s1"),
      permissions: usePendingPermissionsQuery("s1"),
      todos: useTodosQuery("s1"),
    }), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(staleTimeOf(client, qk.session("s1"))).toBe(10_000));
    expect(staleTimeOf(client, qk.context("s1"))).toBe(15_000);
    expect(staleTimeOf(client, qk.queue("s1"))).toBe(10_000);
    expect(staleTimeOf(client, qk.interactions("s1"))).toBe(10_000);
    expect(staleTimeOf(client, qk.permissions("s1"))).toBe(10_000);
    expect(staleTimeOf(client, qk.todos("s1"))).toBe(10_000);
  });

  it("10s 内切回同一会话：命中缓存、不再发请求（dataUpdatedAt 不变）", async () => {
    const first = renderHook(() => useSessionQuery("s1"), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const fetchedOnce = client.getQueryCache().find({ queryKey: qk.session("s1") })!.state.dataUpdatedAt;
    // 重新挂载（模拟切走再切回）：staleTime 内不产生新的取数
    first.unmount();
    renderHook(() => useSessionQuery("s1"), { wrapper: wrapperOf(client) });
    expect(client.getQueryCache().find({ queryKey: qk.session("s1") })!.state.dataUpdatedAt).toBe(fetchedOnce);
  });
});

describe("useSessionsQuery：attention 播种", () => {
  it("列表响应里的 attention 写入 session-store（零值不建条目），刷新/重连后角标不丢", async () => {
    sessionStore.set({ attention: { stale: { permissions: 9, interactions: 9 } } });
    const client = makeClient();
    renderHook(() => useSessionsQuery(), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(sessionStore.get().attention.s1).toEqual({ permissions: 1, interactions: 2 }));
    expect(sessionStore.get().attention.s2).toBeUndefined();
    expect(sessionStore.get().attention.s3).toBeUndefined();
    // 整表替换：服务端是唯一真相，上一轮的残留被清掉
    expect(sessionStore.get().attention.stale).toBeUndefined();
  });
});

describe("sessionMeta 待办计数（跨会话角标增量）", () => {
  it("bump 增减、清零后移除条目、clear 与 removeSession 清理", () => {
    sessionStore.set({ attention: {} });
    sessionMeta.bumpAttention("s1", "permissions", 1);
    sessionMeta.bumpAttention("s1", "interactions", 1);
    expect(sessionStore.get().attention.s1).toEqual({ permissions: 1, interactions: 1 });
    sessionMeta.bumpAttention("s1", "permissions", -1);
    sessionMeta.bumpAttention("s1", "interactions", -1);
    expect(sessionStore.get().attention.s1).toBeUndefined();

    // 多余的 -1 不会变成负数
    sessionMeta.bumpAttention("s2", "permissions", -1);
    expect(sessionStore.get().attention.s2).toBeUndefined();

    sessionMeta.bumpAttention("s3", "permissions", 1);
    sessionMeta.clearAttention("s3");
    expect(sessionStore.get().attention.s3).toBeUndefined();

    sessionMeta.bumpAttention("s4", "interactions", 1);
    sessionMeta.bumpAttention("s4", "interactions", 1);
    sessionMeta.removeSession("s4");
    expect(sessionStore.get().attention.s4).toBeUndefined();
  });
});
