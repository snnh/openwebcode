import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageCard } from "../components/MessageCard";
import { api } from "../lib/api";
import type { ChatMessage } from "../lib/contracts";

function message(role: ChatMessage["role"], texts: string[]): ChatMessage {
  return {
    id: "message-1",
    role,
    createdAt: "2026-07-20T00:00:00.000Z",
    content: texts.map((text) => ({ type: "text", text })),
  };
}

describe("MessageCard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders persisted assistant stream fragments as one markdown block", () => {
    const { container } = render(<MessageCard message={message("assistant", ["探索", "代码", "库", "，", "我都可以", "帮忙。"])} />);

    expect(container.querySelectorAll(".markdown")).toHaveLength(1);
    expect(container.querySelector(".markdown")).toHaveTextContent("探索代码库，我都可以帮忙。");
  });

  it("keeps separate user text blocks separate", () => {
    const { container } = render(<MessageCard message={message("user", ["引用文件内容", "用户问题"])} />);

    expect(container.querySelectorAll(".markdown")).toHaveLength(2);
  });

  it("shows markdown-capable thinking in a collapsed, separate block", async () => {
    const thinkingMessage: ChatMessage = {
      ...message("assistant", ["最终答案"]),
      content: [
        { type: "thinking", text: "先计算 $x^2$" },
        { type: "text", text: "最终答案" },
      ],
    };
    const { container, getByText } = render(<MessageCard message={thinkingMessage} />);
    const details = container.querySelector("details.thinking");

    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(getByText("思考过程")).toBeInTheDocument();
    // Markdown 懒加载，等待 KaTeX 渲染完成
    await waitFor(() => expect(details?.querySelector(".katex")).toBeInTheDocument());
  });

  it("renders subagent transcript viewer for spawn tool results and loads on expand", async () => {
    const transcript = {
      id: "task-1",
      prompt: "调查 a.ts",
      startedAt: "2026-07-20T00:00:00.000Z",
      turns: 2,
      toolsUsed: ["read_file"],
      conclusion: "子代理结论",
      messages: [],
    };
    const spy = vi.spyOn(api, "subagentTranscript").mockResolvedValue(transcript);
    const toolMessage: ChatMessage = {
      id: "m-tool",
      role: "assistant",
      createdAt: "2026-07-20T00:00:00.000Z",
      content: [
        { type: "tool_call", id: "call-1", name: "spawn_task", input: { prompt: "调查 a.ts" } },
        { type: "tool_result", toolCallId: "call-1", content: "子代理结论", isError: false, subagentTaskIds: ["task-1"] },
      ],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MessageCard message={toolMessage} sessionId="s-1" />
      </QueryClientProvider>,
    );

    const details = container.querySelector("details.subagent-transcript");
    expect(details).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    (details as HTMLDetailsElement).open = true;
    fireEvent(details!, new Event("toggle"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s-1", "task-1"));
    await waitFor(() => expect(details?.querySelector(".subagent-transcript-prompt")).toHaveTextContent("调查 a.ts"));
    expect(details?.querySelector(".subagent-transcript-meta")).toHaveTextContent("2 轮");
  });
});
