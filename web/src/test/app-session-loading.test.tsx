import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { SessionDetail } from "../lib/contracts";

// 会话详情加载中的骨架屏：detail 查询挂起期间应渲染骨架而不是欢迎页
const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "骨架测试作业",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: [], network: "deny" },
  messages: [{ id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "请创建文件" }] }],
};

function installFetchMock(): { resolveDetail(): void } {
  let resolveDetail: () => void = () => undefined;
  const detailReady = new Promise<void>((resolve) => { resolveDetail = resolve; });
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.match(/\/api\/sessions\/s1(\?|$)/)) {
      await detailReady;
      return json(session);
    }
    if (url.endsWith("/api/sessions")) return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
  return { resolveDetail: () => resolveDetail() };
}

describe("App session loading skeleton", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    class StubWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
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

  it("renders the skeleton instead of the welcome screen while the detail query is in flight", async () => {
    const { resolveDetail } = installFetchMock();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    expect(await screen.findByTestId("session-skeleton")).toBeTruthy();
    expect(screen.queryByText("开始一项可回滚的编码作业")).toBeNull();

    // 详情返回后骨架消失，消息轨道出现
    resolveDetail();
    expect(await screen.findByText("请创建文件")).toBeTruthy();
    expect(screen.queryByTestId("session-skeleton")).toBeNull();
  });
});
