/** 声明式断言：回放结束后对工作区与消息做静态检查 */
interface EvalAssertion {
  toolUsed?: string[];
  fileExists?: string[];
  fileContains?: Record<string, string>;
  messageContains?: string;
  maxTurns?: number;
}

/** 任务信息（不含内部 mock 脚本） */
export interface EvalTaskInfo {
  id: string;
  name: string;
  description: string;
  workspace: string;
  instruction: string;
  assertions: EvalAssertion;
}

/** 单条断言检查结果 */
interface EvalAssertionResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** 单个任务的回放结果 */
export interface EvalTaskResult {
  taskId: string;
  taskName: string;
  status: "pass" | "fail" | "error";
  assertions: EvalAssertionResult[];
  durationMs: number;
  turns: number;
  toolsUsed: string[];
  toolCalls: string[];
  usage: EvalTokenUsage;
  error?: string;
}

export interface EvalTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** 一次评测运行的完整报告 */
export interface EvalRunReport {
  schemaVersion: 1;
  taskSetId: "owc-smoke-v1";
  provider: "eval-mock";
  model: "eval-model";
  runId: string;
  startedAt: string;
  finishedAt: string;
  taskResults: EvalTaskResult[];
  summary: { total: number; passed: number; failed: number; errored: number; durationMs: number; usage: EvalTokenUsage };
}

/** 历史报告摘要 */
export interface EvalRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  summary: EvalRunReport["summary"];
  taskCount: number;
}

export interface EvalTaskComparison {
  taskId: string;
  taskName: string;
  baselineStatus?: EvalTaskResult["status"];
  candidateStatus?: EvalTaskResult["status"];
  regressed: boolean;
  improved: boolean;
  durationMsDelta: number;
  totalTokensDelta: number;
  toolCallsChanged: boolean;
  baselineToolCalls: string[];
  candidateToolCalls: string[];
}

export interface EvalRunComparison {
  schemaVersion: 1;
  comparisonId: string;
  baselineRunId: string;
  candidateRunId: string;
  createdAt: string;
  baseline: EvalRunReport;
  candidate: EvalRunReport;
  summary: {
    passedDelta: number;
    failedDelta: number;
    erroredDelta: number;
    durationMsDelta: number;
    totalTokensDelta: number;
    regressions: number;
    improvements: number;
  };
  tasks: EvalTaskComparison[];
}

export interface EvalComparisonSummary {
  comparisonId: string;
  baselineRunId: string;
  candidateRunId: string;
  createdAt: string;
  summary: EvalRunComparison["summary"];
}
