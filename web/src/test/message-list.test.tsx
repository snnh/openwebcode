import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ChatMessage, MessageContent } from "../lib/contracts";
import type { CompactionMarker } from "../lib/compaction";
import type { MessageCardProps, MessageListProps, ProcessFoldProps } from "../chat/types";
import { CONVERSATION_SEARCH_EVENT } from "../chat/types";
import { buildRenderItems, collectProducedFiles, insertCompactionMarkers, insertProducedFiles, isProcess, turnOf } from "../chat/message-groups";
import { groupContentBlocks } from "../lib/content-groups";
import { makeSession } from "./helpers/fixtures";

// 并行代理的真实实现替换为确定性桩：只验证 MessageList 自身的接线；消息卡桩保留 .markdown 容器与正文文本，让搜索高亮（<mark>）可被断言。
vi.mock("../chat/MessageCard", () => ({
  MemoMessageCard: ({ message }: MessageCardProps): ReactElement => (
    <article data-message-id={message.id}><div className="markdown">{message.content.map((block) => block.text ?? "").join(" ")}</div></article>
  ),
}));
vi.mock("../chat/ProcessFold", () => ({
  ProcessFold: ({ toolCalls, failed, children }: ProcessFoldProps): ReactElement => <div data-testid="process-fold" data-tool-calls={toolCalls} data-failed={String(failed)}>{children}</div>,
}));
vi.mock("../chat/LiveStream", () => ({ LiveStream: ({ blocks }: { blocks: unknown[] }): ReactElement => <span data-testid="live-stream">{blocks.length} blocks</span> }));
vi.mock("../chat/cards/RunErrorCard", () => ({ RunErrorCard: ({ error }: { error: { message: string } }): ReactElement => <section role="alert">{error.message}</section> }));
vi.mock("../chat/cards/LiveActivityBar", () => ({ LiveActivityBar: (): ReactElement => <span data-testid="live-activity" /> }));
vi.mock("../chat/cards/CompactionRow", () => ({ CompactionRow: ({ marker }: { marker: { id: string } }): ReactElement => <span data-compaction-id={marker.id} /> }));
import { MessageList } from "../chat/MessageList";
const AT = "2026-08-01T00:00:00.000Z";
const text = (value: string): MessageContent => ({ type: "text", text: value }); const msg = (id: string, role: ChatMessage["role"], content: MessageContent[]): ChatMessage => ({ id, role, content, createdAt: AT });
const sessionOf = (messages: ChatMessage[]): ReturnType<typeof makeSession> => makeSession({ messageCount: messages.length, messages });
function propsOf(overrides: Partial<MessageListProps> = {}): MessageListProps {
  return {
    session: sessionOf([msg("u1", "user", [text("你好 hello")]), msg("a1", "assistant", [text("hello world")])]), hasMoreMessages: false,
    loadingMore: false, onLoadMore: () => undefined, streamBlocks: [], liveSubagents: {}, running: false, ...overrides,
  };
}
/** 滚动容器（jsdom 无布局，度量字段由用例自桩）。 */
const trackOf = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>(".chat-track")!;
const dividerOf = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>(".context-cleared-divider")!;
describe("MessageList 渲染", () => {
  it("渲染消息卡与流式区（runError 出错误卡、liveActivity 出活动条）；hasMoreMessages 出顶部哨兵、loadingMore 出加载细条、空会话出空态", () => {
    const { container, rerender } = render(
      <MessageList {...propsOf({
        hasMoreMessages: true,
        streamBlocks: [{ id: "text:0", kind: "text", parts: ["正在输出"] }],
        runError: { message: "boom", retryable: true },
        liveActivity: { state: "tool", toolCount: 1 },
      })} />,
    );
    expect([...container.querySelectorAll("article[data-message-id]")].map((el) => el.getAttribute("data-message-id"))).toEqual(["u1", "a1"]);
    expect(screen.getByTestId("live-stream")).toHaveTextContent("1 blocks");
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByTestId("live-activity")).toBeInTheDocument();
    rerender(<MessageList {...propsOf({ hasMoreMessages: true, loadingMore: true })} />);
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    rerender(<MessageList {...propsOf({ session: sessionOf([]) })} />);
    expect(screen.getByText(/还没有消息/)).toBeInTheDocument();
  });
  it("空闲时连续过程消息折叠为过程段（工具调用数 + 失败标记），段内消息卡常驻 DOM 可被搜索", () => {
    const session = sessionOf([
      msg("u1", "user", [text("做件事")]),
      msg("a1", "assistant", [{ type: "tool_call", id: "c1", name: "glob" }]),
      msg("t1", "tool", [{ type: "tool_result", toolCallId: "c1", content: "bad", isError: true }]),
      msg("a2", "assistant", [text("完成")]),
    ]);
    render(<MessageList {...propsOf({ session })} />);
    const fold = screen.getByTestId("process-fold");
    expect(fold).toHaveAttribute("data-tool-calls", "1");
    expect(fold).toHaveAttribute("data-failed", "true");
    expect(fold.querySelector('article[data-message-id="t1"]')).not.toBeNull();
  });
  it("scrollToBottomSignal 递增把列表滚到底；脱离跟随时出「回到底部」浮钮，点击后回底并隐藏", () => {
    const { container, rerender } = render(<MessageList {...propsOf()} />);
    const track = trackOf(container);
    Object.defineProperty(track, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(track, "clientHeight", { configurable: true, value: 500 });
    rerender(<MessageList {...propsOf({ scrollToBottomSignal: 1 })} />);
    expect(track.scrollTop).toBe(2000);
    track.scrollTop = 100;
    fireEvent.scroll(track);
    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));
    expect(track.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
  });
  it("Ctrl+F 打开搜索条：命中计数与当前命中高亮（下一个移动当前命中）", () => {
    const { container } = render(<MessageList {...propsOf()} />);
    fireEvent(window, new Event(CONVERSATION_SEARCH_EVENT));
    fireEvent.change(screen.getByLabelText("在对话中搜索"), { target: { value: "hello" } });
    // u1、a1 各一处命中：共 2 处，当前第 1 处
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(container.querySelector('article[data-message-id="u1"] mark')).toHaveTextContent("hello");
  });
  it("clear 分隔线锚定边界消息之后（追加新消息不贴底），落在折叠段首时外置到折叠组之前；边界消息未加载则不渲染", () => {
    const messages = [msg("u1", "user", [text("问")]), msg("a1", "assistant", [{ type: "tool_call", id: "c1", name: "glob" }]),
      msg("t1", "tool", [{ type: "tool_result", toolCallId: "c1", content: "ok" }])];
    const { container, rerender } = render(<MessageList {...propsOf({ session: sessionOf(messages), cleared: { uptoIndex: 3, uptoMessageId: "u1", at: AT } })} />);
    // 边界消息 u1 是 fold 段前一条：分隔线外置到折叠组之前，不被折进折叠区
    const divider = dividerOf(container);
    expect(divider.previousElementSibling).toHaveAttribute("data-message-id", "u1"); expect(divider.nextElementSibling).toHaveAttribute("data-testid", "process-fold");
    expect(screen.getByTestId("process-fold").querySelector(".context-cleared-divider")).toBeNull();
    // clear 后追加新消息：分隔线仍停在边界消息之后
    rerender(<MessageList {...propsOf({ session: sessionOf([...messages, msg("u2", "user", [text("新问题")])]), cleared: { uptoIndex: 3, uptoMessageId: "t1", at: AT } })} />);
    expect(container.querySelector('article[data-message-id="u2"]')!.previousElementSibling).toHaveAttribute("role", "separator");
    // 边界消息在分页窗口之外（未加载）：暂不渲染，翻页加载更早消息后自然就位
    rerender(<MessageList {...propsOf({ session: sessionOf(messages), cleared: { uptoIndex: 9, uptoMessageId: "u0", at: AT } })} />);
    expect(container.querySelectorAll(".context-cleared-divider")).toHaveLength(0);
  });
  it("压缩检查点行按插入位渲染：折叠段内的外置到折叠组之前，运行中占位追加在尾部", () => {
    const session = sessionOf([msg("u1", "user", [text("问")]), msg("a1", "assistant", [{ type: "thinking", text: "想" }]),
      msg("t1", "tool", [{ type: "tool_result", content: "ok" }])]);
    const compactions: CompactionMarker[] = [
      { id: "c1", uptoIndex: 2, mode: "overview", forced: false, createdAt: AT, status: "settled" },
      { id: "c2", uptoIndex: -1, mode: "overview", forced: true, createdAt: AT, status: "running" }];
    const { container } = render(<MessageList {...propsOf({ session, compactions })} />);
    const rows = [...container.querySelectorAll("[data-compaction-id]")];
    expect(rows.map((row) => row.getAttribute("data-compaction-id"))).toEqual(["c1", "c2"]);
    expect(rows[0]!.nextElementSibling).toHaveAttribute("data-testid", "process-fold");
  });
});
describe("轮次与过程段分组（纯函数）", () => {
  it("turnOf：user 开启一轮、其后 assistant/tool 归属该轮、首条 user 前为 0；isProcess 认 tool 与无正文 text 的 assistant", () => {
    const messages = [
      msg("a0", "assistant", [text("开场白")]),
      msg("u1", "user", [text("第一问")]),
      msg("a1", "assistant", [text("答一")]),
      msg("t1", "tool", [{ type: "tool_result", content: "ok" }]),
      msg("u2", "user", [text("第二问")]),
    ];
    expect(turnOf(messages)).toEqual([0, 1, 1, 1, 2]); expect(turnOf([])).toEqual([]);
    expect(isProcess([
      msg("u", "user", [text("问")]),
      msg("a-text", "assistant", [text("正式回复")]),
      msg("a-think", "assistant", [{ type: "thinking", text: "想一下" }]),
      msg("a-blank", "assistant", [text("   ")]),
      msg("t", "tool", [{ type: "tool_result", content: "x" }]),
    ])).toEqual([false, false, true, true, true]);
  });
  it("buildRenderItems：空闲时连续过程段合并为一个 fold（统计调用数与失败），运行中逐条渲染；无失败/纯 thinking 段与空列表", () => {
    const messages = [msg("u1", "user", [text("问")]), msg("a1", "assistant", [{ type: "tool_call", id: "c1", name: "read_file" }]),
      msg("t1", "tool", [{ type: "tool_result", toolCallId: "c1", content: "ok" }]),
      msg("a2", "assistant", [{ type: "tool_call", id: "c2", name: "edit_file" }, { type: "tool_call", id: "c3", name: "bash" }]),
      msg("t2", "tool", [{ type: "tool_result", toolCallId: "c2", content: "bad", isError: true }]), msg("a3", "assistant", [text("完成")]), msg("u2", "user", [text("再问")])];
    expect(buildRenderItems(messages, { foldProcess: true })).toEqual([
      { kind: "message", index: 0, showDivider: true }, { kind: "fold", start: 1, end: 5, toolCalls: 3, failed: true },
      { kind: "message", index: 5, showDivider: true }, { kind: "message", index: 6, showDivider: true },
    ]);
    const unfolded = buildRenderItems(messages, { foldProcess: false });
    expect(unfolded.every((item) => item.kind === "message")).toBe(true); expect(unfolded).toHaveLength(messages.length);
    expect(buildRenderItems([msg("a", "assistant", [{ type: "thinking", text: "嗯" }]), msg("t", "tool", [{ type: "tool_result", content: "ok" }])], { foldProcess: true }))
      .toEqual([{ kind: "fold", start: 0, end: 2, toolCalls: 0, failed: false }]);
    expect(buildRenderItems([], { foldProcess: true })).toEqual([]);
  });
});
describe("本轮产出文件行与内容块分组", () => {
  const writeCall = (path: string, id = "w1"): MessageContent => ({ type: "tool_call", id, name: "write_file", input: { path, content: "x" } });
  const editCall = (path: string, id = "e1"): MessageContent => ({ type: "tool_call", id, name: "edit_file", input: { path, oldText: "a", newText: "b" } });
  const call = (id: string, name = "read_file"): MessageContent => ({ type: "tool_call", id, name, input: { path: `${id}.ts` } });
  const result = (toolCallId: string): MessageContent => ({ type: "tool_result", toolCallId, content: "ok" });
  const kinds = (blocks: MessageContent[]): string[] => groupContentBlocks(blocks).map((group) => group.kind);
  it("collectProducedFiles：write/edit 按 path 去重保持出现序、其他工具忽略；insertProducedFiles：行落在本轮末尾（折叠组之后）、下一轮 user 之前，跨消息同轮去重，无产出轮与 turn 0 不插入，压缩检查点行不打断轮归属", () => {
    expect(collectProducedFiles([
      writeCall("src/a.ts", "1"), editCall("src/b.ts", "2"), writeCall("src/a.ts", "3"),
      { type: "tool_call", id: "4", name: "read_file", input: { path: "src/c.ts" } }, { type: "tool_call", id: "5", name: "bash", input: { command: "ls" } },
    ])).toEqual([{ path: "src/a.ts", action: "write" }, { path: "src/b.ts", action: "edit" }]);
    const conversation = [msg("a0", "assistant", [text("开场白")]), msg("u1", "user", [text("开始")]),
      msg("a1", "assistant", [writeCall("src/a.ts", "1")]), msg("t1", "tool", [{ type: "tool_result", toolCallId: "1", content: "ok" }]),
      msg("a2", "assistant", [editCall("src/a.ts", "2")]), msg("u2", "user", [text("继续")]), msg("a3", "assistant", [editCall("src/b.ts")])];
    const items = insertProducedFiles(buildRenderItems(conversation, { foldProcess: true }), conversation);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "fold", "files", "message", "fold", "files"]);
    expect(items[3]).toMatchObject({ turn: 1, files: [{ path: "src/a.ts", action: "write" }] }); expect(items[6]).toMatchObject({ turn: 2, files: [{ path: "src/b.ts", action: "edit" }] });
    const single = [msg("u1", "user", [text("开始")]), msg("a1", "assistant", [writeCall("src/a.ts")])];
    const marker: CompactionMarker = { id: "c1", uptoIndex: 1, mode: "overview", forced: false, createdAt: AT, status: "settled" };
    const withMarker = insertProducedFiles(insertCompactionMarkers(buildRenderItems(single, { foldProcess: true }), [{ position: 1, marker }], single.length), single);
    expect(withMarker.map((item) => item.kind)).toEqual(["message", "compaction", "fold", "files"]);
  });
  it("内容块分组：相邻 ≥2 个调用（含配对结果）合并为一组并保持原顺序；孤立/纯结果序列不合组，text、thinking、image 与 subagent 调用打断相邻性", () => {
    const groups = groupContentBlocks([call("c1"), result("c1"), call("c2"), result("c2")]);
    expect(groups.map((group) => group.kind)).toEqual(["tool-group"]);
    if (groups[0]?.kind === "tool-group") expect(groups[0].blocks.map((block) => block.type)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
    expect(kinds([])).toEqual([]);
    expect(kinds([call("c1"), result("c1")])).toEqual(["single", "single"]);
    expect(kinds([call("c1"), result("c1"), { type: "thinking", text: "想" }])).toEqual(["single", "single", "single"]);
    expect(kinds([call("c1"), call("c2", "spawn_task"), call("c3")])).toEqual(["single", "single", "single"]);
    expect(kinds([call("c1"), { type: "image", mediaType: "image/png", data: "b" }, call("c2")])).toEqual(["single", "single", "single"]);
    const mixed: MessageContent[] = [text("开头"), call("c1"), call("c2"), { type: "thinking", text: "再想" }, call("c3"), call("c4"), text("结尾")];
    expect(kinds(mixed)).toEqual(["single", "tool-group", "single", "tool-group", "single"]);
  });
});
