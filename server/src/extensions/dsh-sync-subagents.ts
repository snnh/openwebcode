/**
 * dsh-sync 扩展 M5a：子代理会话的**转录嵌套映射**（双向共用的纯逻辑 + 解码编排）。
 *
 * 背景（两种表示的不对称）：
 * - dsh 侧：子代理会话是**独立会话目录**（头行 `origin:'subagent'` + `parentSession` 指回父会话，
 *   `delegationDepth:1`），父会话里只有一次 `tool/call`（`name === 'subagent'`）与对应的 `tool/result`；
 * - owc 侧：子代理转录是父会话目录下的 `<sessionDir>/subagents/<taskId>.json`
 *   （形状见 `server/src/agent/sub-agent.ts` 的 `runSubAgent` 落盘），父会话的 tool_result 块靠
 *   `subagentTaskIds`/`subagentTasks` 指回该文件（消费侧见 `web/src/lib/subagent-runs.ts`）。
 *
 * 导入方向（dsh → owc）：
 * 1. {@link subagentCallIds} 按出现顺序取父会话 `tool/call` 里 `name === 'subagent'` 的 callId；
 * 2. {@link pairSubagentSessions} 把子会话按头行 `createdAt` 升序编号，第 n 个调用 ↔ 第 n 个子会话
 *    （**时序配对启发式**：dsh 工具结果里的 `subagentId` 与子会话 id 的对应关系在上游源码里未证实，
 *    只能按「调用与子会话的出现顺序一致」配对；局限由调用方写进报告 notes/warnings）；
 * 3. {@link nestSubagentSessions} 逐个子会话 decode + convert → 转录对象
 *    （`{id, prompt, agent, startedAt, turns, toolsUsed, conclusion, messages}`，与 `runSubAgent` 同形状；
 *    子会话里的图片经注入的附件解析器内联，未注入时退化为文本占位 + 计数）；
 * 4. {@link attachSubagentTasks} 把配对结果挂到父会话 messages 的 tool_result 块上
 *    （callId → tool_call.id → 同 id 的 tool_result；块上已有字段时按 taskId 去重合并）。
 *
 * 导出方向（owc → dsh）：{@link transcriptTaskIdsOf} 取父会话消息里的转录 id，
 * {@link transcriptExportInput} 把读回的 `subagents/<taskId>.json` 宽松解析成写盘输入。
 *
 * 一切失败都不静默：解码/转换失败的子会话退化为「未配对」并计入 `warnings`，由调用方汇报。
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage, TextContent, ToolResultContent } from "../sessions/types.js";
import { decodeDshSessionFile, type DshSessionEntry } from "./dsh-sync-dsh.js";
import { convertDshSession, type DshConversionOptions, type DshSessionConversion } from "./dsh-sync-session.js";
import { asRecord, isoOfMs } from "./json-utils.js";

/** 父会话里触发子代理的工具名（dsh 侧的 subagent 调用在 owc 的约定名）。 */
const SUBAGENT_TOOL_NAME = "subagent";

/** 转录 `prompt` 的截断长度（首条 user 文本；与 owc 子代理工具 4000 字上限同量级）。 */
const PROMPT_MAX_LENGTH = 500;

/** 转录 `conclusion` 的截断长度（与 `sub-agent.ts` 的 `SUB_AGENT_CONCLUSION_LIMIT` 同口径）。 */
const CONCLUSION_MAX_LENGTH = 64_000;

/**
 * owc 侧子代理转录（`<sessionDir>/subagents/<taskId>.json` 的内容）。
 *
 * 刻意用 type（而非 interface）：type 的对象字面量类型对 `Record<string, unknown>` 有隐式索引签名，
 * 可直接作为 `sessions.import` 的 `subagents[].data` 入参（interface 会因缺索引签名被拒）。
 */
type DshSubagentTranscript = {
  /** 转录 id（= 文件名 = 父会话 tool_result 的 subagentTaskIds 里的值）。 */
  id: string;
  /** 子代理任务描述（子会话首条 user 文本，截断）。 */
  prompt: string;
  /** 子代理 preset 名（dsh 头行 `agentPreset`；缺省不写该字段）。 */
  agent?: string;
  /** 子会话开始时间（ISO：头行 createdAt 毫秒；非法时回退转换出的会话 createdAt）。 */
  startedAt: string;
  /** 用户消息数。 */
  turns: number;
  /** 子会话用过的工具名（去重、保持首次出现顺序）。 */
  toolsUsed: string[];
  /** 末条 assistant 文本（截断）。 */
  conclusion: string;
  /** 子会话消息历史（owc 形态，可直接进 `serializeSession`）。 */
  messages: ChatMessage[];
};

