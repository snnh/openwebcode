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
  title: "错误提示测试作业",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: [], network: "deny" },
  messages: [{ id: "user-1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: userText }] }],
};

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

function installFetchMock(overrides: { updateCheck?: unknown; settings?: unknown } = {}): void {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") {
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes(`/api/sessions/${session.id}/messages`)) return json({ accepted: true });
      return json({ ok: true });
    }
    if (url.endsWith("/api/sessions")) return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.includes("/api/sessions/s1/context")) return json({ ledger: { usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 }, entries: [] }, preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" } });
    if (url.endsWith("/api/models")) return json(models);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/extensions")) return json([]);
    if (url.endsWith("/api/settings")) return json(overrides.settings ?? settingsView);
    if (url.endsWith("/api/update-check")) return json(overrides.updateCheck ?? updateAvailable);
    if (url.endsWith("/api/health")) return json({ status: "ok" });
    if (url.endsWith("/api/version")) return json({ server: "0.7.0", core: "0.7.0" });
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

describe("App agent.error 可操作提示与新版本通知", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    // jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：打桩为 open 属性开关
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
    sockets.length = 0;
    requests.length = 0;
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
    render(<QueryClientProvider client={makeClient()}><App /></QueryClientProvider>);
    // 等会话详情加载完成（用户消息渲染进轨道），确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(userText);
    return sockets[sockets.length - 1]!;
  }

  it("agent.error 按 kind 渲染提示与设置深链，toast 只给一句话摘要", async () => {
    installFetchMock();
    const socket = await renderApp();

    act(() => {
      emit(socket, { type: "agent.error", sessionId: "s1", payload: { message: "invalid api key", kind: "authentication", retryable: false } });
    });

    await screen.findByText("认证失败：请检查 设置 → 模型目录 中的 API Key");
    // toast 为短摘要，不粘贴原始信息
    const toast = document.querySelector(".toast");
    expect(toast?.textContent).toContain("任务失败：认证失败，请检查 API Key");
    expect(toast?.textContent).not.toContain("invalid api key");

    fireEvent.click(screen.getByRole("button", { name: "打开模型设置" }));
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="models"]')?.className).toContain("active");
    });
  });

  it("限流失败提供重试按钮，点击后重发最近一条用户消息", async () => {
    installFetchMock();
    const socket = await renderApp();

    act(() => {
      emit(socket, { type: "agent.error", sessionId: "s1", payload: { message: "rate limited", kind: "rate_limit", retryable: true } });
    });

    const retry = await screen.findByRole("button", { name: "重试" });
    fireEvent.click(retry);
    await waitFor(() => {
      const post = requests.find((request) => request.url.includes(`/api/sessions/${session.id}/messages`));
      expect(post?.method).toBe("POST");
      expect(post?.body).toMatchObject({ content: userText, behavior: "start" });
    });
  });

  it("发现新版本时通知一次（按版本去重），点击跳转设置服务信息页签", async () => {
    installFetchMock();
    const socket = await renderApp();

    // 打开通知中心，应有一条新版本通知
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /通知中心（1 条未读）/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /通知中心（1 条未读）/ }));
    await screen.findByText(/发现新版本 v9\.9\.9/);

    // 触发 settings 失效重取（同一版本），不应再次通知
    act(() => {
      emit(socket, { source: "server", type: "server.settings_updated" });
    });
    await waitFor(async () => {
      // 等失效重取完成后仍只有一条新版本通知
      expect(screen.getAllByText(/发现新版本 v9\.9\.9/)).toHaveLength(1);
    });

    // 点击通知跳转 设置 → 服务信息
    fireEvent.click(screen.getByRole("button", { name: /发现新版本 v9\.9\.9.*（点击跳转）/ }));
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="info"]')?.className).toContain("active");
    });
  });

  it("更新检查未启用时不通知", async () => {
    installFetchMock({
      settings: {
        groups: [{
          id: "updateCheck",
          label: "更新检查",
          fields: [{ key: "updateCheckEnabled", label: "启用更新检查", type: "boolean", value: false, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false }],
        }],
      },
    });
    await renderApp();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: /通知中心（1 条未读）/ })).toBeNull();
  });
});
