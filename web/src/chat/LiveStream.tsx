import type { ReactElement, ReactNode } from "react";
import { summarizeToolInput } from "../lib/tool-format";
import { Markdown } from "../components/Markdown";
import { useI18n } from "../i18n";
import { ThinkingBlock } from "./MessageCard";
import { ToolCallGroupRow, ToolCallListGroup, type ToolGroupCall } from "./ToolCallGroups";
import type { LiveStreamProps, StreamBlock } from "./types";

/** 流式工具调用块 → 组内行：参数增量原文在行内展开区展示；增量构成合法 JSON 时给出参数摘要 */
function streamGroupCall(block: StreamBlock, t: (chinese: string, english: string) => string): ToolGroupCall {
  const argsText = block.parts.join("");
  let summary: string | undefined;
  try {
    summary = summarizeToolInput(JSON.parse(argsText) as Record<string, unknown>);
  } catch {
    // 参数增量尚未构成合法 JSON：流式期间省略摘要
  }
  return { id: block.id, name: block.name ?? t("工具调用", "tool call"), status: "running", summary, argsText, argsStreaming: true };
}

/**
 * 流式区：text/thinking 原位渲染，相邻 tool（≥2）实时聚合为展开的工具调用组，
 * 单个孤立 tool 渲染为单行调用卡；末尾 .cursor 流式光标。
 * 折叠节奏：流式期间组默认展开；run 结束由持久化消息接管（历史默认折叠）。
 */
export function LiveStream({ blocks, turn }: LiveStreamProps): ReactElement | null {
  const { t } = useI18n();
  if (blocks.length === 0) return null;
  const items: ReactNode[] = [];
  for (let index = 0; index < blocks.length; ) {
    const block = blocks[index]!;
    if (block.kind === "tool") {
      const group: StreamBlock[] = [];
      while (index < blocks.length && blocks[index]!.kind === "tool") {
        group.push(blocks[index]!);
        index += 1;
      }
      const calls = group.map((tool) => streamGroupCall(tool, t));
      items.push(calls.length >= 2
        ? <ToolCallListGroup key={calls[0]!.id} calls={calls} defaultOpen />
        : <ToolCallGroupRow key={calls[0]!.id} call={calls[0]!} />);
    } else if (block.kind === "thinking") {
      items.push(<ThinkingBlock key={block.id} text={block.parts.join("")} streaming />);
      index += 1;
    } else {
      items.push(<Markdown key={block.id}>{block.parts.join("")}</Markdown>);
      index += 1;
    }
  }
  return (
    <article className={`message assistant live turn-${turn % 2 === 0 ? "even" : "odd"}`}>
      <div className="message-meta">
        <span className="message-author">OpenWebCode</span>
        <span>{t("正在输出", "Responding")}</span>
      </div>
      {items}
      <span className="cursor" aria-hidden />
    </article>
  );
}
