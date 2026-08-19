import { fireEvent, render, type RenderResult } from "@testing-library/react";
import * as axeCore from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { MemoMessageCard, MessageCard } from "../chat/MessageCard";
import { groupCallsFromBlocks, ToolCallGroupRow, ToolCallListGroup, type ToolGroupCall } from "../chat/ToolCallGroups";
import { CompactionRow } from "../chat/cards/CompactionRow";
import { ChatActionsContext, type ChatActions } from "../chat/types";
import { live, liveStore } from "../app/live-store";
import type { CompactionMarker } from "../lib/compaction";
import type { ChatMessage, MessageContent } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

// Markdown 走懒加载实现，测试换桩同步渲染
vi.mock("../components/MarkdownImpl", () => ({
  MarkdownBlock: ({ children }: { children: string }) => <div data-testid="md-block">{children}</div>,
}));

function makeChatActions(overrides: Partial<ChatActions> = {}): ChatActions {
  return {
    sessionId: "s1",
    running: false,
    onNotice: vi.fn(),
    onOpenDiff: vi.fn(),
    onSendToAgent: vi.fn(),
    onEditMessage: vi.fn(),
    onRegenerate: vi.fn(),
    onFork: vi.fn(),
    ...overrides,
  };
}

function renderWithActions(node: ReactElement, actions: ChatActions = makeChatActions()): RenderResult & { actions: ChatActions } {
  const result = renderWithClient(<ChatActionsContext.Provider value={actions}>{node}</ChatActionsContext.Provider>);
  return { ...result, actions };
}

function message(role: ChatMessage["role"], content: MessageContent[], id = "m1"): ChatMessage {
  return { id, role, createdAt: "2026-07-20T00:00:00.000Z", content };
}

function textMessage(role: ChatMessage["role"], texts: string[]): ChatMessage {
  return message(role, texts.map((text) => ({ type: "text", text })));
}

