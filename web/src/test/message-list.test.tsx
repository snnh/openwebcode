import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ChatMessage, MessageContent } from "../lib/contracts";
import type { MessageCardProps, MessageListProps, ProcessFoldProps, SearchBarProps } from "../chat/types";
import type { SearchMatch } from "../chat/search";
import { CONVERSATION_SEARCH_EVENT } from "../chat/types";
import { makeSession } from "./helpers/fixtures";

// 并行代理的占位/真实实现均替换为确定性桩，本测试只验证 MessageList 自身的接线
vi.mock("../chat/MessageCard", () => ({
  MemoMessageCard: ({ message }: MessageCardProps): ReactElement => (
    <article className="message" data-message-id={message.id}>{message.id}</article>
  ),
}));
vi.mock("../chat/ProcessFold", () => ({
  ProcessFold: ({ toolCalls, failed, children }: ProcessFoldProps): ReactElement => (
    <div className={`turn-process${failed ? " danger" : ""}`} data-tool-calls={toolCalls}>{children}</div>
  ),
}));
vi.mock("../chat/LiveStream", () => ({
  LiveStream: ({ blocks }: { blocks: unknown[] }): ReactElement => (
    <article className="message assistant live" data-testid="live-stream">{blocks.length} blocks</article>
  ),
}));
vi.mock("../chat/cards/PermissionCard", () => ({
  PermissionCard: ({ permission }: { permission: { requestId: string } }): ReactElement => (
    <div data-testid={`permission-${permission.requestId}`} />
  ),
}));
vi.mock("../chat/cards/RunErrorCard", () => ({
  RunErrorCard: ({ error }: { error: { message: string } }): ReactElement => (
    <section role="alert">{error.message}</section>
  ),
}));
vi.mock("../chat/cards/LiveActivityBar", () => ({
  LiveActivityBar: (): ReactElement => <div data-testid="live-activity" />,
}));
vi.mock("../chat/cards/CompactionRow", () => ({
  CompactionRow: ({ marker }: { marker: { id: string } }): ReactElement => <div data-compaction-id={marker.id} />,
}));
vi.mock("../chat/search", async () => {
  const actual = await vi.importActual<typeof import("../chat/search")>("../chat/search");
  return {
    ...actual,
    findMatches(messages: ChatMessage[], query: string): SearchMatch[] {
      if (!query.trim()) return [];
      const matches: SearchMatch[] = [];
      const needle = query.toLowerCase();
      for (const message of messages) {
        const text = message.content.map((block) => block.text ?? block.content ?? "").join("\n").toLowerCase();
        let from = 0;
        let occurrence = 0;
        for (;;) {
          const at = text.indexOf(needle, from);
          if (at < 0) break;
          matches.push({ messageId: message.id, occurrence });
          occurrence += 1;
          from = at + needle.length;
        }
      }
      return matches;
    },
    ConversationSearchBar(props: SearchBarProps): ReactElement {
      return (
        <div className="conversation-search">
          <input
            aria-label="搜索会话"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
          <span className="conversation-search-count">{props.total === 0 ? "无结果" : `${props.current + 1}/${props.total}`}</span>
        </div>
      );
    },
  };
});

import { MessageList } from "../chat/MessageList";

function msg(id: string, role: ChatMessage["role"], content: MessageContent[]): ChatMessage {
  return { id, role, content, createdAt: "2026-08-01T00:00:00.000Z" };
}

const text = (value: string): MessageContent => ({ type: "text", text: value });

function makeProps(overrides: Partial<MessageListProps> = {}): MessageListProps {
  return {
    session: makeSession({
      id: "s1",
      messages: [
        msg("u1", "user", [text("你好 hello")]),
        msg("a1", "assistant", [text("hello world")]),
      ],
    }),
    hasMoreMessages: false,
    loadingMore: false,
    onLoadMore: () => undefined,
    streamBlocks: [],
    permissions: [],
    liveSubagents: {},
    running: false,
    onPermissionDone: () => undefined,
    ...overrides,
  };
}

/** jsdom 无布局：为滚动容器桩上度量字段 */
function stubMetrics(track: Element, metrics: { scrollHeight: number; clientHeight: number }): void {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(track, key, { configurable: true, value });
  }
}

