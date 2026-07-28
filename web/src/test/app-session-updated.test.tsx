import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { ModelProfile, SessionDetail, SettingsView } from "../lib/contracts";

const userText = "请处理这个任务";

const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "当前会话",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: [], network: "deny" },
  messages: [
    { id: "user-1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: userText }] },
    // 最近的「用户消息」是 `!` 前缀 shell 快捷消息：重试必须跳过它
    { id: "user-2", role: "user", createdAt: "2026-07-28T00:01:00.000Z", content: [{ type: "text", text: "!ls -la" }] },
  ],
};

const otherSession = { id: "s2", cwd: "/workspace/other", provider: "anthropic", model: "claude-opus-4-8", title: "另一个会话", createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z" };

const models: ModelProfile[] = [
  { id: "claude-opus-4-8", provider: "anthropic", displayName: "Claude Opus 4.8", contextWindow: 128_000, maxOutput: 8_000, capabilities: { thinking: ["adaptive", "disabled"], effort: ["low", "high"], modalities: ["text"], imageOutput: false, tools: true } },
];

const settingsView: SettingsView = {
  groups: [{
    id: "updateCheck",
    label: "更新检查",
    fields: [
      { key: "updateCheckEnabled", label: "启用更新检查", type: "boolean", value: true, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
    ],
  }],
};

const updateAvailable = {
  snapshot: { latestVersion: "9.9.9", isNewer: true, htmlUrl: "https://example.com/release", publishedAt: "2026-07-28T00:00:00.000Z", checkedAt: "2026-07-28T00:00:00.000Z" },
};

interface RecordedRequest { url: string; method: string; body?: unknown; }

const requests: RecordedRequest[] = [];
let sessionsGetCount = 0;
let detailGetCount = 0;
// holdSend=true 时 POST /messages 挂起，直到 releaseSend()（用于发送中禁用重试按钮的断言）
let heldSend: (() => void) | undefined;

function releaseSend(): void {
  heldSend?.();
  heldSend = undefined;
}

function installFetchMock(options: { holdSend?: boolean } = {}): void {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") {
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes(`/api/sessions/${session.id}/messages`)) {
        if (options.holdSend) return new Promise<Response>((resolve) => { heldSend = () => resolve(json({ accepted: true })); });
        return json({ accepted: true });
      }
      return json({ ok: true });
    }
    if (url.endsWith("/api/sessions")) {
      sessionsGetCount += 1;
      return json([
        { id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt },
        otherSession,
      ]);
    }
    if (url.includes("/api/sessions/s1/context")) return json({ ledger: { usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 }, entries: [] }, preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" } });
    if (url.endsWith("/api/models")) return json(models);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/extensions")) return json([]);
    if (url.endsWith("/api/settings")) return json(settingsView);
    if (url.endsWith("/api/update-check")) return json(updateAvailable);
    if (url.endsWith("/api/health")) return json({ status: "ok" });
    if (url.endsWith("/api/version")) return json({ server: "0.7.0", core: "0.7.0" });
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) {
      detailGetCount += 1;
      return json(session);
    }
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

describe("App 会话事件与重试行为", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    // jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：打桩为 open 属性开关
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
    Element.prototype.scrollTo = function scrollTo() { /* no-op */ } as typeof Element.prototype.scrollTo;
    sockets.length = 0;
    requests.length = 0;
    sessionsGetCount = 0;
    detailGetCount = 0;
    heldSend = undefined;
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
    releaseSend();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  async function renderApp(): Promise<StubSocket> {
    render(<QueryClientProvider client={makeClient()}><App /></QueryClientProvider>);
    // 等会话详情加载完成（用户消息渲染进轨道），确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(userText);
    return sockets[sockets.length - 1]!;
  }

  it("session.updated：非当前会话只刷新会话列表，当前会话同时刷新详情", async () => {
    installFetchMock();
    const socket = await renderApp();
    const sessionsBefore = sessionsGetCount;
    const detailBefore = detailGetCount;

    // 另一个客户端重命名了非当前会话：列表必须刷新（否则 rail 标题不更新），详情不刷
    act(() => {
      emit(socket, { type: "session.updated", sessionId: "s2", payload: { ...otherSession, title: "改名了" } });
    });
    await waitFor(() => expect(sessionsGetCount).toBeGreaterThan(sessionsBefore));
    expect(detailGetCount).toBe(detailBefore);

    // 当前会话的 session.updated：详情也刷新
    act(() => {
      emit(socket, { type: "session.updated", sessionId: "s1", payload: { ...session, title: "当前改名" } });
    });
    await waitFor(() => expect(detailGetCount).toBeGreaterThan(detailBefore));
  });

  it("重试跳过 `!` 前缀 shell 消息，重发最近一条真正的用户消息", async () => {
    installFetchMock();
    const socket = await renderApp();

    act(() => {
      emit(socket, { type: "agent.error", sessionId: "s1", payload: { message: "rate limited", kind: "rate_limit", retryable: true } });
    });

    const retry = await screen.findByRole("button", { name: "重试" });
    expect(retry.getAttribute("title")).toContain("附件不随重试重发");
    fireEvent.click(retry);
    await waitFor(() => {
      const post = requests.find((request) => request.url.includes(`/api/sessions/${session.id}/messages`));
      expect(post?.method).toBe("POST");
      expect(post?.body).toMatchObject({ content: userText, behavior: "start" });
    });
  });

  it("发送进行中重试按钮禁用，防止双击重发", async () => {
    installFetchMock({ holdSend: true });
    const socket = await renderApp();

    act(() => {
      emit(socket, { type: "agent.error", sessionId: "s1", payload: { message: "rate limited", kind: "rate_limit", retryable: true } });
    });

    const retry = await screen.findByRole("button", { name: "重试" });
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toBeDisabled());
    releaseSend();
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it("同一通知目标重复点击仍重新跳转设置页签", async () => {
    installFetchMock();
    await renderApp();

    const openNotifications = async (): Promise<void> => {
      fireEvent.click(screen.getByRole("button", { name: /通知中心/ }));
      await screen.findByText(/发现新版本 v9\.9\.9/);
    };
    const clickUpdateNotification = (): void => {
      fireEvent.click(screen.getByRole("button", { name: /发现新版本 v9\.9\.9.*（点击跳转）/ }));
    };

    await openNotifications();
    clickUpdateNotification();
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="info"]')?.className).toContain("active");
    });

    // 用户手动切到别的页签后再次点击同一通知：必须重新跳回服务信息页签
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="appearance"]')?.className).toContain("active");
    });
    await openNotifications();
    clickUpdateNotification();
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="info"]')?.className).toContain("active");
    });
  });
});
