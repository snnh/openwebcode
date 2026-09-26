import type { ChatMessage, LiveSubagentRun, MessageContent } from "./contracts";

/** 每个会话保留的子代理运行条目上限（超出时丢弃最旧的） */
export const LIVE_SUBAGENT_CAP = 100;

/** 子代理工具调用判定（type guard）：新名 subagent + 旧名 spawn_task（历史消息兼容）+ spawn_swarm。 */
export function isSubagentToolCallName(name: string | undefined): name is "subagent" | "spawn_task" | "spawn_swarm" {
  return name === "subagent" || name === "spawn_task" || name === "spawn_swarm";
}

/** tool_call 阶段记录的调用描述（tool_result 配对时取回）。 */
interface SubagentCall {
  name: string;
  input?: Record<string, unknown>;
}

/** 一条 tool_result 块（含新旧两代任务字段）。 */
type ToolResultBlock = MessageContent;

/** spawn_swarm items 的两种形态：纯字符串或 { task, agent?, role? }（与 server 端解析一致） */
export function swarmItems(input?: Record<string, unknown>): Array<{ task: string; agent?: string; role?: string }> {
  if (!Array.isArray(input?.items)) return [];
  return input.items.map((raw) => {
    if (typeof raw === "string") return { task: raw };
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const agent = typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : undefined;
      const role = typeof record.role === "string" && record.role.trim() ? record.role.trim() : undefined;
      return { task: String(record.task ?? ""), ...(agent ? { agent } : {}), ...(role ? { role } : {}) };
    }
    return { task: String(raw) };
  });
}

export function snippet(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/** 按插入顺序封顶：超出 cap 时丢弃最旧的条目，保留最新 cap 条 */
export function capLiveSubagentRuns(runs: Record<string, LiveSubagentRun>, cap: number = LIVE_SUBAGENT_CAP): Record<string, LiveSubagentRun> {
  const keys = Object.keys(runs);
  if (keys.length <= cap) return runs;
  return Object.fromEntries(keys.slice(keys.length - cap).map((key) => [key, runs[key]!]));
}

/**
 * 从已加载的会话消息推导历史子代理运行（页面刷新后无实时事件时填充子代理面板）：
 * subagent/spawn_swarm 的 tool_call 提供 prompt/agent，配对的 tool_result 提供 taskId 与终态。
 * 优先读 tool_result.subagentTasks（逐项 status/index，显式对应 swarm item 序号）；
 * 旧消息无该字段时回退到 subagentTaskIds 位置对齐 + 整体 isError 启发式。
 * 推导条目不包含实时轮次/工具明细（turns/toolsUsed 置空）。
 */
export function deriveSubagentRunsFromMessages(messages: ChatMessage[]): Record<string, LiveSubagentRun> {
  const calls = new Map<string, SubagentCall>();
  const runs: Record<string, LiveSubagentRun> = {};
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call" && block.id && isSubagentToolCallName(block.name)) {
        calls.set(block.id, { name: block.name, ...(block.input ? { input: block.input } : {}) });
        continue;
      }
      if (block.type === "tool_result") applyToolResult(runs, calls, block);
    }
  }
  return runs;
}

/** 处理一条 tool_result：无配对调用或无任务列表时不动（其余副作用集中在两个 apply* 里）。 */
function applyToolResult(
  runs: Record<string, LiveSubagentRun>,
  calls: Map<string, SubagentCall>,
  block: ToolResultBlock,
): void {
  if (!block.toolCallId) return;
  if (!block.subagentTasks?.length && !block.subagentTaskIds?.length) return;
  const call = calls.get(block.toolCallId);
  if (!call) return;
  const callAgent = typeof call.input?.agent === "string" && call.input.agent.trim() ? call.input.agent.trim() : undefined;
  const items = call.name === "spawn_swarm" ? swarmItems(call.input) : [];
  // 新格式：逐项终态（部分失败的 swarm 各项状态独立，不再被整体 isError 带偏）
  if (block.subagentTasks?.length) {
    applySubagentTasks(runs, block, call, callAgent, items);
    return;
  }
  // 旧消息回退：subagentTaskIds 与 items 位置对齐，整体 isError 决定全部条目状态
  applyLegacyTaskIds(runs, block, call, callAgent, items);
}

