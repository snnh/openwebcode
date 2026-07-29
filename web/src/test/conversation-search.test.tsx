import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionTrack } from "../components/ExecutionTrack";
import { CONVERSATION_SEARCH_EVENT } from "../components/ConversationSearch";
import { registerBuiltinCommands, type CommandActions } from "../commands/builtin";
import { resetCommands } from "../commands/registry";
import { useGlobalKeybindings } from "../commands/useKeybindings";
import type { ChatMessage, SessionDetail } from "../lib/contracts";

const baseSession: SessionDetail = {
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "会话内搜索",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
  messages: [],
};

const messages: ChatMessage[] = [
  { id: "m1", role: "user", createdAt: baseSession.createdAt, content: [{ type: "text", text: "hello world hello" }] },
  { id: "m2", role: "assistant", createdAt: baseSession.createdAt, content: [{ type: "text", text: "say hello again" }] },
  // 工具结果不参与匹配（避免噪音）
  { id: "m3", role: "tool", createdAt: baseSession.createdAt, content: [{ type: "tool_result", content: "hello from tool" }] },
  // thinking 块不参与匹配（仅 text 内容块）
  { id: "m4", role: "assistant", createdAt: baseSession.createdAt, content: [{ type: "thinking", text: "hello in thought" }, { type: "text", text: "nothing here" }] },
];

function stubActions(): CommandActions {
  return {
    showCommands: vi.fn(), quickOpen: vi.fn(), toggleSidebar: vi.fn(), toggleBottomPanel: vi.fn(),
    showView: vi.fn(), openSettings: vi.fn(), newSession: vi.fn(), importSession: vi.fn(),
    deleteCurrentSession: vi.fn(), sendDraft: vi.fn(), abortRun: vi.fn(), toggleTheme: vi.fn(),
    focusComposer: vi.fn(), nextSession: vi.fn(), previousSession: vi.fn(),
    showKeyboardShortcuts: vi.fn(), cycleZone: vi.fn(), showNotifications: vi.fn(),
    saveEditorFile: vi.fn(), toggleEditorSplit: vi.fn(),
    diffAcceptHunk: vi.fn(), diffRejectHunk: vi.fn(),
    // 与 App 动作面一致：经 window 事件桥接 ExecutionTrack
    findInConversation: () => window.dispatchEvent(new CustomEvent(CONVERSATION_SEARCH_EVENT)),
  };
}

function renderTrack(props: Partial<Parameters<typeof ExecutionTrack>[0]> = {}) {
  return render(
    <ExecutionTrack
      session={{ ...baseSession, messages }}
      streamText=""
      permissions={[]}
      onPermissionDone={() => undefined}
      {...props}
    />,
  );
}

/** 完整链路：window keydown → 默认键位 → 内建命令 → window 事件 → ExecutionTrack 打开 */
function Harness() {
  useGlobalKeybindings({ sessionActive: true });
  return <ExecutionTrack session={{ ...baseSession, messages }} streamText="" permissions={[]} onPermissionDone={() => undefined} />;
}

function openSearch(): HTMLElement {
  act(() => {
    window.dispatchEvent(new CustomEvent(CONVERSATION_SEARCH_EVENT));
  });
  return screen.getByRole("search");
}

function searchInput(): HTMLInputElement {
  return screen.getByLabelText("在对话中搜索") as HTMLInputElement;
}

function activeArticleId(container: HTMLElement): string | null | undefined {
  return container.querySelector("article.conv-search-active")?.getAttribute("data-message-id");
}

afterEach(() => resetCommands());

describe("会话内搜索：Ctrl+F 打开", () => {
  it("Ctrl+F 打开搜索条并聚焦输入框", () => {
    registerBuiltinCommands(() => stubActions());
    render(<Harness />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(searchInput()).toHaveFocus();
  });

  it("浮层打开（dialogOpen）时 Ctrl+F 不打开", () => {
    registerBuiltinCommands(() => stubActions());
    function DialogHarness() {
      useGlobalKeybindings({ sessionActive: true, dialogOpen: true });
      return <ExecutionTrack session={{ ...baseSession, messages }} streamText="" permissions={[]} onPermissionDone={() => undefined} />;
    }
    render(<DialogHarness />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("输入框（Composer）聚焦时 Ctrl+F 不打开", () => {
    registerBuiltinCommands(() => stubActions());
    render(
      <>
        <input aria-label="composer" />
        <Harness />
      </>,
    );
    const composer = screen.getByLabelText("composer");
    composer.focus();
    fireEvent.keyDown(composer, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("search")).toBeNull();
  });
});

describe("会话内搜索：匹配与导航", () => {
  it("查询计数仅覆盖 user/assistant 文本块（工具结果与 thinking 排除），并包裹 <mark>", async () => {
    const { container } = renderTrack();
    openSearch();
    fireEvent.change(searchInput(), { target: { value: "hello" } });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll("mark.conv-search-hit")).toHaveLength(3));
    expect(container.querySelectorAll("mark.conv-search-hit.active")).toHaveLength(1);
    expect(activeArticleId(container)).toBe("m1");
  });

  it("Enter 下一个、Shift+Enter 上一个，命中循环且 active 类随之移动", async () => {
    const { container } = renderTrack();
    openSearch();
    fireEvent.change(searchInput(), { target: { value: "hello" } });
    await waitFor(() => expect(container.querySelectorAll("mark.conv-search-hit")).toHaveLength(3));

    const input = searchInput();
    // m1 内有两次出现：第一次 Enter 仍停留在 m1，计数前进
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(activeArticleId(container)).toBe("m1");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("3/3")).toBeInTheDocument();
    expect(activeArticleId(container)).toBe("m2");
    // 末尾再 Enter 循环回首个命中
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(activeArticleId(container)).toBe("m1");
    // Shift+Enter 反向循环
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3/3")).toBeInTheDocument();
    expect(activeArticleId(container)).toBe("m2");
  });

  it("Esc 关闭搜索条并清除全部高亮", async () => {
    const { container } = renderTrack();
    openSearch();
    fireEvent.change(searchInput(), { target: { value: "hello" } });
    await waitFor(() => expect(container.querySelectorAll("mark.conv-search-hit")).toHaveLength(3));

    fireEvent.keyDown(searchInput(), { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(container.querySelectorAll("mark.conv-search-hit")).toHaveLength(0);
    expect(container.querySelectorAll(".conv-search-active")).toHaveLength(0);
  });

  it("无结果时显示提示并禁用导航按钮", () => {
    const { container } = renderTrack();
    openSearch();
    fireEvent.change(searchInput(), { target: { value: "zzz-no-match" } });
    expect(screen.getByText("无结果")).toBeInTheDocument();
    expect(container.querySelectorAll("mark.conv-search-hit")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "上一个" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一个" })).toBeDisabled();
  });

  it("上方还有未加载历史时提示「仅搜索已加载消息」", () => {
    const { unmount } = renderTrack({ hasMoreMessages: true, onLoadMore: () => undefined });
    openSearch();
    expect(screen.getByText("仅搜索已加载消息")).toBeInTheDocument();
    unmount();
    renderTrack();
    openSearch();
    expect(screen.queryByText("仅搜索已加载消息")).toBeNull();
  });
});
