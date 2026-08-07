import { fireEvent, render, type RenderResult } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { MemoMessageCard, MessageCard } from "../chat/MessageCard";
import { ChatActionsContext, type ChatActions } from "../chat/types";
import type { ChatMessage, MessageContent } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

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
