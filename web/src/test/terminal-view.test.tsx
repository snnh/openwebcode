import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "../terminal/TerminalView";
import { App } from "../app/App";
import { live } from "../app/live-store";
import { ui, uiStore } from "../app/ui-store";
import { auxViews } from "../workbench/aux-views";
import { tabActions } from "../workbench/tab-actions";
import type { AuthStatus } from "../lib/contracts";
import { api } from "../lib/api";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeContextView, makeSession } from "./helpers/fixtures";
import { FakeFitAddon, FakeTerminal } from "./helpers/fake-xterm";
import { emitEvent, lastSocket, setupStubWebSocket, type StubSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";

// api 层 mock 只覆盖 TerminalView 用到的两个方法；App 集成用例的其他 api 方法保留真实实现（fetch 层打桩）
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      authStatus: vi.fn(),
      session: vi.fn(),
    },
  };
});

const authStatus = vi.mocked(api.authStatus);
const sessionQuery = vi.mocked(api.session);

// xterm-loader 统一 mock：terminal-view 用 xtermState.fail 驱动加载失败分支；subagent-tabs 恒成功
const xtermState = { fail: false };
vi.mock("../components/xterm-loader", () => ({
  loadXterm: () => (xtermState.fail
    ? Promise.reject(new Error("boom"))
    : Promise.resolve({ Terminal: FakeTerminal, FitAddon: FakeFitAddon })),
}));

