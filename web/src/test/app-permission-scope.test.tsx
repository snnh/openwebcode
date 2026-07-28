import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { SessionDetail } from "../lib/contracts";

const userText = "请处理这个任务";

const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "权限测试作业",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: [], network: "deny" },
  messages: [{ id: "user-1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: userText }] }],
};

function installFetchMock(): void {
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.includes("/api/sessions/s1/permissions")) return json([]);
    if (url.includes("/api/sessions/s1/context")) return json({ ledger: { usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 }, entries: [] }, preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" } });
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/extensions")) return json([]);
    if (url.endsWith("/api/settings")) return json({ groups: [] });
    if (url.endsWith("/api/update-check")) return json({ snapshot: { latestVersion: "0.7.0", isNewer: false, htmlUrl: "", publishedAt: "", checkedAt: "" } });
    if (url.endsWith("/api/health")) return json({ status: "ok" });
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) return json(session);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}

interface StubSocket {
  readyState: number;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: (() => void) | null;
}

const sockets: StubSocket[] = [];
let eventSeq = 0;

function emit(socket: StubSocket, event: Record<string, unknown>): void {
  eventSeq += 1;
  socket.onmessage?.({
    data: JSON.stringify({
      source: "agent",
      seq: eventSeq,
      sessionSeq: eventSeq,
      createdAt: "2026-07-28T00:00:01.000Z",
      ...event,
    }),
  } as MessageEvent);
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}

describe("App permission.request 按会话隔离", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    sockets.length = 0;
    eventSeq = 0;
    originalWebSocket = globalThis.WebSocket;
    class StubWebSocket implements StubSocket {
      readyState = 1;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor() { sockets.push(this); }
      close(): void { this.readyState = 3; }
      send(): void { /* no-op */ }
      addEventListener(): void { /* no-op */ }
      removeEventListener(): void { /* no-op */ }
    }
    vi.stubGlobal("WebSocket", StubWebSocket);
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as unknown as typeof window.matchMedia;
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  async function renderApp(): Promise<StubSocket> {
    installFetchMock();
    render(<QueryClientProvider client={makeClient()}><App /></QueryClientProvider>);
    // 等会话详情加载完成，确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(userText);
    return sockets[sockets.length - 1]!;
  }

  it("其他会话的 permission.request 不在当前轨道渲染权限卡，当前会话的正常渲染", async () => {
    const socket = await renderApp();

    // 其他会话（s2）的权限请求：不得污染当前会话的待决列表与轨道
    act(() => {
      emit(socket, { type: "permission.request", sessionId: "s2", payload: { requestId: "req-foreign", tool: "run_command", input: { command: "echo foreign" } } });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // 当前会话的权限请求：正常渲染权限卡
    act(() => {
      emit(socket, { type: "permission.request", sessionId: "s1", payload: { requestId: "req-own", tool: "run_command", input: { command: "echo own" } } });
    });
    const card = await screen.findByRole("alertdialog");
    expect(card).toHaveTextContent("run_command");
    expect(card).toHaveTextContent("echo own");
  });
});
