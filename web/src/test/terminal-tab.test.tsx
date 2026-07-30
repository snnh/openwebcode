import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { ModelProfile, SessionDetail } from "../lib/contracts";

const s1Text = "处理第一个任务";

function makeSession(id: string, title: string, text: string): SessionDetail {
  return {
    id,
    cwd: "/workspace/project",
    provider: "anthropic",
    model: "claude-opus-4-8",
    title,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: [], network: "deny" },
    messages: [{ id: `user-${id}`, role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text }] }],
  };
}

const session1 = makeSession("s1", "终端标签作业", s1Text);
const sessions = [session1];

const models: ModelProfile[] = [
  { id: "claude-opus-4-8", provider: "anthropic", displayName: "Claude Opus 4.8", contextWindow: 128_000, maxOutput: 8_000, capabilities: { thinking: ["adaptive", "disabled"], effort: ["low", "high"], modalities: ["text"], imageOutput: false, tools: true } },
];

function installFetchMock(): void {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json(sessions.map(({ messages: _messages, sandbox: _sandbox, ...summary }) => summary));
    if (url.includes("/context")) return json({ ledger: { usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 }, entries: [] }, preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" } });
    if (url.endsWith("/api/models")) return json(models);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/extensions")) return json([]);
    if (url.endsWith("/api/settings")) return json({ groups: [] });
    if (url.endsWith("/api/update-check")) return json({ snapshot: { latestVersion: "0.7.0", isNewer: false, htmlUrl: "", publishedAt: "", checkedAt: "" } });
    if (url.endsWith("/api/health")) return json({ status: "ok" });
    if (url.endsWith("/api/auth/status")) return json({ totpEnabled: false, authenticated: true, terminalAvailable: true, gateReasons: [] });
    const detail = sessions.find((entry) => url.match(new RegExp(`/api/sessions/${entry.id}(\\?.*)?$`)));
    if (detail) return json(detail);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}

interface StubSocket {
  url?: string;
  readyState: number;
  sent: string[];
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: (() => void) | null;
}

/** jsdom 无真实布局，xterm 以最小假实现替代（终端标签测试只关心 WS 连接建立） */
class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) { this.options = options; }
  loadAddon(): void { /* no-op */ }
  open(): void { /* no-op */ }
  write(): void { /* no-op */ }
  onData(): { dispose(): void } { return { dispose: () => undefined }; }
  onResize(): { dispose(): void } { return { dispose: () => undefined }; }
  dispose(): void { /* no-op */ }
}

class FakeFitAddon {
  fit = vi.fn();
}

vi.mock("../components/xterm-loader", () => ({
  loadXterm: () => Promise.resolve({ Terminal: FakeTerminal, FitAddon: FakeFitAddon }),
}));

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

function stubMatchMedia(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}

describe("App 终端标签", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    window.localStorage.clear();
    sockets.length = 0;
    eventSeq = 0;
    originalWebSocket = globalThis.WebSocket;
    class StubWebSocket implements StubSocket {
      readyState = 1;
      sent: string[] = [];
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor(readonly url?: string) { sockets.push(this); }
      close(): void { this.readyState = 3; }
      send(data?: string): void { if (data !== undefined) this.sent.push(String(data)); }
      addEventListener(): void { /* no-op */ }
      removeEventListener(): void { /* no-op */ }
    }
    vi.stubGlobal("WebSocket", StubWebSocket);
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  async function renderApp(): Promise<StubSocket> {
    installFetchMock();
    render(<QueryClientProvider client={makeClient()}><App /></QueryClientProvider>);
    await screen.findByText(s1Text);
    return sockets[sockets.length - 1]!;
  }

  it("活动栏终端按钮打开并选中终端标签；关闭标签回主对话", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "终端" }));
    const tab = await screen.findByRole("tab", { name: "终端" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "false");
    // 主对话面板保持挂载但隐藏；终端面板可见
    const chatPanel = document.querySelector(".main-tab-panel[hidden]");
    expect(chatPanel?.querySelector(".execution-track")).toBeInTheDocument();
    expect(document.querySelector(".terminal-view")).toBeInTheDocument();

    // 回主对话：终端标签保留但取消选中
    fireEvent.click(screen.getByRole("tab", { name: "主对话" }));
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("aria-selected", "false");

    // 关闭终端标签：标签消失，回主对话
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 终端" }));
    expect(screen.queryByRole("tab", { name: "终端" })).toBeNull();
    expect(document.querySelector(".terminal-view")).toBeNull();
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "true");
  });

  it("选中互斥：subagent.started 后选子代理标签取消终端选中，再选终端清除子代理选中", async () => {
    const socket = await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "终端" }));
    await screen.findByRole("tab", { name: "终端" });

    act(() => {
      emit(socket, { type: "subagent.started", sessionId: "s1", payload: { toolCallId: "call-1", taskId: "task-1", prompt: "调查代码结构", agent: "scout" } });
    });
    const subagentTab = await screen.findByRole("tab", { name: "scout" });

    fireEvent.click(subagentTab);
    expect(subagentTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "终端" })).toHaveAttribute("aria-selected", "false");
    expect(document.querySelector(".subagent-tab-view")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "终端" }));
    expect(screen.getByRole("tab", { name: "终端" })).toHaveAttribute("aria-selected", "true");
    expect(subagentTab).toHaveAttribute("aria-selected", "false");
    expect(document.querySelector(".subagent-tab-view")).toBeNull();
    expect(document.querySelector(".terminal-view")).toBeInTheDocument();
  });

  it("终端标签打开后建立 PTY WebSocket 并上行 open 帧", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "终端" }));
    await screen.findByRole("tab", { name: "终端" });

    await waitFor(() => expect(sockets.some((socket) => socket.url?.includes("/api/sessions/s1/terminal"))).toBe(true));
    const pty = sockets.find((socket) => socket.url?.includes("/terminal"))!;
    await waitFor(() => expect(pty.onopen).not.toBeNull());
    act(() => pty.onopen?.({} as Event));

    await waitFor(() => expect(pty.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(pty.sent[0]!)).toEqual({ type: "open", cols: 80, rows: 24 });
  });
});