class TerminalStubSocket {
  static instances: TerminalStubSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) { TerminalStubSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  emit(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  frames(): unknown[] { return this.sent.map((raw) => JSON.parse(raw) as unknown); }
}

const session = makeSession({ id: "s1", cwd: "/workspace/project", title: "终端测试" });

function gate(partial: Partial<AuthStatus>): AuthStatus {
  return { totpEnabled: true, authenticated: true, terminalAvailable: true, gateReasons: [], ...partial };
}

async function connectedPty(): Promise<{ socket: TerminalStubSocket; term: FakeTerminal }> {
  await waitFor(() => expect(TerminalStubSocket.instances).toHaveLength(1));
  const socket = TerminalStubSocket.instances[0]!;
  const term = FakeTerminal.instances[0]!;
  act(() => socket.onopen?.());
  return { socket, term };
}

describe("TerminalView（真 PTY）", () => {
  beforeEach(() => {
    authStatus.mockReset();
    sessionQuery.mockReset();
    sessionQuery.mockResolvedValue(session);
    FakeTerminal.instances.length = 0;
    TerminalStubSocket.instances.length = 0;
    xtermState.fail = false;
    vi.stubGlobal("WebSocket", TerminalStubSocket);
    // ui-store 全局单例：用例间复位提示与设置深链状态
    uiStore.set({ notice: undefined, notifications: [], settingsOpen: false, settingsTab: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("生命周期：open → out 写入 xterm → in/resize 上行 → 卸载发送 close 并关 WS", async () => {
    authStatus.mockResolvedValue(gate({}));
    const view = renderWithClient(<TerminalView sessionId="s1" />);

    // cwd 与宿主机语义徽章
    expect(await screen.findByText(/宿主机终端 · 以应用身份运行 · 不经沙盒/)).toBeInTheDocument();
    expect(await screen.findByText("/workspace/project")).toBeInTheDocument();

    const { socket, term } = await connectedPty();
    expect(socket.url).toContain("/api/sessions/s1/terminal");
    expect(socket.frames()).toEqual([{ type: "open", cols: 80, rows: 24 }]);

    // opened 后状态条消失
    act(() => socket.emit({ type: "opened" }));
    await waitFor(() => expect(screen.queryByText(/正在连接终端/)).toBeNull());

    // out（base64）解码写进 xterm
    act(() => socket.emit({ type: "out", data: btoa("hello world") }));
    expect(term.written).toEqual(["hello world"]);

    // xterm 输入 → base64 上行 in；尺寸变化 → resize
    act(() => term.emitData("ls\r"));
    act(() => term.emitResize(100, 30));
    expect(socket.frames()[1]).toEqual({ type: "in", data: btoa("ls\r") });
    expect(socket.frames()[2]).toEqual({ type: "resize", cols: 100, rows: 30 });

    // 组件卸载：close 帧 + 关 WS + dispose xterm
    view.unmount();
    expect(socket.frames()[3]).toEqual({ type: "close" });
    expect(socket.closed).toBe(true);
    expect(term.disposed).toBe(true);
  });

  it("门槛不满足：渲染两条门槛状态与设置深链（ui.openSettings(remote)），不建 WS 不渲染 xterm", async () => {
    authStatus.mockResolvedValue(gate({ totpEnabled: false, terminalAvailable: false, gateReasons: ["totp_disabled", "host_not_loopback_or_lan"] }));
    renderWithClient(<TerminalView sessionId="s1" />);

    expect(await screen.findByText(/终端功能暂不可用/)).toBeInTheDocument();
    expect(screen.getByText(/TOTP 已开启/).textContent).toContain("❌");
    expect(screen.getByText(/监听地址为回环或局域网/).textContent).toContain("❌");

    fireEvent.click(screen.getByRole("button", { name: /远程访问/ }));
    expect(uiStore.get().settingsOpen).toBe(true);
    expect(uiStore.get().settingsTab?.tab).toBe("remote");

    expect(TerminalStubSocket.instances).toHaveLength(0);
    expect(FakeTerminal.instances).toHaveLength(0);
  });

  it("exit 帧：显示进程已退出提示（含退出码）", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);
    const { socket } = await connectedPty();

    act(() => socket.emit({ type: "exit", code: 3 }));
    expect(await screen.findByText(/退出码 3/)).toBeInTheDocument();
  });

  it("连接断开（非主动关闭）显示重连提示；重连发起新 PTY", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);
    const { socket } = await connectedPty();

    act(() => socket.onclose?.());
    expect(await screen.findByText(/连接已断开/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(TerminalStubSocket.instances).toHaveLength(2));
  });

  it("error 帧：错误态以 role=alert 展示，可重连", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);
    const { socket } = await connectedPty();
    act(() => socket.emit({ type: "error", message: "PTY 创建失败" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PTY 创建失败");
  });

  it("xterm 加载失败：错误态 + ui.notify 错误提示，不建 WS", async () => {
    xtermState.fail = true;
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("终端组件加载失败");
    await waitFor(() => expect(uiStore.get().notice).toEqual({ kind: "error", text: "终端组件加载失败" }));
    expect(TerminalStubSocket.instances).toHaveLength(0);
  });
});

const s1Text = "处理第一个任务";
const s2Text = "处理第二个任务";

const session1 = makeSession({
  id: "s1",
  title: "标签测试作业",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  messages: [{ id: "user-s1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: s1Text }] }],
});
const session2 = makeSession({
  id: "s2",
  title: "另一个作业",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  messages: [{ id: "user-s2", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: s2Text }] }],
});
const sessions = [session1, session2];

function installFetchMock(): void {
  installAppFetchMock({
    session: session1,
    extra: (url, json) => {
      if (url.endsWith("/api/sessions")) return json(sessions.map(({ messages: _messages, sandbox: _sandbox, ...summary }) => summary));
      if (url.endsWith("/api/auth/status")) return json({ totpEnabled: true, authenticated: true, terminalAvailable: true, gateReasons: [] });
      if (url.includes("/api/sessions/s2/context")) return json(makeContextView());
      if (url.match(new RegExp("/api/sessions/s2(\\?.*)?$"))) return json(session2);
      return undefined;
    },
  });
}

function started(socket: StubSocket, sessionId: string, toolCallId: string, taskId: string, extra: Record<string, unknown> = {}): void {
  emitEvent(socket, "subagent.started", { toolCallId, taskId, prompt: "调查代码结构", ...extra }, { sessionId });
}

function finished(socket: StubSocket, sessionId: string, toolCallId: string, taskId: string, status: "done" | "failed"): void {
  emitEvent(socket, "subagent.finished", { toolCallId, taskId, status, turns: 2, toolsUsed: ["read_file"] }, { sessionId });
}

/** 触发 scout 子代理 started 并等其标签出现（多个用例共用的启动步骤）。 */
async function openScoutTab(socket: StubSocket): Promise<HTMLElement> {
  act(() => {
    started(socket, "s1", "call-1", "task-1", { agent: "scout" });
  });
  return screen.findByRole("tab", { name: "scout" });
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

setupStubWebSocket();

describe("App 主区子代理/终端标签", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubMatchMedia(false);
    // 全局单例复位：会话选中、辅助视图、实时运行记录、动作桥
    ui.selectSession(undefined);
    auxViews.closeAll();
    live.removeSession("s1");
    live.removeSession("s2");
    tabActions.openSubagentTab = undefined;
    tabActions.openTerminal = undefined;
    // 顶层 mock 覆盖的 api 方法在此给默认值（与 fetch 打桩路由一致）；xterm 恒成功
    xtermState.fail = false;
    vi.mocked(api.session).mockImplementation(async (id) => (id === "s2" ? session2 : session1));
    vi.mocked(api.authStatus).mockResolvedValue({ totpEnabled: true, authenticated: true, terminalAvailable: true, gateReasons: [] });
  });

  async function launchApp(): Promise<StubSocket> {
    installFetchMock();
    renderWithClient(<App />);
    // 等首个会话详情加载完成，确保 sessionId 已设置、WS handler 闭包为最新
    await screen.findByText(s1Text);
    return lastSocket();
  }

  it("subagent.started 自动创建标签且不抢焦点，状态随 finished 流转", async () => {
    const socket = await launchApp();

    const tab = await openScoutTab(socket);
    // 不抢焦点：仍停留在「主对话」
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("aria-selected", "false");
    // 运行中：琥珀 spinner + 未选中注意样式
    expect(tab.querySelector(".subagent-run-pulse")).toBeInTheDocument();
    expect(tab.closest(".subagent-tab")).toHaveClass("attention");

    act(() => {
      finished(socket, "s1", "call-1", "task-1", "done");
    });
    await waitFor(() => {
      expect(tab.querySelector(".subagent-run-pulse")).toBeNull();
      expect(tab.closest(".subagent-tab")).toHaveAttribute("data-status", "done");
    });
    expect(tab.closest(".subagent-tab")).not.toHaveClass("attention");

    act(() => {
      started(socket, "s1", "call-2", "task-2", { agent: "reviewer" });
    });
    const failedTab = await screen.findByRole("tab", { name: "reviewer" });
    act(() => {
      finished(socket, "s1", "call-2", "task-2", "failed");
    });
    await waitFor(() => {
      expect(failedTab.closest(".subagent-tab")).toHaveAttribute("data-status", "failed");
    });
    expect(failedTab.querySelector(".subagent-tab-dot")).toHaveAttribute("data-status", "failed");
  });

  it("swarm 运行聚合为一个「群 N 项」标签", async () => {
    const socket = await launchApp();

    act(() => {
      started(socket, "s1", "call-9", "task-9a", { swarm: { index: 1, total: 4 } });
      started(socket, "s1", "call-9", "task-9b", { swarm: { index: 2, total: 4 } });
    });

    const tabs = await screen.findAllByRole("tab", { name: /群 4 项/ });
    expect(tabs).toHaveLength(1);
  });

  it("切换标签渲染该组运行视图，关闭标签回退对话", async () => {
    const socket = await launchApp();

    const tab = await openScoutTab(socket);

    fireEvent.click(tab);
    expect(tab).toHaveAttribute("aria-selected", "true");
    const view = document.querySelector(".subagent-tab-view");
    expect(view).toBeInTheDocument();
    expect(view?.querySelector(".subagent-run-task")).toHaveTextContent("调查代码结构");
    expect(view?.querySelector(".subagent-run-status")).toHaveTextContent("运行中");
    // 对话面板保持挂载但隐藏（滚动状态不丢）
    const chatPanel = document.querySelector(".main-tab-panel[hidden]");
    expect(chatPanel?.querySelector(".chat-track")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭标签 scout" }));
    expect(screen.queryByRole("tab", { name: "scout" })).toBeNull();
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".subagent-tab-view")).toBeNull();
    expect(document.querySelector(".main-tab-panel[hidden]")).toBeNull();
  });

  it("关闭标签后同 toolCallId 的后续 started 不重开，tabActions 手动打开仍可用", async () => {
    const socket = await launchApp();

    // swarm 第一项自动开标签
    act(() => {
      started(socket, "s1", "call-5", "task-5a", { swarm: { index: 1, total: 2 } });
    });
    await screen.findByRole("tab", { name: /群 2 项/ });

    // 用户主动关闭标签
    fireEvent.click(screen.getByRole("button", { name: /关闭标签 群 2 项/ }));
    expect(screen.queryByRole("tab", { name: /群 2 项/ })).toBeNull();

    // swarm 第二项 started（同 toolCallId）：不得重开已关闭的标签
    act(() => {
      started(socket, "s1", "call-5", "task-5b", { swarm: { index: 2, total: 2 } });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("tab", { name: /群 2 项/ })).toBeNull();

    // 手动「在标签中打开」（子代理面板经 tabActions 桥）：重建标签并聚焦（并清除关闭标记）
    act(() => tabActions.openSubagentTab?.("call-5"));
    const tab = await screen.findByRole("tab", { name: /群 2 项/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".subagent-tab-view")).toBeInTheDocument();
  });

  it("标签按会话隔离：切换会话互不串扰", async () => {
    const socket = await launchApp();

    await openScoutTab(socket);

    // 切到 s2：s1 的标签不可见
    act(() => ui.selectSession("s2"));
    await screen.findByText(s2Text);
    expect(screen.queryByRole("tab", { name: "scout" })).toBeNull();
    expect(screen.getByRole("tab", { name: "主对话" })).toBeInTheDocument();

    // s2 自己的 started 只开 s2 的标签
    act(() => {
      started(socket, "s2", "call-2", "task-2", { agent: "helper" });
    });
    await screen.findByRole("tab", { name: "helper" });
    expect(screen.queryByRole("tab", { name: "scout" })).toBeNull();

    // 切回 s1：scout 标签恢复，helper 不可见
    act(() => ui.selectSession("s1"));
    await screen.findByRole("tab", { name: "scout" });
    expect(screen.queryByRole("tab", { name: "helper" })).toBeNull();
  });

  it("移动端同样渲染标签条", async () => {
    stubMatchMedia(true);
    const socket = await launchApp();

    // 窄屏不隐藏标签条：started 自动创建标签（不抢焦点）
    await openScoutTab(socket);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("终端标签：tabActions.openTerminal 打开并选中，与子代理标签选中互斥，关闭回主对话", async () => {
    const socket = await launchApp();

    const subagentTab = await openScoutTab(socket);

    // 打开终端：终端标签出现并选中，主对话隐藏（保持挂载）
    act(() => tabActions.openTerminal?.());
    const terminalTab = await screen.findByRole("tab", { name: /终端/ });
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "false");
    await waitFor(() => expect(document.querySelector(".main-tab-panel[hidden] .chat-track")).toBeInTheDocument());
    // 终端面板挂载（hidden 时 PTY 不中断）
    expect(document.querySelector(".terminal-view")).toBeInTheDocument();

    // 选中子代理标签：终端选中取消（互斥），终端面板保持挂载但隐藏
    fireEvent.click(subagentTab);
    expect(subagentTab).toHaveAttribute("aria-selected", "true");
    expect(terminalTab).toHaveAttribute("aria-selected", "false");
    expect(document.querySelector(".main-tab-panel[hidden] .terminal-view")).toBeInTheDocument();

    // 再选终端 → 关闭终端：回主对话
    fireEvent.click(terminalTab);
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 终端" }));
    expect(screen.queryByRole("tab", { name: /终端/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".terminal-view")).toBeNull();
  });
});
