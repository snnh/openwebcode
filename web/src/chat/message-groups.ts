import type { ChatMessage, MessageContent } from "../lib/contracts";
import type { CompactionMarker } from "../lib/compaction";

/**
 * 消息分组纯函数（移植旧 ExecutionTrack 的轮次/过程段逻辑）：
 * - turnOf：一条 user 消息开启一轮，其后的 assistant/tool 归属该轮（首条 user 前为 0）。
 * - isProcess：tool 角色消息，或无正文 text 块的 assistant 消息（纯 thinking / 纯 tool_call）。
 * - buildRenderItems：会话空闲时连续过程消息段整体折叠为一个折叠组；
 *   clear 分隔线落在折叠段首时由调用方外置渲染（见 showDivider 注释）。
 * - insertCompactionMarkers：把压缩检查点行按消息下标插入渲染序列；
 *   插入位落入折叠段时外置到折叠组之前（与段首分隔线同规则，不折进折叠区）。
 * - insertProducedFiles：把「本轮产出文件」行插入每轮末尾（轮内含折叠段时置于折叠组之后）。
 */

export type RenderItem =
  | {
      kind: "message";
      index: number;
      /**
       * 是否在本条目前渲染 clear 分隔线（clearedLocal === index 时）。
       * 折叠段内条目的分隔线一律抑制——段首的由调用方外置到折叠组之前，
       * 段内深处的按旧行为不渲染（避免折进折叠区不可见）。
       */
      showDivider: boolean;
    }
  | {
      kind: "fold";
      /** 段内首条消息下标（含） */
      start: number;
      /** 段内末条消息下标（不含） */
      end: number;
      toolCalls: number;
      failed: boolean;
    }
  | {
      kind: "compaction";
      marker: CompactionMarker;
    }
  | {
      kind: "files";
      /** 所属轮次编号（user 消息开启一轮），仅作渲染 key 与语义标识 */
      turn: number;
      files: ProducedFile[];
    };

/** 本轮产出文件：write_file/edit_file 工具调用按 path 去重（先出现者优先） */
export interface ProducedFile {
  path: string;
  action: "write" | "edit";
}

export function turnOf(messages: ChatMessage[]): number[] {
  const values: number[] = [];
  let turn = 0;
  for (const message of messages) {
    if (message.role === "user") turn += 1;
    values.push(turn);
  }
  return values;
}

export function isProcess(messages: ChatMessage[]): boolean[] {
  return messages.map((message) => {
    if (message.role === "tool") return true;
    if (message.role !== "assistant") return false;
    return !message.content.some((block) => block.type === "text" && (block.text ?? "").trim());
  });
}

export function buildRenderItems(
  messages: ChatMessage[],
  opts: { foldProcess: boolean; clearedLocal?: number },
): RenderItem[] {
  const process = isProcess(messages);
  const items: RenderItem[] = [];
  for (let index = 0; index < messages.length; ) {
    if (!opts.foldProcess || !process[index]) {
      items.push({ kind: "message", index, showDivider: true });
      index += 1;
      continue;
    }
    // 连续过程消息段 → 单个折叠组（原生 <details> 由调用方渲染，内容常驻 DOM 可被搜索）
    let end = index + 1;
    while (end < messages.length && process[end]) end += 1;
    let toolCalls = 0;
    let failed = false;
    for (let i = index; i < end; i += 1) {
      for (const block of messages[i]!.content) {
        if (block.type === "tool_call") toolCalls += 1;
        if (block.type === "tool_result" && block.isError) failed = true;
      }
    }
    items.push({ kind: "fold", start: index, end, toolCalls, failed });
    index = end;
  }
  return items;
}

/**
 * 压缩检查点插入：marks 为（消息下标 insertion point, marker）对。
 * 语义：检查点行渲染在下标 position 的消息之前（即被压缩段 messages[0..position) 之后）；
 * position === messageCount 时追加在末尾（运行中占位与压缩到尾的标记）。
 * 插入位落入折叠段 [start, end) 时外置到折叠组之前——与段首分隔线同规则，不折进折叠区。
 */
export function insertCompactionMarkers(
  items: RenderItem[],
  marks: Array<{ position: number; marker: CompactionMarker }>,
  messageCount: number,
): RenderItem[] {
  if (marks.length === 0) return items;
  const sorted = [...marks].sort((left, right) => left.position - right.position);
  const result: RenderItem[] = [];
  let markIndex = 0;
  // 放出所有 position <= limit 的标记（按 position 升序，同位保持传入次序）
  const flushThrough = (limit: number): void => {
    while (markIndex < sorted.length && sorted[markIndex]!.position <= limit) {
      result.push({ kind: "compaction", marker: sorted[markIndex]!.marker });
      markIndex += 1;
    }
  };
  for (const item of items) {
    // 消息 i：position <= i 的检查点落在它之前；折叠段 [start, end)：段内（含段首）的一律外置到段前
    if (item.kind === "message") flushThrough(item.index);
    else if (item.kind === "fold") flushThrough(item.end - 1);
    result.push(item);
  }
  flushThrough(messageCount);
  return result;
}

/** 从消息内容块收集产出文件：write_file/edit_file 的 input.path，按 path 去重保持出现序。 */
export function collectProducedFiles(content: MessageContent[]): ProducedFile[] {
  const files: ProducedFile[] = [];
  const seen = new Set<string>();
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    const path = typeof block.input?.path === "string" ? block.input.path : "";
    if (!path || seen.has(path)) continue;
    if (block.name === "write_file") {
      seen.add(path);
      files.push({ path, action: "write" });
    } else if (block.name === "edit_file") {
      seen.add(path);
      files.push({ path, action: "edit" });
    }
  }
  return files;
}

/**
 * 「本轮产出文件」行插入：每轮末尾（下一轮 user 消息之前，或列表末尾）插入一行，
 * 汇总该轮全部 write_file/edit_file 产出（跨消息按 path 去重，先出现者优先）。
 * 轮内末尾是折叠段时置于折叠组之后（行属本轮产出概览，不折进折叠区）。
 * 无产出的轮不插入；turn 0（首条 user 之前）不归属任何轮。
 */
export function insertProducedFiles(items: RenderItem[], messages: ChatMessage[]): RenderItem[] {
  const turns = turnOf(messages);
  const filesByTurn = new Map<number, ProducedFile[]>();
  const seenByTurn = new Map<number, Set<string>>();
  for (let i = 0; i < messages.length; i += 1) {
    const turn = turns[i]!;
    if (turn === 0) continue;
    for (const file of collectProducedFiles(messages[i]!.content)) {
      const seen = seenByTurn.get(turn) ?? new Set<string>();
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      seenByTurn.set(turn, seen);
      filesByTurn.set(turn, [...(filesByTurn.get(turn) ?? []), file]);
    }
  }
  if (filesByTurn.size === 0) return items;

  const turnOfItem = (item: RenderItem): number | undefined => {
    if (item.kind === "message") return turns[item.index];
    if (item.kind === "fold") return turns[item.end - 1];
    return undefined; // compaction：不改变当前轮归属
  };
  const result: RenderItem[] = [];
  let currentTurn = 0;
  const flushTurn = (): void => {
    const files = filesByTurn.get(currentTurn);
    if (files && files.length > 0) result.push({ kind: "files", turn: currentTurn, files });
  };
  for (const item of items) {
    const turn = turnOfItem(item);
    if (turn !== undefined && turn !== currentTurn) {
      flushTurn();
      currentTurn = turn;
    }
    result.push(item);
  }
  flushTurn();
  return result;
}
