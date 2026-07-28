import type { ChatMessage, LiveSubagentRun } from "./contracts";

/** 每个会话保留的子代理运行条目上限（超出时丢弃最旧的） */
export const LIVE_SUBAGENT_CAP = 100;

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
 * spawn_task/spawn_swarm 的 tool_call 提供 prompt/agent，配对的 tool_result 的 subagentTaskIds 提供 taskId。
 * 推导条目不包含实时轮次/工具明细（turns/toolsUsed 置空），状态由 tool_result.isError 决定。
 */
export function deriveSubagentRunsFromMessages(messages: ChatMessage[]): Record<string, LiveSubagentRun> {
  const calls = new Map<string, { name: string; input?: Record<string, unknown> }>();
  const runs: Record<string, LiveSubagentRun> = {};
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call" && block.id && (block.name === "spawn_task" || block.name === "spawn_swarm")) {
        calls.set(block.id, { name: block.name, ...(block.input ? { input: block.input } : {}) });
        continue;
      }
      if (block.type !== "tool_result" || !block.toolCallId || !block.subagentTaskIds?.length) continue;
      const call = calls.get(block.toolCallId);
      if (!call) continue;
      const callAgent = typeof call.input?.agent === "string" && call.input.agent.trim() ? call.input.agent.trim() : undefined;
      const items = call.name === "spawn_swarm" ? swarmItems(call.input) : [];
      const total = block.subagentTaskIds.length;
      block.subagentTaskIds.forEach((taskId, index) => {
        const agent = call.name === "spawn_swarm" ? items[index]?.agent ?? callAgent : callAgent;
        const prompt = call.name === "spawn_swarm"
          ? items[index]?.task ?? ""
          : typeof call.input?.prompt === "string" ? call.input.prompt : "";
        runs[taskId] = {
          taskId,
          toolCallId: block.toolCallId!,
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
