/**
 * Agent 运行态单一来源：状态标签、终态/空闲集合与 busy 判定。
 * 规范 AgentRunState（lib/contracts.ts 与 server run-store）的终态为 completed/failed/aborted，
 * 不含 "error"；这里把 "error" 与旧版状态名（thinking/tool_running）作为防御性条目保留，
 * 统一视为终态、不算 busy。
 */
export const STATE_LABELS: Record<string, [string, string]> = {
  accepted: ["已接受", "Accepted"],
  starting: ["启动中", "Starting"],
  snapshotting: ["创建快照", "Snapshotting"],
  preparing_context: ["准备上下文", "Preparing context"],
  streaming: ["正在输出", "Responding"],
  executing_tools: ["执行工具", "Running tools"],
  waiting_permission: ["等待确认", "Waiting for approval"],
  advancing_turn: ["推进回合", "Advancing turn"],
  settling: ["正在收尾", "Settling"],
  budget_paused: ["预算暂停", "Budget paused"],
  // 旧版/防御性状态名
  thinking: ["思考中", "Thinking"],
  tool_running: ["执行工具", "Running tool"],
  completed: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  aborted: ["已中断", "Aborted"],
  error: ["错误", "Error"],
};

/** 运行态标签：未知枚举不原样透出，降级为通用「运行中」 */
export function stateLabel(state: string): [string, string] {
  return STATE_LABELS[state] ?? ["运行中", "Running"];
}

/** 终态/空闲不视为活跃运行（状态栏、底部面板与实时活动指示共用同一判定） */
export const INACTIVE_STATES: ReadonlySet<string> = new Set(["idle", "error", "completed", "failed", "aborted"]);

export function isBusyState(state?: string): boolean {
  return state !== undefined && !INACTIVE_STATES.has(state);
}
