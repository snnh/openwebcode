import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { LiveStream } from "../chat/LiveStream";
import { ChatActionsContext, type ChatActions, type StreamBlock } from "../chat/types";
import { renderWithClient } from "./helpers/with-client";

function makeChatActions(overrides: Partial<ChatActions> = {}): ChatActions {
  return {
    sessionId: "s1",
    running: true,
    onNotice: vi.fn(),
    onOpenDiff: vi.fn(),
    onSendToAgent: vi.fn(),
    onEditMessage: vi.fn(),
    onRegenerate: vi.fn(),
    onFork: vi.fn(),
    ...overrides,
  };
}

function renderStream(node: ReactElement) {
  return renderWithClient(<ChatActionsContext.Provider value={makeChatActions()}>{node}</ChatActionsContext.Provider>);
}

function block(kind: StreamBlock["kind"], id: string, text: string, name?: string): StreamBlock {
  return { id, kind, parts: [text], ...(name !== undefined ? { name } : {}) };
}

describe("LiveStream", () => {
  it("renders nothing when there are no blocks", () => {
    const { container } = renderStream(<LiveStream blocks={[]} turn={1} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders text/thinking/tool blocks in order inside a live assistant article", () => {
    const blocks: StreamBlock[] = [
      block("text", "text:0", "先给结论"),
      block("thinking", "thinking:1", "推理过程"),
      block("tool", "t1", '{"command":"ls"}', "bash"),
      block("text", "text:2", "再看结果"),
    ];
    const { container } = renderStream(<LiveStream blocks={blocks} turn={1} />);
    const article = container.querySelector("article.message.assistant.live");
    expect(article).not.toBeNull();
    expect(article).toHaveClass("turn-odd");
    expect(article!.querySelector(".message-author")).toHaveTextContent("OpenWebCode");

    // 顺序：text → thinking → tool 行 → text
    const markdowns = article!.querySelectorAll(":scope > .markdown");
    expect(markdowns[0]).toHaveTextContent("先给结论");
    expect(markdowns[1]).toHaveTextContent("再看结果");
    const thinking = article!.querySelector("details.thinking.live");
    expect(thinking).not.toBeNull();
    expect(thinking!.querySelector("summary")).toHaveTextContent("正在思考");
    // 单个孤立 tool：单行调用卡（running 态），不成组
    expect(article!.querySelector(".tool-group")).toBeNull();
    expect(article!.querySelector(".tool-row")).not.toBeNull();
    expect(article!.querySelector(".tool-row-status.running")).not.toBeNull();
    // 流式光标
    expect(article!.querySelector(".cursor")).not.toBeNull();
  });

  it("tool blocks：相邻 ≥2 聚合默认展开、孤立单行流式参数", () => {
    // 相邻 ≥2 聚合为默认展开组
    const blocks: StreamBlock[] = [
      block("tool", "t1", '{"command":"ls"}', "bash"),
      block("tool", "t2", '{"path":"a.ts"}', "read_file"),
      block("text", "text:0", "收尾"),
    ];
    const { container } = renderStream(<LiveStream blocks={blocks} turn={2} />);
    const group = container.querySelector(".tool-group.open");
    expect(group).not.toBeNull();
    expect(container.querySelector(".tool-group-title")).toHaveTextContent("2 个工具调用");
    expect(container.querySelectorAll(".tool-group-body .tool-row")).toHaveLength(2);
    expect(container.querySelector("article")).toHaveClass("turn-even");

    // 孤立 tool：不成组、单行卡（running 态）
    const loneBlocks: StreamBlock[] = [block("tool", "t1", '{"comm', "bash")];
    const lone = renderStream(<LiveStream blocks={loneBlocks} turn={0} />).container;
    expect(lone.querySelector(".tool-group")).toBeNull();
    const row = lone.querySelector(".tool-row");
    expect(row).not.toBeNull();
    expect(row!.querySelector(".tool-row-name")).toHaveTextContent("bash");
  });
});