/** swarm 逐项 agent/prompt 描述（单发调用回退调用级 agent 与顶层 prompt）。 */
function describeTarget(
  call: SubagentCall,
  callAgent: string | undefined,
  items: ReturnType<typeof swarmItems>,
  index: number,
): { agent?: string; prompt: string } {
  if (call.name !== "spawn_swarm") {
    return {
      ...(callAgent ? { agent: callAgent } : {}),
      prompt: typeof call.input?.prompt === "string" ? call.input.prompt : "",
    };
  }
  const item = items[index];
  const agent = item?.agent ?? callAgent;
  return { ...(agent ? { agent } : {}), prompt: item?.task ?? "" };
}

function applySubagentTasks(
  runs: Record<string, LiveSubagentRun>,
  block: ToolResultBlock,
  call: SubagentCall,
  callAgent: string | undefined,
  items: ReturnType<typeof swarmItems>,
): void {
  const tasks = block.subagentTasks ?? [];
  const total = Math.max(items.length, tasks.length);
  for (const task of tasks) {
    if (!task || typeof task.taskId !== "string" || !task.taskId) continue;
    const index = typeof task.index === "number" ? task.index : 0;
    const target = describeTarget(call, callAgent, items, index);
    const failed = task.status === "failed";
    const role = typeof task.role === "string" && task.role ? task.role : call.name === "spawn_swarm" ? items[index]?.role : undefined;
    runs[task.taskId] = {
      taskId: task.taskId,
      toolCallId: block.toolCallId!,
      prompt: target.prompt,
      ...(target.agent ? { agent: target.agent } : {}),
      ...(role ? { role } : {}),
      ...(typeof task.model === "string" && task.model ? { model: task.model } : {}),
      ...(call.name === "spawn_swarm" ? { swarm: { index: index + 1, total } } : {}),
      status: failed ? "failed" : "done",
      turns: 0,
      toolsUsed: [],
      ...(failed ? { error: snippet(task.error ?? block.content ?? "unknown error") } : {}),
    };
  }
}

function applyLegacyTaskIds(
  runs: Record<string, LiveSubagentRun>,
  block: ToolResultBlock,
  call: SubagentCall,
  callAgent: string | undefined,
  items: ReturnType<typeof swarmItems>,
): void {
  const taskIds = block.subagentTaskIds ?? [];
  taskIds.forEach((taskId, index) => {
    const target = describeTarget(call, callAgent, items, index);
    runs[taskId] = {
      taskId,
      toolCallId: block.toolCallId!,
      prompt: target.prompt,
      ...(target.agent ? { agent: target.agent } : {}),
      ...(call.name === "spawn_swarm" ? { swarm: { index: index + 1, total: taskIds.length } } : {}),
      status: block.isError ? "failed" : "done",
      turns: 0,
      toolsUsed: [],
      ...(block.isError && block.content ? { error: snippet(block.content) } : {}),
    };
  });
}

/**
 * 过滤掉已被视图移除的子代理运行（新批次清旧批 / `/clear` 清空）：
 * hidden 的键同时接受 taskId 与 toolCallId——实时条目按 taskId 移除，消息推导的历史条目
 * 只能按 spawn 调用（toolCallId）识别，两种键都查才不会漏掉面板里的旧条目。
 */
export function filterHiddenSubagentRuns(
  runs: Record<string, LiveSubagentRun>,
  hidden: Record<string, true> | undefined,
): Record<string, LiveSubagentRun> {
  if (!hidden) return runs;
  const visible: Record<string, LiveSubagentRun> = {};
  let dropped = false;
  for (const [taskId, run] of Object.entries(runs)) {
    if (hidden[taskId] || hidden[run.toolCallId]) {
      dropped = true;
      continue;
    }
    visible[taskId] = run;
  }
  return dropped ? visible : runs;
}

/** 按状态过滤运行（子代理面板的状态筛选；"all" 原样返回） */
export function filterSubagentRunsByStatus(
  runs: Record<string, LiveSubagentRun>,
  status: LiveSubagentRun["status"] | "all",
): Record<string, LiveSubagentRun> {
  if (status === "all") return runs;
  return Object.fromEntries(Object.entries(runs).filter(([, run]) => run.status === status));
}

/** 从运行集合收集隐藏键（taskId + toolCallId），供清批/清空使用 */
export function subagentRunIds(runs: Record<string, LiveSubagentRun>): string[] {
  const ids = new Set<string>();
  for (const [taskId, run] of Object.entries(runs)) {
    ids.add(taskId);
    ids.add(run.toolCallId);
  }
  return [...ids];
}

/** 合并实时与消息推导的子代理运行：实时条目优先（含轮次/工具明细），推导条目补齐历史 */
export function mergeSubagentRuns(
  live: Record<string, LiveSubagentRun>,
  derived: Record<string, LiveSubagentRun>,
): Record<string, LiveSubagentRun> {
  return { ...derived, ...live };
}
