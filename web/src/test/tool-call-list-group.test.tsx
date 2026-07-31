import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageCard } from "../components/MessageCard";
import { ToolCallListGroup, groupCallsFromBlocks, type ToolGroupCall } from "../components/ToolCallListGroup";
import type { ChatMessage, MessageContent } from "../lib/contracts";

const bashBlocks: MessageContent[] = [
  { type: "tool_call", id: "c1", name: "bash", input: { command: "ls -la" } },
  { type: "tool_result", toolCallId: "c1", content: JSON.stringify({ exitCode: 0, output: [{ stream: "stdout", data: "a.ts\nb.ts" }] }) },
  { type: "tool_call", id: "c2", name: "read_file", input: { path: "a.ts" } },
  { type: "tool_result", toolCallId: "c2", content: JSON.stringify({ content: "文件内容", totalLines: 1 }) },
];

describe("groupCallsFromBlocks", () => {
  it("tool_call 与配对 tool_result 合并到同一行", () => {
    const calls = groupCallsFromBlocks(bashBlocks, { c1: false, c2: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: "c1", name: "bash", summary: "ls -la", status: "done" });
    expect(calls[0]?.result?.body).toBe("a.ts\nb.ts");
    expect(calls[0]?.result?.summary).toBe("exit 0");
    expect(calls[1]).toMatchObject({ id: "c2", name: "read_file", status: "done" });
    expect(calls[1]?.result?.body).toBe("文件内容");
  });

  it("无配对结果且会话运行中时状态为 running；结果 isError 驱动 error 状态", () => {
    const running = groupCallsFromBlocks([bashBlocks[0]!, bashBlocks[2]!], {}, true);
    expect(running.map((call) => call.status)).toEqual(["running", "running"]);
    const errorBlocks: MessageContent[] = [bashBlocks[0]!, { ...bashBlocks[1]!, isError: true }, bashBlocks[2]!, bashBlocks[3]!];
    const withError = groupCallsFromBlocks(errorBlocks, { c1: true, c2: false });
    expect(withError[0]?.status).toBe("error");
    expect(withError[0]?.result?.error).toBe(true);
  });

  it("孤儿结果（调用不在序列内）以纯结果行附加", () => {
    const orphan: MessageContent = { type: "tool_result", toolCallId: "c9", content: "ok" };
    const calls = groupCallsFromBlocks([bashBlocks[0]!, bashBlocks[2]!, orphan], { c1: false, c2: false, c9: false });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.name).toBe("");
    expect(calls[2]?.result?.body).toBe("ok");
  });
});

describe("ToolCallListGroup", () => {
  const doneCalls: ToolGroupCall[] = groupCallsFromBlocks(bashBlocks, { c1: false, c2: false });

  it("历史默认折叠：标题行展示数量与已完成状态，展开后一调用一行", () => {
    const { container, getByText, queryByText } = render(<ToolCallListGroup calls={doneCalls} />);
    const header = container.querySelector(".tool-group-header")!;

    expect(getByText("2 个工具调用")).toBeInTheDocument();
    expect(getByText("· 已完成")).toBeInTheDocument();
    // 折叠时组内行不渲染
    expect(queryByText("read_file")).toBeNull();

    fireEvent.click(header);
    expect(queryByText("bash")).toBeInTheDocument();
    expect(queryByText("read_file")).toBeInTheDocument();
    expect(queryByText("ls -la")).toBeInTheDocument();
  });

  it("行展开区同时展示参数与配对结果", () => {
    const { container, getByText, queryByText } = render(<ToolCallListGroup calls={doneCalls} defaultOpen />);
    const rows = container.querySelectorAll(".tool-group-row");
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]!.querySelector(".tool-row-header")!);
    // 参数 JSON 与结果正文均在展开区内
    expect(rows[0]!.textContent).toContain('"command": "ls -la"');
    expect(getByText(/执行结果 · exit 0/)).toBeInTheDocument();
    expect(rows[0]!.textContent).toContain("a.ts");
    expect(queryByText("read_file")).toBeInTheDocument();
  });
});

describe("MessageCard 历史分组渲染", () => {
  const groupMessage: ChatMessage = {
    id: "m-group",
    role: "assistant",
    createdAt: "2026-07-20T00:00:00.000Z",
    content: [
      { type: "text", text: "先看下文件" },
      ...bashBlocks,
      { type: "thinking", text: "继续分析" },
    ],
  };

  it("相邻调用合并为一个折叠组，text/thinking 原位渲染", () => {
    const { container } = render(
      <MessageCard message={groupMessage} toolResults={{ c1: false, c2: false }} />,
    );
    expect(container.querySelectorAll(".tool-group")).toHaveLength(1);
    // 组内调用不再以独立 tool-row 出现在顶层（折叠时组内行不渲染）
    expect(container.querySelectorAll("article > .tool-row")).toHaveLength(0);
    expect(container.querySelector("details.thinking")).toBeInTheDocument();
    expect(container.querySelector(".markdown")).toHaveTextContent("先看下文件");
  });

  it("单个孤立调用维持现有单行卡（不进组）", () => {
    const singleMessage: ChatMessage = {
      id: "m-single",
      role: "assistant",
      createdAt: "2026-07-20T00:00:00.000Z",
      content: [bashBlocks[0]!, bashBlocks[1]!],
    };
    const { container } = render(<MessageCard message={singleMessage} toolResults={{ c1: false }} />);
    expect(container.querySelectorAll(".tool-group")).toHaveLength(0);
    expect(container.querySelectorAll(".tool-row")).toHaveLength(2);
  });

  it("spawn_task 保留专用卡片，不进组", () => {
    const spawnMessage: ChatMessage = {
      id: "m-spawn-mix",
      role: "assistant",
      createdAt: "2026-07-20T00:00:00.000Z",
      content: [
        bashBlocks[0]!,
        { type: "tool_call", id: "c9", name: "spawn_task", input: { prompt: "调查" } },
        bashBlocks[2]!,
      ],
    };
    const { container } = render(<MessageCard message={spawnMessage} toolResults={{ c1: false, c2: false }} />);
    expect(container.querySelectorAll(".tool-group")).toHaveLength(0);
    expect(container.querySelector(".subagent-run")).toBeInTheDocument();
    expect(container.querySelectorAll(".tool-row")).toHaveLength(2);
  });
});
