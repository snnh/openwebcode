import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { isMissing } from "../fs-utils.js";
import type { CoreClientLike } from "../core-client.js";
import type { EventBus } from "../events/event-bus.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { ShellBackend } from "../sessions/types.js";
import { coreExecShell } from "../agent/shell-detect.js";
import { decodeProcessOutputChunks } from "../agent/output-decoder.js";
import { detectTestCommand } from "./detect.js";
import { FALLBACK_TAIL_CHARS, fallbackDiagnosticSet, parseTestOutput } from "./parsers.js";
import type { DiagnosticRun, DiagnosticSet } from "./types.js";

/** 回授 agent 的失败摘要上限：最多前 20 条、每条 message/excerpt ≤500 字符；完整结果只走 artifact。 */
export const MAX_FEEDBACK_FAILURES = 20;
export const MAX_FEEDBACK_FIELD_CHARS = 500;
/** 连续相同失败签名提示阈值 */
export const REPEATED_SIGNATURE_HINT_THRESHOLD = 2;
const TEST_JOB_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 50;

/** 失败签名：failures 的 name+file+line 稳定哈希（顺序敏感，消息内容不参与）。 */
export function failureSignature(diagnostics: DiagnosticSet): string {
  const material = diagnostics.failures.map((failure) => [failure.name, failure.file ?? "", failure.line ?? 0]);
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…(truncated)` : value;
}

/**
 * 回授 agent 的有界摘要文本。完整 DiagnosticSet 只在 artifact 中；
 * 连续相同失败 ≥2 次时附提示（只是提示，不中断）。
 */
export function buildAgentFeedback(record: DiagnosticRun): string {
  const { diagnostics } = record;
  const lines: string[] = [];
  if (record.parseFallback) {
    lines.push(`Test output could not be parsed (tool detected: ${diagnostics.tool}). Raw output tail is preserved in the diagnostics artifact.`);
    lines.push(`Exit code: ${record.exitCode ?? "unknown"}`);
  } else {
    lines.push(
      `Tests [${diagnostics.tool}]: ${diagnostics.summary.passed} passed, ${diagnostics.summary.failed} failed, ` +
      `${diagnostics.summary.skipped} skipped in ${diagnostics.summary.durationMs}ms (exit ${record.exitCode ?? "unknown"}).`,
    );
  }
  const shown = diagnostics.failures.slice(0, MAX_FEEDBACK_FAILURES);
  for (const [index, failure] of shown.entries()) {
    const location = failure.file ? ` (${failure.file}${failure.line !== undefined ? `:${failure.line}` : ""})` : "";
    lines.push(`${index + 1}. ${failure.name}${location}: ${truncate(failure.message, MAX_FEEDBACK_FIELD_CHARS)}`);
    if (failure.excerpt && failure.excerpt !== failure.message) {
      lines.push(`   excerpt: ${truncate(failure.excerpt, MAX_FEEDBACK_FIELD_CHARS)}`);
    }
  }
  if (diagnostics.failures.length > shown.length) {
    lines.push(`… and ${diagnostics.failures.length - shown.length} more failure(s); full diagnostics in artifact runId=${record.runId}.`);
  }
  if (record.repeatedSignatureCount >= REPEATED_SIGNATURE_HINT_THRESHOLD) {
    lines.push(`提示：相同失败已连续出现 ${record.repeatedSignatureCount} 次，可考虑请用户介入（例如确认环境或需求），而不是继续重复同样的修复尝试。`);
  }
  lines.push(`Full diagnostics artifact: sessions/${record.sessionId}/diagnostics/${record.runId}.json`);
  return lines.join("\n");
}

export interface TestRunOptions {
  command?: string;
  agentRunId?: string;
  signal?: AbortSignal;
  shellBackend?: ShellBackend;
}

export interface TestRunResult {
  record: DiagnosticRun;
  /** 有界回授摘要（agent 工具结果 / REST 响应复用）。 */
  feedback: string;
}

/**
 * 诊断服务（0.4.0 Phase 3a）：执行测试命令（Core job 模型，继承会话权限沙盒）、
 * 解析输出为 DiagnosticSet、持久化 sessions/<id>/diagnostics/<run-id>.json、
 * 广播 diagnostics.updated，并维护连续相同失败签名统计。
 */
export class DiagnosticsService {
  /** 会话级上一次失败签名与连续计数 */
  private readonly signatures = new Map<string, { signature: string; count: number }>();

  constructor(
    private readonly core: CoreClientLike,
    private readonly sessions: SessionStore,
    private readonly events: EventBus,
  ) {}

  /** 会话删除时清理该会话的失败签名记录（Map 按会话数增长，挂在会话删除清理链上）。 */
  discardSession(sessionId: string): void {
    this.signatures.delete(sessionId);
  }

  async run(sessionId: string, cwd: string, options: TestRunOptions = {}): Promise<TestRunResult> {
    const override = options.command?.trim();
    const detected = override ? { command: override, source: "agent override" } : await detectTestCommand(cwd);
    if (!detected) {
      throw new Error("No test command detected (looked for package.json, pyproject.toml, go.mod, *.sln). Pass an explicit command.");
    }
    const startedAt = new Date().toISOString();
    const jobId = `test-${randomUUID()}`;
    const output: Array<{ stream: "stdout" | "stderr"; data: string; seq: number }> = [];
    let afterSeq = 0;
    const cancel = () => { void this.core.cancelJob({ sessionId, jobId }).catch(() => undefined); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    let exitCode: number | undefined;
    let statusDurationMs: number | undefined;
    try {
      // 与 bash 工具同一路径：Core job 模型执行，继承会话权限沙盒；jobControl 无 RPC 超时兜底，core 侧给 10 分钟上限
      await this.core.startJob({ sessionId, jobId, kind: "exec", cmd: detected.command, cwd, timeoutMs: TEST_JOB_TIMEOUT_MS, ...coreExecShell(options.shellBackend ?? "default") });
      for (;;) {
        const page = await this.core.jobOutput({ sessionId, jobId, afterSeq, limit: 256 });
        output.push(...page.chunks);
        afterSeq = page.nextSeq;
        const status = await this.core.jobStatus({ sessionId, jobId });
        if (status.state === "running") {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          continue;
        }
        const tail = await this.core.jobOutput({ sessionId, jobId, afterSeq, limit: 256 });
        output.push(...tail.chunks);
        if (options.signal?.aborted) options.signal.throwIfAborted();
        if (status.state === "cancelled" || status.state === "timed_out") {
          throw new Error(status.error ?? `Test job ${status.state}`);
        }
        // failed（非零退出）是正常的测试失败路径，照样解析输出
        exitCode = status.exitCode;
        statusDurationMs = status.durationMs;
        break;
      }
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
    // job.output 的 chunk.data 是 base64：decodeProcessOutputChunks 按 seq 排序、合并同流相邻块后解码
    const text = decodeProcessOutputChunks(output).map((chunk) => chunk.data).join("");
    let diagnostics = parseTestOutput(detected.command, text);
    let parseFallback = false;
    let outputTail: string | undefined;
    if (!diagnostics) {
      parseFallback = true;
      diagnostics = fallbackDiagnosticSet(detected.command, text);
      outputTail = text.length > FALLBACK_TAIL_CHARS ? text.slice(-FALLBACK_TAIL_CHARS) : text;
    }
    if (diagnostics.summary.durationMs === 0 && statusDurationMs !== undefined) {
      diagnostics.summary.durationMs = statusDurationMs;
    }
    const signature = failureSignature(diagnostics);
    const previous = this.signatures.get(sessionId);
    const repeatedSignatureCount = previous?.signature === signature ? previous.count + 1 : 1;
    this.signatures.set(sessionId, { signature, count: repeatedSignatureCount });
    const record: DiagnosticRun = {
      runId: randomUUID(),
      sessionId,
      ...(options.agentRunId ? { agentRunId: options.agentRunId } : {}),
      command: detected.command,
      cwd,
      ...(exitCode !== undefined ? { exitCode } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      diagnostics,
      parseFallback,
      ...(outputTail !== undefined ? { outputTail } : {}),
      signature,
      repeatedSignatureCount,
    };
    await this.persist(record);
    this.events.publish({
      source: "agent",
      type: "diagnostics.updated",
      sessionId,
      ...(options.agentRunId ? { runId: options.agentRunId } : {}),
      payload: { sessionId, runId: record.runId, summary: diagnostics.summary },
    });
    return { record, feedback: buildAgentFeedback(record) };
  }

  /** 最近一次测试运行的完整记录；无记录返回 undefined。 */
  async latest(sessionId: string): Promise<DiagnosticRun | undefined> {
    try {
      const value = JSON.parse(await readFile(this.latestPath(sessionId), "utf8")) as DiagnosticRun;
      if (!value || typeof value.runId !== "string" || !value.diagnostics) throw new Error("Invalid diagnostics record");
      return value;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private diagnosticsDir(sessionId: string): string {
    return path.join(this.sessions.contextRoot(sessionId), "diagnostics");
  }

  private latestPath(sessionId: string): string {
    return path.join(this.diagnosticsDir(sessionId), "latest.json");
  }

  private async persist(record: DiagnosticRun): Promise<void> {
    const directory = this.diagnosticsDir(record.sessionId);
    await mkdir(directory, { recursive: true });
    // 紧凑序列化：诊断记录只被机器读取；读取侧 JSON.parse 兼容存量美化格式。
    const serialized = `${JSON.stringify(record)}\n`;
    await Promise.all([
      writeUtf8Atomically(path.join(directory, `${record.runId}.json`), serialized),
      writeUtf8Atomically(this.latestPath(record.sessionId), serialized),
    ]);
  }
}