describe("MessageCard", () => {
  it("renders a user message as a right-aligned bubble with role class", () => {
    const { container } = renderWithActions(<MessageCard message={textMessage("user", ["帮我修个 bug"])} turn={1} toolResults={{}} />);
    const article = container.querySelector("article.message.user");
    expect(article).not.toBeNull();
    expect(article).toHaveAttribute("data-message-id", "m1");
    expect(article).toHaveClass("turn-odd");
    expect(container.querySelector(".markdown")).toHaveTextContent("帮我修个 bug");
  });

  it("coalesces persisted assistant stream fragments into one markdown block", () => {
    const { container } = renderWithActions(
      <MessageCard message={textMessage("assistant", ["探索", "代码", "库", "，", "我都可以", "帮忙。"])} turn={1} toolResults={{}} />,
    );
    expect(container.querySelectorAll(".markdown")).toHaveLength(1);
    expect(container.querySelector(".markdown")).toHaveTextContent("探索代码库，我都可以帮忙。");
    expect(container.querySelector(".message-author")).toHaveTextContent("OpenWebCode");
  });

  it("renders a tool message result as a compact result row", () => {
    const { container } = renderWithActions(
      <MessageCard message={message("tool", [{ type: "tool_result", toolCallId: "c1", content: "done" }])} turn={1} toolResults={{ c1: false }} />,
    );
    expect(container.querySelector(".tool-row")).not.toBeNull();
    expect(container.querySelector(".tool-row-name")).toHaveTextContent("执行结果");
  });

  it("renders thinking blocks collapsed as a details element", () => {
    const { container } = renderWithActions(
      <MessageCard message={message("assistant", [{ type: "thinking", text: "先想想" }, { type: "text", text: "结论" }])} turn={0} toolResults={{}} />,
    );
    const thinking = container.querySelector("details.thinking");
    expect(thinking).not.toBeNull();
    expect(thinking).not.toHaveAttribute("open");
    expect(thinking!.querySelector("summary")).toHaveTextContent("思考过程");
    expect(container.querySelector("article")).toHaveClass("turn-even");
  });

  it("pairs tool call status icons from toolResults", () => {
    const call = message("assistant", [{ type: "tool_call", id: "c1", name: "bash", input: { command: "ls" } }]);
    const done = renderWithActions(<MessageCard message={call} turn={1} toolResults={{ c1: false }} />);
    expect(done.container.querySelector(".tool-row-status.done")).not.toBeNull();
    done.unmount();

    const failed = renderWithActions(<MessageCard message={call} turn={1} toolResults={{ c1: true }} />);
    expect(failed.container.querySelector(".tool-row-status.error")).not.toBeNull();
    expect(failed.container.querySelector(".tool-row")).toHaveClass("error");
    failed.unmount();

    // 无配对结果且会话运行中 → running（脉动圆点）
    const running = renderWithActions(
      <MessageCard message={call} turn={1} toolResults={{}} />,
      makeChatActions({ running: true }),
    );
    expect(running.container.querySelector(".tool-row-status.running .tool-row-dot")).not.toBeNull();
  });

  it("shows user message actions; running disables edit/regenerate but not fork", () => {
    const userMessage = textMessage("user", ["问题"]);
    const idle = renderWithActions(<MessageCard message={userMessage} turn={1} toolResults={{}} />);
    expect(idle.getByText("编辑重发")).toBeEnabled();
    expect(idle.getByText("重新生成")).toBeEnabled();
    expect(idle.getByText("分叉")).toBeEnabled();
    fireEvent.click(idle.getByText("编辑重发"));
    expect(idle.actions.onEditMessage).toHaveBeenCalledWith(userMessage);
    fireEvent.click(idle.getByText("分叉"));
    expect(idle.actions.onFork).toHaveBeenCalledWith(userMessage);
    idle.unmount();

    const busy = renderWithActions(
      <MessageCard message={textMessage("user", ["问题"])} turn={1} toolResults={{}} />,
      makeChatActions({ running: true }),
    );
    expect(busy.getByText("编辑重发")).toBeDisabled();
    expect(busy.getByText("重新生成")).toBeDisabled();
    expect(busy.getByText("分叉")).toBeEnabled();
  });

  it("shows 发给 agent only when shellCmd 由列表配对得出，并携带原始命令与输出", () => {
    const shell = message("tool", [{ type: "tool_result", toolCallId: "shell-ab12cd34", content: "file.txt" }]);
    const { getByText, actions, unmount } = renderWithActions(<MessageCard message={shell} turn={1} toolResults={{}} shellCmd="ls" />);
    fireEvent.click(getByText("发给 agent"));
    expect(actions.onSendToAgent).toHaveBeenCalledWith("ls", "file.txt");
    unmount();

    // 无配对命令（前一条不是 user `!cmd` 消息）不渲染按钮
    const { queryByText } = renderWithActions(<MessageCard message={shell} turn={1} toolResults={{}} />);
    expect(queryByText("发给 agent")).toBeNull();
  });

  it("renders image attachments as data-url images", () => {
    const { container } = renderWithActions(
      <MessageCard message={message("user", [{ type: "image", mediaType: "image/png", data: "QUJD" }])} turn={1} toolResults={{}} />,
    );
    const image = container.querySelector("img.message-image");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", "data:image/png;base64,QUJD");
  });

  it("MemoMessageCard skips rerender when a rebuilt message object is equal", () => {
    const first = textMessage("assistant", ["回答"]);
    const actions = makeChatActions();
    const { container, rerender, queryByText } = render(
      <ChatActionsContext.Provider value={actions}>
        <MemoMessageCard message={first} turn={1} toolResults={{}} />
      </ChatActionsContext.Provider>,
    );
    expect(container.querySelector(".markdown")).toHaveTextContent("回答");
    // 事件重放重建的等值消息对象（引用不同、内容相同）不应改变渲染输出
    rerender(
      <ChatActionsContext.Provider value={actions}>
        <MemoMessageCard message={textMessage("assistant", ["回答"])} turn={1} toolResults={{}} />
      </ChatActionsContext.Provider>,
    );
    expect(container.querySelector(".markdown")).toHaveTextContent("回答");
    expect(queryByText("分叉")).toBeNull();
  });
});

function renderRow(node: ReactElement, actions: ChatActions = makeChatActions()) {
  const result = renderWithClient(<ChatActionsContext.Provider value={actions}>{node}</ChatActionsContext.Provider>);
  return { ...result, actions };
}

function call(overrides: Partial<ToolGroupCall> = {}): ToolGroupCall {
  return { id: "c1", name: "bash", status: "done", summary: "ls -la", argsText: '{\n  "command": "ls -la"\n}', ...overrides };
}

