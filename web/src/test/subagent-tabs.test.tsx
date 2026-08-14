import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { live } from "../app/live-store";
import { ui } from "../app/ui-store";
import { auxViews } from "../workbench/aux-views";
import { tabActions } from "../workbench/tab-actions";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeContextView, makeSession } from "./helpers/fixtures";
import { FakeFitAddon, FakeTerminal } from "./helpers/fake-xterm";
import { emitEvent, lastSocket, setupStubWebSocket, type StubSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";

vi.mock("../components/xterm-loader", () => ({
  loadXterm: () => Promise.resolve({ Terminal: FakeTerminal, FitAddon: FakeFitAddon }),
}));

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