/** 配对结果（第 n 个 subagent 调用 ↔ 第 n 个按 createdAt 升序的子会话）。 */
export interface DshSubagentPairing {
  /** 配对成功的（callId, 子会话条目）。 */
  pairs: Array<{ callId: string; entry: DshSessionEntry }>;
  /** 多出来的子会话（调用数不够）：不 nested，由调用方提示「可作为独立会话导入」。 */
  unpaired: DshSessionEntry[];
}

/** {@link nestSubagentSessions} 的产物（直接喂 `sessions.import` 的 subagents 入参与挂载计划）。 */
export interface DshSubagentNesting {
  /** `sessions.import` 的 `subagents` 入参（taskId 为本次新生成的 UUID）。 */
  subagents: Array<{ taskId: string; data: DshSubagentTranscript }>;
  /** 父会话 tool_result 的挂载计划（callId → taskId）。 */
  assignments: Array<{ callId: string; taskId: string }>;
  /** 未嵌套的子会话（多出来的 + 解码/转换失败的）。 */
  unpaired: DshSessionEntry[];
  /** 降级说明（解码失败、子会话转换警告等；调用方加前缀后进报告）。 */
  warnings: string[];
}

/** 导出方向读到的转录（宽松解析后的最小视图）。 */
export interface DshSubagentTranscriptExport {
  /** 子会话消息历史（owc 形态）。 */
  messages: ChatMessage[];
  /** 子代理 preset（转录 `agent`）。 */
  agentPreset?: string;
  /** 子会话开始时间（ISO；转录 `startedAt`）。 */
  startedAt?: string;
}

