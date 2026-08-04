import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeContextView, makeSession } from "./helpers/fixtures";
import { emitEvent, lastSocket, setupStubWebSocket, type StubSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

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

describe("App 主区子代理标签", () => {
  beforeEach(() => {
    // 底层面板页签/开合持久化在 localStorage（owc-panel-tab 等），用例间必须隔离
    window.localStorage.clear();
    stubMatchMedia(false);
  });

  async function launchApp(): Promise<StubSocket> {
    installFetchMock();
    renderApp();
    // 等首个会话详情加载完成，确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(s1Text);
    return lastSocket();
  }

  it("subagent.started 自动创建标签且不抢焦点，状态随 finished 流转", async () => {
    const socket = await launchApp();

    act(() => {
      started(socket, "s1", "call-1", "task-1", { agent: "scout" });
    });

    const tab = await screen.findByRole("tab", { name: "scout" });
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

    act(() => {
      started(socket, "s1", "call-1", "task-1", { agent: "scout" });
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
    expect(screen.getByRole("tab", { name: "主对话" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".subagent-tab-view")).toBeNull();
    expect(document.querySelector(".main-tab-panel[hidden]")).toBeNull();
  });

  it("关闭标签后同 toolCallId 的后续 started 不重开，面板手动打开仍可用", async () => {
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

    // 子代理面板手动「在标签中打开」仍然可用（并清除关闭标记）
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    const openButtons = await screen.findAllByRole("button", { name: "在标签中打开" });
    fireEvent.click(openButtons[0]!);
    const tab = await screen.findByRole("tab", { name: /群 2 项/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".subagent-tab-view")).toBeInTheDocument();
  });

  it("标签按会话隔离：切换会话互不串扰", async () => {
    const socket = await launchApp();

    act(() => {
      started(socket, "s1", "call-1", "task-1", { agent: "scout" });
    });
    await screen.findByRole("tab", { name: "scout" });

    // 切到 s2：s1 的标签不可见
    const link2 = [...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("另一个作业"))!;
    fireEvent.click(link2);
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
    const link1 = [...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("标签测试作业"))!;
    fireEvent.click(link1);
    await screen.findByRole("tab", { name: "scout" });
    expect(screen.queryByRole("tab", { name: "helper" })).toBeNull();
  });

  it("移动端同样渲染标签条（子代理标签与底部面板并存）", async () => {
    stubMatchMedia(true);
    const socket = await launchApp();

    act(() => {
      started(socket, "s1", "call-1", "task-1", { agent: "scout" });
    });
    // 窄屏不再隐藏标签条：started 自动创建标签（不抢焦点）
    await screen.findByRole("tab", { name: "scout" });
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });
});