describe("groupCallsFromBlocks", () => {
  it("pairs tool_call with its tool_result and derives status from toolResults", () => {
    const blocks: MessageContent[] = [
      { type: "tool_call", id: "c1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", toolCallId: "c1", content: "out" },
    ];
    const calls = groupCallsFromBlocks(blocks, { c1: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "c1", name: "bash", status: "done", summary: "ls" });
    expect(calls[0]!.result).toMatchObject({ error: false, body: "out" });
  });

  it("marks error status and keeps orphan results as standalone rows", () => {
    const blocks: MessageContent[] = [
      { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.ts" } },
      { type: "tool_result", toolCallId: "orphan", content: "boom", isError: true },
    ];
    const calls = groupCallsFromBlocks(blocks, { c1: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.status).toBe("error");
    expect(calls[1]).toMatchObject({ id: "orphan", name: "", status: "error" });
    expect(calls[1]!.result?.body).toBe("boom");
  });

  it("treats calls without a paired result as running while the session runs", () => {
    const blocks: MessageContent[] = [{ type: "tool_call", id: "c1", name: "bash", input: {} }];
    expect(groupCallsFromBlocks(blocks, {}, true)[0]!.status).toBe("running");
    expect(groupCallsFromBlocks(blocks, {}, false)[0]!.status).toBeUndefined();
  });
});

describe("ToolCallGroupRow（单行形态）", () => {
  it("renders header with status icon/name/summary and expands to params", () => {
    const { container, getByText, queryByText } = renderRow(<ToolCallGroupRow call={call()} />);
    expect(container.querySelector(".tool-row-status.done")).not.toBeNull();
    expect(container.querySelector(".tool-row-name")).toHaveTextContent("bash");
    expect(container.querySelector(".tool-row-summary")).toHaveTextContent("ls -la");
    // 默认折叠
    expect(container.querySelector(".tool-row-body")).toBeNull();
    fireEvent.click(container.querySelector(".tool-row-header")!);
    expect(container.querySelector(".tool-row.open")).not.toBeNull();
    expect(getByText(/"command": "ls -la"/)).toBeInTheDocument();
    // 再点收起
    fireEvent.click(container.querySelector(".tool-row-header")!);
    expect(queryByText(/"command": "ls -la"/)).toBeNull();
  });

  it("opens write_file changes in the diff view via ChatActions.onOpenDiff", () => {
    const diffSpec = { source: "agent-write", path: "src/a.ts", content: "hello" } as const;
    const { container, getByText, actions } = renderRow(
      <ToolCallGroupRow call={call({ name: "write_file", diffSpec: { ...diffSpec } })} />,
    );
    fireEvent.click(container.querySelector(".tool-row-header")!);
    fireEvent.click(getByText("在 diff 中打开"));
    expect(actions.onOpenDiff).toHaveBeenCalledWith(diffSpec);
  });

  it("renders orphan result rows with the fallback name", () => {
    const { container } = renderRow(
      <ToolCallGroupRow call={call({ id: "r1", name: "", status: "error", summary: undefined, argsText: undefined, result: { error: true, body: "boom" } })} />,
    );
    expect(container.querySelector(".tool-row-name")).toHaveTextContent("执行结果");
    expect(container.querySelector(".tool-row-status.error")).not.toBeNull();
  });
});

describe("ToolCallListGroup（聚合组形态）", () => {
  const calls = [call({ id: "c1" }), call({ id: "c2", name: "read_file", summary: "a.ts" })];

  it("shows a collapsible header with call count and per-call rows", () => {
    const { container, getByText } = renderRow(<ToolCallListGroup calls={calls} defaultOpen />);
    expect(getByText("2 个工具调用")).toBeInTheDocument();
    expect(container.querySelector(".tool-group.open")).not.toBeNull();
    expect(container.querySelectorAll(".tool-group-body .tool-row")).toHaveLength(2);
    // 收起后行消失
    fireEvent.click(container.querySelector(".tool-group-header")!);
    expect(container.querySelector(".tool-group-body")).toBeNull();
  });

  it("is collapsed by default and reflects running/error state in the header", () => {
    const { container } = renderRow(<ToolCallListGroup calls={[call({ status: "running" }), call({ id: "c2" })]} />);
    expect(container.querySelector(".tool-group.open")).toBeNull();
    expect(container.querySelector(".tool-row-status.running .tool-row-dot")).not.toBeNull();

    const withError = renderRow(<ToolCallListGroup calls={[call({ status: "error" }), call({ id: "c2" })]} />);
    expect(withError.container.querySelector(".tool-group.error")).not.toBeNull();
  });
});

describe("文件提及链接（onOpenFile）", () => {
  it("diffSpec 存在且提供 onOpenFile 时渲染文件链接，点击打开编辑器", () => {
    const onOpenFile = vi.fn();
    const { container, actions } = renderRow(
      <ToolCallGroupRow call={call({ name: "edit_file", diffSpec: { source: "agent-edit", path: "src/b.ts", oldText: "a", newText: "b" } })} />,
      makeChatActions({ onOpenFile }),
    );
    fireEvent.click(container.querySelector(".tool-row-header")!);
    const link = container.querySelector(".tool-file-link")!;
    expect(link.textContent).toContain("src/b.ts");
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("src/b.ts");
    expect(actions.onOpenDiff).not.toHaveBeenCalled();
  });

  it("未提供 onOpenFile 时不渲染文件链接（降级）", () => {
    const { container } = renderRow(
      <ToolCallGroupRow call={call({ name: "write_file", diffSpec: { source: "agent-write", path: "src/a.ts", content: "x" } })} />,
    );
    fireEvent.click(container.querySelector(".tool-row-header")!);
    expect(container.querySelector(".tool-file-link")).toBeNull();
  });
});

function renderCompactionRow(marker: CompactionMarker) {
  return render(
    <ChatActionsContext.Provider value={makeChatActions()}>
      <CompactionRow marker={marker} />
    </ChatActionsContext.Provider>,
  );
}

function marker(overrides: Partial<CompactionMarker>): CompactionMarker {
  return {
    id: "compaction:2026-08-01T00:00:00.000Z",
    uptoIndex: 12,
    mode: "overview",
    forced: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "settled",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  liveStore.set({ subagents: {}, activities: {}, compactions: {} });
});

describe("CompactionRow", () => {
  it("运行中：spinner + 模式标注 + 强制徽标", () => {
    const { getByRole, getByText } = renderCompactionRow(marker({ id: "compaction:live", uptoIndex: -1, status: "running", forced: true, mode: "vault" }));
    expect(getByRole("status")).toBeTruthy();
    expect(getByText(/正在压缩上下文/)).toBeTruthy();
    expect(getByText(/档案库/)).toBeTruthy();
    expect(getByText("强制 85%")).toBeTruthy();
  });

  it("沉降：徽标 + 被替换条数与 token 估算；无摘要不可展开", () => {
    const { getByText, getByRole } = renderCompactionRow(marker({ replacedTokens: 1532 }));
    expect(getByText("上下文已压缩")).toBeTruthy();
    expect(getByText("手动")).toBeTruthy();
    expect(getByText("概览")).toBeTruthy();
    expect(getByText("压缩前 12 条消息 · 约 1.5k tokens")).toBeTruthy();
    const head = getByRole("button");
    expect(head.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBeNull();
  });

  it("带摘要可展开：指令清单 + 摘要 + 时间", async () => {
    const { getByRole, getByText, findByTestId, queryByText } = renderCompactionRow(marker({
      summary: "目标：完成压缩检查点",
      instructions: ["用中文回复"],
    }));
    const head = getByRole("button");
    expect(queryByText("目标：完成压缩检查点")).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("用中文回复")).toBeTruthy();
    expect((await findByTestId("md-block")).textContent).toContain("目标：完成压缩检查点");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  it("失败：role=alert 常驻行，可关闭", () => {
    live.applyCompactionEvent({ source: "agent", type: "context.compacting", sessionId: "s1", payload: { mode: "overview" } } as never);
    live.applyCompactionEvent({ source: "agent", type: "context.compact_failed", sessionId: "s1", payload: { message: "快速模型超时" } } as never);
    const failed = liveStore.get().compactions["s1"]![0]!;
    const { getByRole, getByText } = renderCompactionRow(failed);
    expect(getByRole("alert")).toBeTruthy();
    expect(getByText(/快速模型超时/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "关闭" }));
    expect(liveStore.get().compactions["s1"]).toEqual([]);
  });

  it("沉降行无 axe 违规", async () => {
    const { container } = renderCompactionRow(marker({ summary: "摘要", replacedTokens: 800 }));
    const results = await axeCore.run(container);
    expect(results.violations).toEqual([]);
  });
});