describe("MessageList", () => {
  it("渲染消息卡、流式区与权限卡", () => {
    const props = makeProps({
      streamBlocks: [{ id: "text:0", kind: "text", parts: ["正在输出"] }],
      permissions: [{ requestId: "req-1", tool: "bash", input: {} }],
    });
    const { container } = render(<MessageList {...props} />);

    const articles = container.querySelectorAll("article[data-message-id]");
    expect(Array.from(articles).map((el) => el.getAttribute("data-message-id"))).toEqual(["u1", "a1"]);
    expect(screen.getByTestId("live-stream")).toHaveTextContent("1 blocks");
    expect(screen.getByTestId("permission-req-1")).toBeInTheDocument();
  });

  it("runError 渲染错误卡；liveActivity 渲染活动条（文档流内末尾）", () => {
    const props = makeProps({
      runError: { message: "boom", retryable: true },
      liveActivity: { state: "tool", toolCount: 1 },
    });
    render(<MessageList {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByTestId("live-activity")).toBeInTheDocument();
  });

  it("空闲时连续过程消息折叠为过程段（含失败标记）", () => {
    const props = makeProps();
    props.session = makeSession({
      id: "s1",
      messages: [
        msg("u1", "user", [text("做件事")]),
        msg("a1", "assistant", [{ type: "tool_call", id: "c1", name: "glob" }]),
        msg("t1", "tool", [{ type: "tool_result", toolCallId: "c1", content: "bad", isError: true }]),
        msg("a2", "assistant", [text("完成")]),
      ],
    });
    const { container } = render(<MessageList {...props} />);
    const fold = container.querySelector(".turn-process")!;
    expect(fold).not.toBeNull();
    expect(fold).toHaveClass("danger");
    expect(fold.getAttribute("data-tool-calls")).toBe("1");
    // 折叠段内消息卡常驻 DOM（可被搜索）
    expect(fold.querySelector('article[data-message-id="t1"]')).not.toBeNull();
  });

  it("脱离跟随时显示「回到底部」浮钮，点击回底后隐藏", () => {
    const { container } = render(<MessageList {...makeProps()} />);
    const track = container.querySelector(".chat-track")!;
    stubMetrics(track, { scrollHeight: 2000, clientHeight: 500 });

    // 初始贴底（scrollTop 1500）：无浮钮
    (track as HTMLElement).scrollTop = 1500;
    fireEvent.scroll(track);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();

    // 用户上滚：浮钮出现
    (track as HTMLElement).scrollTop = 100;
    fireEvent.scroll(track);
    const button = screen.getByRole("button", { name: "回到底部" });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect((track as HTMLElement).scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
  });

  it("hasMoreMessages 时渲染顶部哨兵；loadingMore 显示加载细条", () => {
    const { container, rerender } = render(<MessageList {...makeProps({ hasMoreMessages: true })} />);
    expect(container.querySelector(".chat-top-sentinel")).not.toBeNull();

    rerender(<MessageList {...makeProps({ hasMoreMessages: true, loadingMore: true })} />);
    expect(screen.getByText("加载中…")).toBeInTheDocument();
  });

  it("空会话显示空态文案", () => {
    const props = makeProps();
    props.session = makeSession({ id: "s1", messages: [] });
    render(<MessageList {...props} />);
    expect(screen.getByText(/还没有消息/)).toBeInTheDocument();
  });

  it("Ctrl+F 事件打开搜索条，输入后统计命中并跳转激活", () => {
    const { container } = render(<MessageList {...makeProps()} />);
    fireEvent(window, new Event(CONVERSATION_SEARCH_EVENT));

    const input = screen.getByLabelText("搜索会话");
    fireEvent.change(input, { target: { value: "hello" } });

    // u1 一处、 a1 一处：共 2 处命中，当前第 1 处
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(container.querySelector('article[data-message-id="u1"]')).toHaveClass("conv-search-active");
  });

  it("clear 分隔线落在折叠段首时外置到折叠组之前", () => {
    const props = makeProps({ cleared: { uptoIndex: 1, at: "2026-08-01T00:00:00.000Z" } });
    props.session = makeSession({
      id: "s1",
      messageCount: 3,
      messages: [
        msg("u1", "user", [text("问")]),
        msg("a1", "assistant", [{ type: "thinking", text: "想" }]),
        msg("t1", "tool", [{ type: "tool_result", content: "ok" }]),
      ],
    });
    // 页偏移 0 → clearedLocal=1，恰为 fold 段首
    const { container } = render(<MessageList {...props} />);
    const divider = container.querySelector(".context-cleared-divider")!;
    expect(divider).not.toBeNull();
    // 分隔线在折叠组之外（下一个兄弟即折叠组），不被折进折叠区
    expect(divider.nextElementSibling).toHaveClass("turn-process");
    expect(container.querySelector(".turn-process .context-cleared-divider")).toBeNull();
    // 同族升级：分隔线带图标，清空时间经 title 悬浮可见
    expect(divider.querySelector("svg")).not.toBeNull();
    expect(divider.getAttribute("title")).toBe(new Date("2026-08-01T00:00:00.000Z").toLocaleString("zh-CN"));
  });

  it("clear 分隔线按 uptoMessageId 锚定：停在边界消息之后，新消息追加不贴底", () => {
    const props = makeProps({ cleared: { uptoIndex: 3, uptoMessageId: "t1", at: "2026-08-01T00:00:00.000Z" } });
    const session = (messageCount: number, messages: ChatMessage[]): void => {
      props.session = makeSession({ id: "s1", messageCount, messages });
    };
    const three = [
      msg("u1", "user", [text("问")]),
      msg("a1", "assistant", [text("答")]),
      msg("t1", "tool", [{ type: "tool_result", content: "ok" }]),
    ];
    session(3, three);
    const { container, rerender } = render(<MessageList {...props} />);
    const divider = container.querySelector(".context-cleared-divider")!;
    expect(divider).not.toBeNull();
    // 边界消息 t1 是最后一条：分隔线在其后（列表末尾，无后续兄弟）
    expect(divider.nextElementSibling).toBeNull();
    expect(container.querySelector(".turn-process [data-message-id=\"t1\"]")).not.toBeNull();
    // clear 后追加新消息：分隔线停留在 t1 之后、新消息之前——不随新消息贴底
    session(4, [...three, msg("u2", "user", [text("新问题")])]);
    rerender(<MessageList {...props} />);
    const dividerAfter = container.querySelector(".context-cleared-divider")!;
    expect(dividerAfter).not.toBeNull();
    expect(dividerAfter.previousElementSibling).toHaveClass("turn-process");
    expect(dividerAfter.nextElementSibling).toHaveAttribute("data-message-id", "u2");
  });

  it("clear 分隔线边界消息未加载时不渲染（翻页加载更早消息后自然就位）", () => {
    // uptoMessageId 指向的消息在分页窗口之外：findIndex=-1 → 暂不渲染
    const props = makeProps({ cleared: { uptoIndex: 5, uptoMessageId: "u0", at: "2026-08-01T00:00:00.000Z" } });
    props.session = makeSession({
      id: "s1",
      messageCount: 6,
      messages: [
        msg("u1", "user", [text("问")]),
        msg("a1", "assistant", [text("答")]),
      ],
    });
    const { container } = render(<MessageList {...props} />);
    expect(container.querySelector(".context-cleared-divider")).toBeNull();
  });

  it("压缩检查点行按插入位渲染（折叠段外置、尾部追加）", () => {
    const props = makeProps({
      compactions: [
        { id: "c1", uptoIndex: 2, mode: "overview", forced: false, createdAt: "2026-08-01T00:00:00.000Z", status: "settled" },
        { id: "c2", uptoIndex: -1, mode: "overview", forced: true, createdAt: "2026-08-01T01:00:00.000Z", status: "running" },
      ],
    });
    props.session = makeSession({
      id: "s1",
      messageCount: 3,
      messages: [
        msg("u1", "user", [text("问")]),
        msg("a1", "assistant", [{ type: "thinking", text: "想" }]),
        msg("t1", "tool", [{ type: "tool_result", content: "ok" }]),
      ],
    });
    const { container } = render(<MessageList {...props} />);
    const rows = Array.from(container.querySelectorAll("[data-compaction-id]"));
    expect(rows.map((row) => row.getAttribute("data-compaction-id"))).toEqual(["c1", "c2"]);
    // c1 插入位 2 落入折叠段 [1,3) → 外置到折叠组之前；c2 运行中占位在尾部
    expect(rows[0]!.nextElementSibling).toHaveClass("turn-process");
    expect(container.querySelector(".turn-process [data-compaction-id]")).toBeNull();
  });
});
