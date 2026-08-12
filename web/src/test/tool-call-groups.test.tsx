import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { groupCallsFromBlocks, ToolCallGroupRow, ToolCallListGroup, type ToolGroupCall } from "../chat/ToolCallGroups";
import { ChatActionsContext, type ChatActions } from "../chat/types";
import type { MessageContent } from "../lib/contracts";
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
