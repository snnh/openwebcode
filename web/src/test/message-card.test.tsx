import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageCard } from "../components/MessageCard";
import { api } from "../lib/api";
import type { ChatMessage, SubagentTranscript } from "../lib/contracts";
import { makeSubagentRun } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

function message(role: ChatMessage["role"], texts: string[]): ChatMessage {
  return {
    id: "message-1",
    role,
    createdAt: "2026-07-20T00:00:00.000Z",
    content: texts.map((text) => ({ type: "text", text })),
  };
}

/** 渲染携带子代理转录的工具消息，并展开工具行露出转录查看器 */
function renderToolMessageWithTranscript(content: ChatMessage["content"]): HTMLElement {
  const toolMessage: ChatMessage = {
    id: "m-tool",
    role: "assistant",
    createdAt: "2026-07-20T00:00:00.000Z",
    content,
  };
  const { container } = renderWithClient(<MessageCard message={toolMessage} sessionId="s-1" />);
  // 工具结果默认折叠为单行：先展开工具行，转录查看器在展开区内
  fireEvent.click(container.querySelector(".tool-row-header")!);
  return container;
}

/** 打开转录折叠（触发懒加载） */
function openTranscript(container: HTMLElement): HTMLDetailsElement {
  const details = container.querySelector("details.subagent-transcript")!;
  (details as HTMLDetailsElement).open = true;
  fireEvent(details, new Event("toggle"));
  return details as HTMLDetailsElement;
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

  it("adds a turn banding class when turn is provided, omits it otherwise", () => {
    const { container } = render(<MessageCard message={message("assistant", ["回答"])} turn={1} />);
    expect(container.querySelector("article.message")).toHaveClass("turn-odd");

    const { container: noTurn } = render(<MessageCard message={message("assistant", ["回答"])} />);
    expect(noTurn.querySelector("article.message")!.className).not.toMatch(/turn-(even|odd)/);
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
    const transcript: SubagentTranscript = {
      id: "task-1",
      prompt: "调查 a.ts",
      startedAt: "2026-07-20T00:00:00.000Z",
      turns: 2,
      toolsUsed: ["read_file"],
      conclusion: "子代理结论",
      messages: [
        { id: "sm-1", role: "user", createdAt: "2026-07-20T00:00:00.000Z", content: [{ type: "text", text: "调查 a.ts" }] },
        { id: "sm-2", role: "assistant", createdAt: "2026-07-20T00:00:01.000Z", content: [{ type: "tool_call", id: "sc-1", name: "read_file", input: { path: "a.ts" } }] },
        { id: "sm-3", role: "tool", createdAt: "2026-07-20T00:00:02.000Z", content: [{ type: "tool_result", toolCallId: "sc-1", content: "文件内容" }] },
      ],
    };
    const spy = vi.spyOn(api, "subagentTranscript").mockResolvedValue(transcript);
    const container = renderToolMessageWithTranscript([
      { type: "tool_call", id: "call-1", name: "spawn_task", input: { prompt: "调查 a.ts" } },
      { type: "tool_result", toolCallId: "call-1", content: "子代理结论", isError: false, subagentTaskIds: ["task-1"] },
    ]);

    const details = container.querySelector("details.subagent-transcript");
    expect(details).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    openTranscript(container);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s-1", "task-1"));
    await waitFor(() => expect(details?.querySelector(".subagent-transcript-prompt")).toHaveTextContent("调查 a.ts"));
    expect(details?.querySelector(".subagent-transcript-meta")).toHaveTextContent("2 轮");

    // 转录消息记录：角色行 + 工具调用/结果紧凑展示
    await waitFor(() => expect(details?.querySelector(".subagent-transcript-messages")).toBeInTheDocument());
    const rows = details!.querySelectorAll(".subagent-transcript-message");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector(".subagent-transcript-role")).toHaveTextContent("任务");
    expect(rows[1]!.querySelector(".subagent-transcript-tool")).toHaveTextContent("read_file · a.ts");
    expect(rows[2]!.querySelector(".subagent-transcript-result")).toBeInTheDocument();
  });

  it("folds long transcripts to the last 20 messages", async () => {
    const transcript: SubagentTranscript = {
      id: "task-long",
      prompt: "长任务",
      startedAt: "2026-07-20T00:00:00.000Z",
      turns: 13,
      toolsUsed: [],
      conclusion: "结论",
      messages: Array.from({ length: 25 }, (_, i) => ({
        id: `lm-${i}`,
        role: (i % 2 === 0 ? "assistant" : "tool") as ChatMessage["role"],
        createdAt: "2026-07-20T00:00:00.000Z",
        content: [{ type: "tool_result" as const, toolCallId: `c-${i}`, content: `结果 ${i}` }],
      })),
    };
    vi.spyOn(api, "subagentTranscript").mockResolvedValue(transcript);
    const container = renderToolMessageWithTranscript([
      { type: "tool_result", toolCallId: "call-1", content: "结论", isError: false, subagentTaskIds: ["task-long"] },
    ]);
    const details = openTranscript(container);
    await waitFor(() => expect(details.querySelector(".subagent-transcript-messages")).toBeInTheDocument());
    expect(details.querySelectorAll(".subagent-transcript-message")).toHaveLength(20);
    expect(details.querySelector(".subagent-transcript-messages > .subagent-transcript-status")).toHaveTextContent("仅显示最近 20 条");

    // 「展开全部」toggle：显示全部 25 条，再「收起」回到 20 条
    fireEvent.click(details.querySelector<HTMLButtonElement>(".subagent-transcript-fold-toggle")!);
    expect(details.querySelectorAll(".subagent-transcript-message")).toHaveLength(25);
    expect(details.querySelector(".subagent-transcript-messages > .subagent-transcript-status")).not.toHaveTextContent("仅显示最近 20 条");
    fireEvent.click(details.querySelector<HTMLButtonElement>(".subagent-transcript-fold-toggle")!);
    expect(details.querySelectorAll(".subagent-transcript-message")).toHaveLength(20);
  });

  it("renders spawn tool calls as dedicated cards with live status from props", () => {
    const spawnMessage: ChatMessage = {
      id: "m-spawn",
      role: "assistant",
      createdAt: "2026-07-20T00:00:00.000Z",
      content: [{ type: "tool_call", id: "call-9", name: "spawn_task", input: { prompt: "调查 b.ts" } }],
    };
    const { container } = render(
      <MessageCard
        message={spawnMessage}
        sessionId="s-1"
        liveSubagents={[makeSubagentRun({ taskId: "t-9", toolCallId: "call-9", prompt: "调查 b.ts" })]}
      />,
    );

    // 专用卡片取代通用 ToolCallCard：无参数 <details>（实时状态展示由 subagent-run-card 测试覆盖）
    expect(container.querySelector(".subagent-run")).toBeInTheDocument();
    expect(container.querySelector(".tool-detail")).not.toBeInTheDocument();
  });
});
