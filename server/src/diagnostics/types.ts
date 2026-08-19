/**
 * 诊断闭环（0.4.0 Phase 3a）：测试运行结果的统一结构。
 * 解析器产出 DiagnosticSet；DiagnosticRun 是会话 artifact（sessions/<id>/diagnostics/<run-id>.json）
 * 的持久化记录，包含运行元数据、回退原文尾部与失败签名统计。
 */

export type DiagnosticTool = "vitest" | "jest" | "pytest" | "go" | "dotnet" | "unknown";

export interface DiagnosticFailure {
  name: string;
  file?: string;
  line?: number;
  message: string;
  excerpt?: string;
}

interface DiagnosticSummary {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface DiagnosticSet {
  tool: DiagnosticTool;
  summary: DiagnosticSummary;
  failures: DiagnosticFailure[];
}

export interface DiagnosticRun {
  runId: string;
  sessionId: string;
  /** 触发本次测试的 Agent Run id（REST 触发时可缺失）。 */
  agentRunId?: string;
  command: string;
  cwd: string;
  exitCode?: number;
  startedAt: string;
  finishedAt: string;
  diagnostics: DiagnosticSet;
  /** true 表示解析器无法识别输出，diagnostics 为占位值，原文尾部保存在 outputTail。 */
  parseFallback: boolean;
  /** 解析失败回退时保留的输出原文尾部（有界，不丢数据）。 */
  outputTail?: string;
  /** failures 的 name+file+line 稳定哈希；用于连续相同失败检测。 */
  signature: string;
  /** 同一签名的连续出现次数（≥2 时回授 agent 的摘要附提示）。 */
  repeatedSignatureCount: number;
}
