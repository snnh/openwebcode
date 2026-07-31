import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { FakeFitAddon, FakeTerminal } from "./helpers/fake-xterm";
import { makeSession } from "./helpers/fixtures";
import { renderApp } from "./helpers/with-client";

vi.mock("../components/xterm-loader", () => ({
  loadXterm: () => Promise.resolve({ Terminal: FakeTerminal, FitAddon: FakeFitAddon }),
}));

const s1Text = "处理第一个任务";

const session1 = makeSession({
  id: "s1",
  title: "终端标签作业",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  messages: [{ id: "user-s1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: s1Text }] }],
});

function installFetchMock(): void {
  installAppFetchMock({
    session: session1,
    extra: (url, json) => {
      if (url.endsWith("/api/auth/status")) return json({ totpEnabled: false, authenticated: true, terminalAvailable: true, gateReasons: [] });
      return undefined;
    },
  });
}

interface StubSocket {
  url?: string;
  readyState: number;
  sent: string[];
  onopen: ((ev: Event) => void) | null;
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

function stubMatchMedia(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener() { /* no-op */ },
    removeListener() { /* no-op */ },
    addEventListener() { /* no-op */ },
    removeEventListener() { /* no-op */ },
    dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
}

describe("App 终端标签", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    window.localStorage.clear();
    sockets.length = 0;
    eventSeq = 0;
    originalWebSocket = globalThis.WebSocket;
    // 需要追踪 url/sent（PTY 帧断言），公共 stub-websocket 不覆盖，保留本地实现
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

  async function launchApp(): Promise<StubSocket> {
    installFetchMock();
    renderApp();
    await screen.findByText(s1Text);
    return sockets[sockets.length - 1]!;
  }

  it("活动栏终端按钮打开并选中终端标签；关闭标签回主对话", async () => {
    await launchApp();

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
    const socket = await launchApp();

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
    await launchApp();

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
