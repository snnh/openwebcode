import type { ChatMessage, LiveSubagentRun } from "./contracts";

/** 每个会话保留的子代理运行条目上限（超出时丢弃最旧的） */
export const LIVE_SUBAGENT_CAP = 100;

/** 子代理工具调用判定（type guard）：新名 subagent + 旧名 spawn_task（历史消息兼容）+ spawn_swarm。 */
export function isSubagentToolCallName(name: string | undefined): name is "subagent" | "spawn_task" | "spawn_swarm" {
  return name === "subagent" || name === "spawn_task" || name === "spawn_swarm";
}

/** spawn_swarm items 的两种形态：纯字符串或 { task, agent? }（与 server 端解析一致） */
export function swarmItems(input?: Record<string, unknown>): Array<{ task: string; agent?: string }> {
  if (!Array.isArray(input?.items)) return [];
  return input.items.map((raw) => {
    if (typeof raw === "string") return { task: raw };
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const agent = typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : undefined;
      return { task: String(record.task ?? ""), ...(agent ? { agent } : {}) };
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
  const calls = new Map<string, { name: string; input?: Record<string, unknown> }>();
  const runs: Record<string, LiveSubagentRun> = {};
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call" && block.id && isSubagentToolCallName(block.name)) {
        calls.set(block.id, { name: block.name, ...(block.input ? { input: block.input } : {}) });
        continue;
      }
      if (block.type !== "tool_result" || !block.toolCallId) continue;
      if (!block.subagentTasks?.length && !block.subagentTaskIds?.length) continue;
      const call = calls.get(block.toolCallId);
      if (!call) continue;
      const callAgent = typeof call.input?.agent === "string" && call.input.agent.trim() ? call.input.agent.trim() : undefined;
      const items = call.name === "spawn_swarm" ? swarmItems(call.input) : [];
      const toolCallId = block.toolCallId;
      // 新格式：逐项终态（部分失败的 swarm 各项状态独立，不再被整体 isError 带偏）
      if (block.subagentTasks?.length) {
        const total = Math.max(items.length, block.subagentTasks.length);
        for (const task of block.subagentTasks) {
          if (!task || typeof task.taskId !== "string" || !task.taskId) continue;
          const index = typeof task.index === "number" ? task.index : 0;
          const agent = call.name === "spawn_swarm" ? items[index]?.agent ?? callAgent : callAgent;
          const prompt = call.name === "spawn_swarm"
            ? items[index]?.task ?? ""
            : typeof call.input?.prompt === "string" ? call.input.prompt : "";
          const failed = task.status === "failed";
          runs[task.taskId] = {
            taskId: task.taskId,
            toolCallId,
            prompt,
            ...(agent ? { agent } : {}),
            ...(call.name === "spawn_swarm" ? { swarm: { index: index + 1, total } } : {}),
            status: failed ? "failed" : "done",
            turns: 0,
            toolsUsed: [],
            ...(failed ? { error: snippet(task.error ?? block.content ?? "unknown error") } : {}),
          };
        }
        continue;
      }
      // 旧消息回退：subagentTaskIds 与 items 位置对齐，整体 isError 决定全部条目状态
      const total = block.subagentTaskIds!.length;
      block.subagentTaskIds!.forEach((taskId, index) => {
        const agent = call.name === "spawn_swarm" ? items[index]?.agent ?? callAgent : callAgent;
        const prompt = call.name === "spawn_swarm"
          ? items[index]?.task ?? ""
          : typeof call.input?.prompt === "string" ? call.input.prompt : "";
        runs[taskId] = {
          taskId,
          toolCallId,
          prompt,
          ...(agent ? { agent } : {}),
          ...(call.name === "spawn_swarm" ? { swarm: { index: index + 1, total } } : {}),
          status: block.isError ? "failed" : "done",
          turns: 0,
          toolsUsed: [],
          ...(block.isError && block.content ? { error: snippet(block.content) } : {}),
        };
      });
    }
  }
  return runs;
}

/** 合并实时与消息推导的子代理运行：实时条目优先（含轮次/工具明细），推导条目补齐历史 */
export function mergeSubagentRuns(
  live: Record<string, LiveSubagentRun>,
  derived: Record<string, LiveSubagentRun>,
): Record<string, LiveSubagentRun> {
  return { ...derived, ...live };
}