/** 未知 JSON 值取字符串（其它类型返回 undefined）。 */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 文本截断（与 `sub-agent.ts` 的 `truncateConclusion` 同口径：截断时带 `…(truncated)` 后缀）。 */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(truncated)`;
}

/**
 * 父会话事件流里的子代理调用 callId（按事件出现顺序；缺 callId/name 的调用跳过）。
 * @param events - 父会话事件行数组（v3 解码产物）。
 * @returns callId 列表（第 n 项 = 第 n 个子代理调用）。
 */
export function subagentCallIds(events: readonly Record<string, unknown>[]): string[] {
  const callIds: string[] = [];
  for (const event of events) {
    if (str(event.type) !== "tool/call") continue;
    const data = asRecord(event.data);
    if (str(data?.name) !== SUBAGENT_TOOL_NAME) continue;
    const callId = str(data?.callId);
    if (callId !== undefined && callId.length > 0) callIds.push(callId);
  }
  return callIds;
}

/** 头行 createdAt（毫秒）→ 排序键；缺失/非法排到最后（同键按 sessionId 稳定兜底）。 */
function createdAtKey(entry: DshSessionEntry): number {
  const createdAt = entry.header?.createdAt;
  return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER;
}

/**
 * 时序配对：子会话按头行 `createdAt` 升序编号，第 n 个 subagent 调用 ↔ 第 n 个子会话。
 *
 * 启发式的由来与局限：dsh 的 `tool/result` 载荷里没有可核对的子会话 id（上游未证实），
 * 只能假定「同一次运行的调用顺序与子会话创建顺序一致」。调用数多于子会话时才可能错配，
 * 因此把多出来的子会话如实作为 unpaired 返回（调用方提示可独立导入 + 在报告里注明局限）。
 * @param parentEvents - 父会话事件流。
 * @param children - 该父会话的 supported v3 子会话条目（调用方已过滤）。
 * @returns 配对结果（pairs 与 unpaired；unpaired 保持 createdAt 升序）。
 */
export function pairSubagentSessions(
  parentEvents: readonly Record<string, unknown>[],
  children: readonly DshSessionEntry[],
): DshSubagentPairing {
  const callIds = subagentCallIds(parentEvents);
  const ordered = [...children].sort((left, right) =>
    createdAtKey(left) - createdAtKey(right)
    || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0));
  const pairs: DshSubagentPairing["pairs"] = [];
  for (const [index, callId] of callIds.entries()) {
    const entry = ordered[index];
    if (entry !== undefined) pairs.push({ callId, entry });
  }
  return { pairs, unpaired: ordered.slice(callIds.length) };
}

/** 子会话首条 user 文本（首条带非空 text 块的 user 消息；没有则空串）。 */
function firstUserText(messages: readonly ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) return block.text.trim();
    }
  }
  return "";
}

/** 末条 assistant 文本（从后往前找第一条带文本块的 assistant 消息；文本块按序拼接）。 */
function lastAssistantText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

/** 会话用过的工具名（tool_call 块，去重、保持首次出现顺序）。 */
function toolsUsedOf(messages: readonly ChatMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_call" || block.name.length === 0 || names.includes(block.name)) continue;
      names.push(block.name);
    }
  }
  return names;
}

/**
 * 子会话（头行 + 转换产物）→ owc 转录对象（与 `sub-agent.ts` 的落盘形状一致）。
 * @param taskId - 转录 id（父会话 tool_result 的 subagentTaskIds 指向它）。
 * @param header - 子会话头行（取 `agentPreset` 与 `createdAt`）。
 * @param conversion - {@link convertDshSession} 的产物（消息即子会话历史）。
 * @returns 可直接落盘/进 `sessions.import` 的转录对象。
 */
function buildSubagentTranscript(
  taskId: string,
  header: Record<string, unknown>,
  conversion: DshSessionConversion,
): DshSubagentTranscript {
  const agent = str(header.agentPreset);
  const startedAt = isoOfMs(header.createdAt) ?? conversion.meta.createdAt;
  return {
    id: taskId,
    prompt: truncate(firstUserText(conversion.messages), PROMPT_MAX_LENGTH),
    ...(agent === undefined || agent.length === 0 ? {} : { agent }),
    startedAt,
    turns: conversion.messages.filter((message) => message.role === "user").length,
    toolsUsed: toolsUsedOf(conversion.messages),
    conclusion: truncate(lastAssistantText(conversion.messages), CONCLUSION_MAX_LENGTH),
    messages: conversion.messages,
  };
}

/**
 * 逐个子会话「decode → convert → 转录」，产出 `sessions.import` 的 subagents 入参与父会话挂载计划。
 *
 * 逐项 try：单个子会话解码/转换失败只记 warning 并把它移入 `unpaired`（不 nested），
 * 不影响其余子会话与父会话本身的导入。
 * @param input - 父会话事件流、子会话条目（supported v3）、可注入的 taskId 生成器（测试用）与
 *   附件解析器（与父会话同一个实例：子会话里的图片同样要内联成 `image{mediaType,data}`）。
 * @returns 转录列表 + 挂载计划 + 未嵌套列表 + 警告。
 */
export async function nestSubagentSessions(input: {
  parentEvents: readonly Record<string, unknown>[];
  children: readonly DshSessionEntry[];
  newTaskId?: () => string;
  /**
   * 附件解析器（{@link DshConversionOptions.resolveAttachment} 同形）：缺省不内联图片（子会话里的
   * 图片退化为文本占位 + 计数），生产路径由 host 注入 `readDshAttachment` + base64 读字节。
   */
  resolveAttachment?: DshConversionOptions["resolveAttachment"];
}): Promise<DshSubagentNesting> {
  const newTaskId = input.newTaskId ?? randomUUID;
  const pairing = pairSubagentSessions(input.parentEvents, input.children);
  const subagents: DshSubagentNesting["subagents"] = [];
  const assignments: DshSubagentNesting["assignments"] = [];
  const unpaired = [...pairing.unpaired];
  const warnings: string[] = [];
  for (const { callId, entry } of pairing.pairs) {
    if (entry.file === undefined || entry.generation === undefined || entry.compressed === undefined) {
      warnings.push(`子代理会话 ${entry.sessionId} 缺少可读的会话文件，未嵌套`);
      unpaired.push(entry);
      continue;
    }
    try {
      const { header, events } = await decodeDshSessionFile({
        file: entry.file,
        generation: entry.generation,
        compressed: entry.compressed,
      });
      const conversion = convertDshSession(
        header,
        events,
        input.resolveAttachment === undefined ? undefined : { resolveAttachment: input.resolveAttachment },
      );
      const taskId = newTaskId();
      subagents.push({ taskId, data: buildSubagentTranscript(taskId, header, conversion) });
      assignments.push({ callId, taskId });
      for (const warning of conversion.report.warnings) warnings.push(`子代理会话 ${entry.sessionId}：${warning}`);
    } catch (error: unknown) {
      warnings.push(`子代理会话 ${entry.sessionId} 转换失败（未嵌套）：${error instanceof Error ? error.message : String(error)}`);
      unpaired.push(entry);
    }
  }
  return { subagents, assignments, unpaired, warnings };
}

/** 合并 subagentTaskIds（按 taskId 去重后追加，保持既有顺序）。 */
function mergeTaskIds(existing: readonly string[] | undefined, taskId: string): string[] {
  return [...(existing ?? []).filter((id) => id !== taskId), taskId];
}

/** 合并 subagentTasks（按 taskId 去重后追加一项 index=0/status='done'，既有条目原样保留）。 */
function mergeTasks(
  existing: ToolResultContent["subagentTasks"],
  taskId: string,
): NonNullable<ToolResultContent["subagentTasks"]> {
  const task: NonNullable<ToolResultContent["subagentTasks"]>[number] = { taskId, index: 0, status: "done" };
  return [...(existing ?? []).filter((item) => item.taskId !== taskId), task];
}

/**
 * 把配对结果挂到父会话 messages 的 tool_result 块上。
 *
 * 解析链（与 owc 消费侧 `web/src/lib/subagent-runs.ts` 一致）：dsh `tool/call.callId` 与 owc
 * `tool_call.id` 同名 → 取同 `toolCallId` 的 tool_result 块挂 `subagentTaskIds`/`subagentTasks`。
 * 只有「父会话 messages 里确实存在同名 tool_call」的配对才挂（孤立 tool_result 不动）。
 * 块上已有这两个字段（swarm 多任务块等）时按 taskId 去重合并，不覆盖既有条目。
 * @param messages - 父会话消息（就地改写；与 `importSession` 的入参同一数组）。
 * @param assignments - 配对计划（callId → taskId）。
 * @returns 被挂上字段的 tool_result 块数。
 */
export function attachSubagentTasks(
  messages: ChatMessage[],
  assignments: ReadonlyArray<{ callId: string; taskId: string }>,
): number {
  if (assignments.length === 0) return 0;
  const taskIdByCallId = new Map(assignments.map((item) => [item.callId, item.taskId]));
  // 先按 messages 里真实存在的 tool_call.id 收敛（callId 与 tool_call.id 同名，见 above）
  const paired = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call" && taskIdByCallId.has(block.id)) paired.add(block.id);
    }
  }
  let patched = 0;
  for (const message of messages) {
    message.content = message.content.map((block): ChatMessage["content"][number] => {
      if (block.type !== "tool_result" || !paired.has(block.toolCallId)) return block;
      const taskId = taskIdByCallId.get(block.toolCallId)!;
      patched += 1;
      return {
        ...block,
        subagentTaskIds: mergeTaskIds(block.subagentTaskIds, taskId),
        subagentTasks: mergeTasks(block.subagentTasks, taskId),
      };
    });
  }
  return patched;
}

/**
 * 收集消息里 tool_result 块上的 `subagentTaskIds`（去重、保持首次出现顺序）。
 * 导出方向用它决定要为哪些转录生成 dsh 子会话。
 * @param messages - owc 会话消息。
 * @returns taskId 列表（空数组 = 该会话没有子代理转录）。
 */
export function transcriptTaskIdsOf(messages: readonly ChatMessage[]): string[] {
  const taskIds: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      for (const taskId of block.subagentTaskIds ?? []) {
        if (typeof taskId === "string" && taskId.length > 0 && !taskIds.includes(taskId)) taskIds.push(taskId);
      }
    }
  }
  return taskIds;
}

/**
 * 导出方向：把 `sessions.getSubagent` 读回的转录宽松解析成写盘输入。
 * @param raw - 转录 JSON（`<sessionDir>/subagents/<taskId>.json`）。
 * @returns 消息历史 + 可选的 agent preset / 开始时间。
 * @throws 转录缺少 `messages` 数组时抛出（坏数据宁可不导出，也不写出一个空子会话）。
 */
export function transcriptExportInput(raw: Record<string, unknown>): DshSubagentTranscriptExport {
  const messages = raw.messages;
  if (!Array.isArray(messages)) throw new Error("子代理转录缺少 messages 数组");
  const agent = str(raw.agent);
  const startedAt = str(raw.startedAt);
  return {
    messages: messages as ChatMessage[],
    ...(agent === undefined || agent.length === 0 ? {} : { agentPreset: agent }),
    ...(startedAt === undefined || startedAt.length === 0 ? {} : { startedAt }),
  };
}
