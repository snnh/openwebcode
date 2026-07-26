import type { ProviderEvent } from "../providers/provider.js";

/** 声明式断言：在回放结束后对工作区与消息做静态检查 */
export interface EvalAssertion {
  /** 期望被调用的工具名（全部命中才通过） */
  toolUsed?: string[];
  /** 期望工作区产生的文件路径（相对工作区根） */
  fileExists?: string[];
  /** 期望文件包含的文本 */
  fileContains?: Record<string, string>;
  /** 期望 agent 消息（assistant text）包含的文本 */
  messageContains?: string;
  /** Expected substring in a successful result for each named tool. */
  toolResultContains?: Record<string, string>;
  /** Exact ordered tool trace, including repeated calls. */
  toolOrder?: string[];
  /** 轮次上限（超出视为失败） */
  maxTurns?: number;
}

/** 评测任务定义 = 工作区快照 + 指令 + 断言 + mock 回放脚本 */
export interface EvalTask {
  id: string;
  name: string;
  description: string;
  /** fixtures 目录相对路径（server/assets/eval/fixtures/ 下） */
  workspace: string;
  instruction: string;
  assertions: EvalAssertion;
  /** Deterministic service adapters enabled for this replay. */
  features?: Array<"index" | "diagnostics" | "scm">;
  permissionMode?: "acceptEdits" | "yolo";
  /** mock provider 逐 turn 的事件脚本；每个子数组为一个 turn 的事件序列 */
  script: ProviderEvent[][];
}

/** 单条断言检查结果 */
export interface EvalAssertionResult {
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
  /** Ordered tool selection trace, including repeated calls. */
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
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    durationMs: number;
    usage: EvalTokenUsage;
  };
}

/** 历史报告摘要（列表用） */
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

/** Deterministic comparison of two archived reports; positive deltas mean the candidate used more. */
export interface EvalRunComparison {
  schemaVersion: 1;
  comparisonId: string;
  baselineRunId: string;
  candidateRunId: string;
  createdAt: string;
  /** Self-contained snapshots keep an exported comparison independently auditable. */
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
