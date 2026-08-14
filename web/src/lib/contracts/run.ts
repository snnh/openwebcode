export type AgentRunState = "accepted" | "starting" | "snapshotting" | "preparing_context" | "streaming" | "executing_tools" | "waiting_permission" | "advancing_turn" | "settling" | "budget_paused" | "completed" | "failed" | "aborted";

/** Durable server-side run snapshot returned by GET /api/sessions/:id/run. */
export interface AgentRun {
  id: string;
  sessionId: string;
  triggerMessageId: string;
  state: AgentRunState;
  turnIndex: number;
  startedAt: string;
  since: string;
  settledAt?: string;
  error?: { code: string; message: string; retryable: boolean };
}

/** 单次 run 的性能采样记录（脱敏：不含消息内容、文件路径、模型名） */
export interface RunPerfRecord {
  runId: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  turnCount: number;
  stages: {
    contextBuildMs: number;
    providerCallMs: number;
    toolExecMs: number;
    totalMs: number;
  };
}
