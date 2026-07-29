import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { ModelProfile, SessionDetail } from "../lib/contracts";

const s1Text = "处理第一个任务";
const s2Text = "处理第二个任务";

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

const session1 = makeSession("s1", "标签测试作业", s1Text);
const session2 = makeSession("s2", "另一个作业", s2Text);
const sessions = [session1, session2];

const models: ModelProfile[] = [
  { id: "claude-opus-4-8", provider: "anthropic", displayName: "Claude Opus 4.8", contextWindow: 128_000, maxOutput: 8_000, capabilities: { thinking: ["adaptive", "disabled"], effort: ["low", "high"], modalities: ["text"], imageOutput: false, tools: true } },
];

function installFetchMock(): void {
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
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
    const detail = sessions.find((entry) => url.match(new RegExp(`/api/sessions/${entry.id}(\\?.*)?$`)));
    if (detail) return json(detail);
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

function started(sessionId: string, toolCallId: string, taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "subagent.started", sessionId, payload: { toolCallId, taskId, prompt: "调查代码结构", ...extra } };
}

function finished(sessionId: string, toolCallId: string, taskId: string, status: "done" | "failed"): Record<string, unknown> {
  return { type: "subagent.finished", sessionId, payload: { toolCallId, taskId, status, turns: 2, toolsUsed: ["read_file"] } };
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

describe("App 主区子代理标签", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    // 底层面板页签/开合持久化在 localStorage（owc-panel-tab 等），用例间必须隔离
    window.localStorage.clear();
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
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  async function renderApp(): Promise<StubSocket> {
    installFetchMock();
    render(<QueryClientProvider client={makeClient()}><App /></QueryClientProvider>);
    // 等首个会话详情加载完成，确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(s1Text);
    return sockets[sockets.length - 1]!;
  }

  it("subagent.started 自动创建标签且不抢焦点，状态随 finished 流转", async () => {
    const socket = await renderApp();

    act(() => {
      emit(socket, started("s1", "call-1", "task-1", { agent: "scout" }));
    });

    const tab = await screen.findByRole("tab", { name: "scout" });
    // 不抢焦点：仍停留在「对话」
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("aria-selected", "false");
    // 运行中：琥珀 spinner + 未选中注意样式
    expect(tab.querySelector(".subagent-run-spinner")).toBeInTheDocument();
    expect(tab.closest(".subagent-tab")).toHaveClass("attention");

    act(() => {
      emit(socket, finished("s1", "call-1", "task-1", "done"));
    });
    await waitFor(() => {
      expect(tab.querySelector(".subagent-run-spinner")).toBeNull();
      expect(tab.closest(".subagent-tab")).toHaveAttribute("data-status", "done");
    });
    expect(tab.closest(".subagent-tab")).not.toHaveClass("attention");

    act(() => {
      emit(socket, started("s1", "call-2", "task-2", { agent: "reviewer" }));
    });
    const failedTab = await screen.findByRole("tab", { name: "reviewer" });
    act(() => {
      emit(socket, finished("s1", "call-2", "task-2", "failed"));
    });
    await waitFor(() => {
      expect(failedTab.closest(".subagent-tab")).toHaveAttribute("data-status", "failed");
    });
    expect(failedTab.querySelector(".subagent-tab-dot")).toHaveAttribute("data-status", "failed");
  });

  it("swarm 运行聚合为一个「群 N 项」标签", async () => {
    const socket = await renderApp();

    act(() => {
      emit(socket, started("s1", "call-9", "task-9a", { swarm: { index: 1, total: 4 } }));
      emit(socket, started("s1", "call-9", "task-9b", { swarm: { index: 2, total: 4 } }));
    });

    const tabs = await screen.findAllByRole("tab", { name: /群 4 项/ });
    expect(tabs).toHaveLength(1);
  });

  it("切换标签渲染该组运行视图，关闭标签回退对话", async () => {
    const socket = await renderApp();

    act(() => {
      emit(socket, started("s1", "call-1", "task-1", { agent: "scout" }));
    });
    const tab = await screen.findByRole("tab", { name: "scout" });

    fireEvent.click(tab);
    expect(tab).toHaveAttribute("aria-selected", "true");
    const view = document.querySelector(".subagent-tab-view");
    expect(view).toBeInTheDocument();
    expect(view?.querySelector(".subagent-run-task")).toHaveTextContent("调查代码结构");
    expect(view?.querySelector(".subagent-run-status")).toHaveTextContent("运行中");
    // 对话面板保持挂载但隐藏（滚动状态不丢）
    const chatPanel = document.querySelector(".main-tab-panel[hidden]");
    expect(chatPanel?.querySelector(".execution-track")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭标签 scout" }));
    expect(screen.queryByRole("tab", { name: "scout" })).toBeNull();
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".subagent-tab-view")).toBeNull();
    expect(document.querySelector(".main-tab-panel[hidden]")).toBeNull();
  });

  it("关闭标签后同 toolCallId 的后续 started 不重开，面板手动打开仍可用", async () => {
    const socket = await renderApp();

    // swarm 第一项自动开标签
    act(() => {
      emit(socket, started("s1", "call-5", "task-5a", { swarm: { index: 1, total: 2 } }));
    });
    await screen.findByRole("tab", { name: /群 2 项/ });

    // 用户主动关闭标签
    fireEvent.click(screen.getByRole("button", { name: /关闭标签 群 2 项/ }));
    expect(screen.queryByRole("tab", { name: /群 2 项/ })).toBeNull();

    // swarm 第二项 started（同 toolCallId）：不得重开已关闭的标签
    act(() => {
      emit(socket, started("s1", "call-5", "task-5b", { swarm: { index: 2, total: 2 } }));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("tab", { name: /群 2 项/ })).toBeNull();

    // 子代理面板手动「在标签中打开」仍然可用（并清除关闭标记）
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    const openButtons = await screen.findAllByRole("button", { name: "在标签中打开" });
    fireEvent.click(openButtons[0]!);
    const tab = await screen.findByRole("tab", { name: /群 2 项/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".subagent-tab-view")).toBeInTheDocument();
  });

  it("标签按会话隔离：切换会话互不串扰", async () => {
    const socket = await renderApp();

    act(() => {
      emit(socket, started("s1", "call-1", "task-1", { agent: "scout" }));
    });
    await screen.findByRole("tab", { name: "scout" });

    // 切到 s2：s1 的标签不可见
    const link2 = [...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("另一个作业"))!;
    fireEvent.click(link2);
    await screen.findByText(s2Text);
    expect(screen.queryByRole("tab", { name: "scout" })).toBeNull();
    expect(screen.getByRole("tab", { name: "对话" })).toBeInTheDocument();

    // s2 自己的 started 只开 s2 的标签
    act(() => {
      emit(socket, started("s2", "call-2", "task-2", { agent: "helper" }));
    });
    await screen.findByRole("tab", { name: "helper" });
    expect(screen.queryByRole("tab", { name: "scout" })).toBeNull();

    // 切回 s1：scout 标签恢复，helper 不可见
    const link1 = [...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("标签测试作业"))!;
    fireEvent.click(link1);
    await screen.findByRole("tab", { name: "scout" });
    expect(screen.queryByRole("tab", { name: "helper" })).toBeNull();
  });

  it("移动端隐藏标签条（子代理仍走底部面板）", async () => {
    stubMatchMedia(true);
    const socket = await renderApp();

    act(() => {
      emit(socket, started("s1", "call-1", "task-1", { agent: "scout" }));
    });
    // 等运行状态落库（底部面板数据）后仍无标签条
    await screen.findByText(s1Text);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "scout" })).toBeNull();
  });
});
