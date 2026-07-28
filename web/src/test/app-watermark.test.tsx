import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { ContextView, ModelProfile, SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "水位测试作业",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: [], network: "deny" },
  messages: [],
};

const models: ModelProfile[] = [
  { id: "claude-opus-4-8", provider: "anthropic", displayName: "Claude Opus 4.8", contextWindow: 128_000, maxOutput: 8_000, capabilities: { thinking: ["adaptive", "disabled"], effort: ["low", "high"], modalities: ["text"], imageOutput: false, tools: true } },
];

const context: ContextView = {
  ledger: {
    usage: { inputTokens: 1_200, outputTokens: 80, cacheRead: 0, cacheWrite: 0 },
    cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
    entries: [],
  },
  preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" },
};

function installFetchMock(): void {
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.includes("/api/sessions/s1/context")) return json(context);
    if (url.endsWith("/api/models")) return json(models);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/sandbox/capabilities")) return json({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试环境" } });
    if (url.includes("/api/sessions/s1/steering")) return json([]);
    if (url.includes("/api/sessions/s1/permissions")) return json([]);
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

describe("App 上下文窗口水位", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    sockets.length = 0;
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

  it("context.watermark 事件驱动 JobHeader 窗口占用 meter", async () => {
    installFetchMock();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );

    // 会话加载完成前没有 meter（标题同时出现在会话列表与 JobHeader）
    await screen.findAllByText("水位测试作业");
    expect(screen.queryByTestId("window-usage")).toBeNull();

    const socket = sockets[sockets.length - 1]!;
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          source: "server",
          type: "context.watermark",
          sessionId: "s1",
          seq: 1,
          sessionSeq: 1,
          createdAt: "2026-07-17T00:00:03.000Z",
          payload: {
            estimatedTokens: 45_000,
            contextWindow: 128_000,
            maxOutput: 8_000,
            workingBudget: 120_000,
            utilization: 0.363,
            segments: { system: 1_000, compactionSummary: 0, toolResults: 18_000, messages: 24_000, repoMap: 2_000, other: 0 },
            pinnedTokens: 0,
            buildMs: 0.8,
            incremental: true,
          },
        }),
      } as MessageEvent);
    });

    const meter = await screen.findByTestId("window-usage");
    expect(meter.textContent).toContain("45k/128k · 36%");
    expect(meter.dataset.level).toBe("normal");
  });
});
