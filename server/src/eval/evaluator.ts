import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, TextContent } from "../sessions/types.js";
import type { CoreClientLike } from "../core-client.js";
import { writeUtf8Atomically } from "../atomic-file.js";
import { AgentRunner } from "../agent/agent-runner.js";
import { EventBus, type AppEvent } from "../events/event-bus.js";
import { PricingCatalog } from "../cost/pricing-catalog.js";
import { ProviderRegistry } from "../providers/provider.js";
import { SessionStore } from "../sessions/session-store.js";
import type { IndexManager } from "../index/index-manager.js";
import type { DiagnosticsService } from "../diagnostics/service.js";
import type { ScmService } from "../scm/service.js";
import { getEvalTask, getEvalTasks } from "./tasks.js";
import { createEvalProvider } from "./mock-provider.js";
import type {
  EvalAssertion,
  EvalAssertionResult,
  EvalRunReport,
  EvalRunComparison,
  EvalComparisonSummary,
  EvalRunSummary,
  EvalTask,
  EvalTaskResult,
  EvalTokenUsage,
} from "./types.js";

/** Task info without the internal mock script (returned by listTasks / API). */
type EvalTaskInfo = Omit<EvalTask, "script">;

// Runtime assets are packaged beside dist/; keeping fixtures out of src/
// avoids TypeScript builds silently omitting the task workspaces.
const FIXTURES_DIR = fileURLToPath(new URL("../../assets/eval/fixtures", import.meta.url));

/**
 * Server-side evaluation harness. Drives isolated agent-session replays
 * with a scripted mock provider, then checks declarative assertions against
 * the resulting workspace and message state.
 *
 * Each task runs in a throwaway temp directory; reports persist under
 * `<dataDir>/eval/runs/`, completely separate from user sessions.
 */
export class EvalEvaluator {
  private readonly runsDir: string;
  private readonly comparisonsDir: string;
  private running = false;

  constructor(private readonly dataDir: string, private readonly core: CoreClientLike) {
    this.runsDir = path.join(dataDir, "eval", "runs");
    this.comparisonsDir = path.join(dataDir, "eval", "comparisons");
  }

  listTasks(): EvalTaskInfo[] {
    return getEvalTasks().map(({ script: _script, ...info }) => info);
  }

  async runTasks(taskIds?: string[]): Promise<EvalRunReport> {
    if (this.running) throw new Error("An evaluation run is already in progress");
    this.running = true;
    try {
      return await this.runTasksExclusive(taskIds);
    } finally {
      this.running = false;
    }
  }

  private async runTasksExclusive(taskIds?: string[]): Promise<EvalRunReport> {
    const runId = `eval-${randomUUID()}`;
    const startedAt = new Date().toISOString();

    let tasks: EvalTask[];
    if (taskIds && taskIds.length > 0) {
      tasks = [];
      for (const id of taskIds) {
        const task = getEvalTask(id);
        if (!task) throw new Error(`Unknown eval task: ${id}`);
        tasks.push(task);
      }
    } else {
      tasks = getEvalTasks();
    }

    const taskResults: EvalTaskResult[] = [];
    for (const task of tasks) {
      taskResults.push(await this.runTask(task));
    }

    const finishedAt = new Date().toISOString();
    const report: EvalRunReport = {
      schemaVersion: 1,
      taskSetId: "owc-smoke-v1",
      provider: "eval-mock",
      model: "eval-model",
      runId,
      startedAt,
      finishedAt,
      taskResults,
      summary: {
        total: taskResults.length,
        passed: taskResults.filter((r) => r.status === "pass").length,
        failed: taskResults.filter((r) => r.status === "fail").length,
        errored: taskResults.filter((r) => r.status === "error").length,
        durationMs: taskResults.reduce((total, result) => total + result.durationMs, 0),
        usage: sumUsage(taskResults.map((result) => result.usage)),
      },
    };

    await this.saveReport(report);
    return report;
  }

  async getRun(runId: string): Promise<EvalRunReport | undefined> {
    if (!/^eval-[0-9a-f-]{36}$/i.test(runId)) return undefined;
    try {
      const content = await readFile(path.join(this.runsDir, `${runId}.json`), "utf8");
      const report = normalizeReport(JSON.parse(content));
      return report.runId === runId ? report : undefined;
    } catch {
      return undefined;
    }
  }

  async listRuns(): Promise<EvalRunSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch {
      return [];
    }
    const summaries: EvalRunSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const report = normalizeReport(JSON.parse(await readFile(path.join(this.runsDir, entry), "utf8")));
        summaries.push({
          runId: report.runId,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          summary: report.summary,
          taskCount: report.taskResults.length,
        });
      } catch {
        /* skip invalid report files */
      }
    }
    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async compareRuns(baselineRunId: string, candidateRunId: string): Promise<EvalRunComparison | undefined> {
    const [baseline, candidate] = await Promise.all([this.getRun(baselineRunId), this.getRun(candidateRunId)]);
    if (!baseline || !candidate) return undefined;
    const baselineTasks = new Map(baseline.taskResults.map((result) => [result.taskId, result]));
    const candidateTasks = new Map(candidate.taskResults.map((result) => [result.taskId, result]));
    const taskIds = [...new Set([...baselineTasks.keys(), ...candidateTasks.keys()])].sort();
    const tasks = taskIds.map((taskId) => {
      const before = baselineTasks.get(taskId);
      const after = candidateTasks.get(taskId);
      return {
        taskId,
        taskName: after?.taskName ?? before?.taskName ?? taskId,
        ...(before ? { baselineStatus: before.status } : {}),
        ...(after ? { candidateStatus: after.status } : {}),
        regressed: Boolean(before && (!after || (before.status === "pass" && after.status !== "pass"))),
        improved: Boolean(before && after && before.status !== "pass" && after.status === "pass"),
        durationMsDelta: (after?.durationMs ?? 0) - (before?.durationMs ?? 0),
        totalTokensDelta: (after?.usage.totalTokens ?? 0) - (before?.usage.totalTokens ?? 0),
        toolCallsChanged: JSON.stringify(before?.toolCalls ?? []) !== JSON.stringify(after?.toolCalls ?? []),
        baselineToolCalls: before?.toolCalls ?? [],
        candidateToolCalls: after?.toolCalls ?? [],
      };
    });
    const comparison: EvalRunComparison = {
      schemaVersion: 1,
      comparisonId: `comparison-${randomUUID()}`,
      baselineRunId,
      candidateRunId,
      createdAt: new Date().toISOString(),
      baseline,
      candidate,
      summary: {
        passedDelta: candidate.summary.passed - baseline.summary.passed,
        failedDelta: candidate.summary.failed - baseline.summary.failed,
        erroredDelta: candidate.summary.errored - baseline.summary.errored,
        durationMsDelta: candidate.summary.durationMs - baseline.summary.durationMs,
        totalTokensDelta: candidate.summary.usage.totalTokens - baseline.summary.usage.totalTokens,
        regressions: tasks.filter((task) => task.regressed).length,
        improvements: tasks.filter((task) => task.improved).length,
      },
      tasks,
    };
    await mkdir(this.comparisonsDir, { recursive: true });
    await writeUtf8Atomically(path.join(this.comparisonsDir, `${comparison.comparisonId}.json`), `${JSON.stringify(comparison, null, 2)}\n`);
    return comparison;
  }

  async getComparison(comparisonId: string): Promise<EvalRunComparison | undefined> {
    if (!/^comparison-[0-9a-f-]{36}$/i.test(comparisonId)) return undefined;
    try {
      const value = JSON.parse(await readFile(path.join(this.comparisonsDir, `${comparisonId}.json`), "utf8")) as EvalRunComparison;
      if (value.schemaVersion !== 1 || value.comparisonId !== comparisonId || !value.baseline || !value.candidate) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  async listComparisons(): Promise<EvalComparisonSummary[]> {
    const entries = await readdir(this.comparisonsDir).catch(() => [] as string[]);
    const values = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => this.getComparison(entry.slice(0, -5))));
    return values.filter((value): value is EvalRunComparison => Boolean(value)).map((value) => ({
      comparisonId: value.comparisonId,
      baselineRunId: value.baselineRunId,
      candidateRunId: value.candidateRunId,
      createdAt: value.createdAt,
      summary: value.summary,
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async runTask(task: EvalTask): Promise<EvalTaskResult> {
    const start = Date.now();
    let workspaceDir: string | undefined;
    let sessionsRoot: string | undefined;
    let coreSessionId: string | undefined;
    let disposeCoreListeners: (() => void) | undefined;

    try {
      // 1. Isolated workspace: copy fixtures to a temp directory.
      workspaceDir = await mkdtemp(path.join(os.tmpdir(), "owc-eval-ws-"));
      const fixtureSrc = path.resolve(FIXTURES_DIR, task.workspace);
      await cp(fixtureSrc, workspaceDir, { recursive: true, force: true });

      // 2. Isolated sessions root (not the user's sessions directory).
      sessionsRoot = await mkdtemp(path.join(os.tmpdir(), "owc-eval-sess-"));
      const sessions = new SessionStore(sessionsRoot);
      await sessions.initialize();
      const session = await sessions.create({ cwd: workspaceDir, provider: "eval-mock", model: "eval-model" });
      coreSessionId = session.id;
      // acceptEdits: auto-approve workspace_write tools so the replay doesn't hang on permissions.
      await sessions.updatePermissions(session.id, task.permissionMode ?? "acceptEdits", []);
      await sessions.updateConfig(session.id, { provider: "eval-mock", model: "eval-model", snapshotMode: "manual" });
      await sessions.updateRepoMapSettings(session.id, { enabled: false });

      const provider = createEvalProvider("eval-mock", task.script);
      const providers = new ProviderRegistry();
      providers.register(provider);
      const events = new EventBus();
      const pricing = new PricingCatalog(path.join(sessionsRoot, "pricing.json"));
      await pricing.initialize();

      const scopedCore = makeScopedCore(this.core);
      disposeCoreListeners = scopedCore.dispose;
      const runner = new AgentRunner(sessions, providers, scopedCore.core, events, pricing);
      // Eval services implement only the methods the runner calls during
      // evaluation (Pick<IndexManager, ...>). The double cast widens the
      // partial mock to the full interface expected by the setter; the Pick
      // return type already provides compile-time checking for those methods.
      if (task.features?.includes("index")) runner.setIndexManager(createEvalIndexService() as unknown as IndexManager);
      if (task.features?.includes("diagnostics")) runner.setDiagnostics(createEvalDiagnosticsService() as unknown as DiagnosticsService);
      if (task.features?.includes("scm")) runner.setScm(createEvalScmService() as unknown as ScmService);
      const usage = emptyUsage();
      const onEvent = (event: AppEvent): void => {
        if (event.sessionId !== session.id || event.type !== "context.usage") return;
        const payload = event.payload as Partial<EvalTokenUsage>;
        usage.inputTokens += numberOrZero(payload.inputTokens);
        usage.outputTokens += numberOrZero(payload.outputTokens);
        usage.cacheRead += numberOrZero(payload.cacheRead);
        usage.cacheWrite += numberOrZero(payload.cacheWrite);
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
      };
      events.on("event", onEvent);

      let runError: string | undefined;
      try {
        await runner.run(session.id, task.instruction);
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
      } finally {
        events.off("event", onEvent);
      }

      const runSnapshot = await runner.getRun(session.id);
      const sessionDetail = await sessions.get(session.id);
      const turns = runSnapshot?.turnIndex ?? 0;
      const toolCalls = extractToolCalls(sessionDetail?.messages ?? []);
      const toolsUsed = [...new Set(toolCalls)];

      const assertionResults = await evaluateAssertions(task.assertions, {
        workspaceDir,
        messages: sessionDetail?.messages ?? [],
        turns,
        toolsUsed,
        toolCalls,
      });

      const allPassed = assertionResults.every((r) => r.passed);
      const status: EvalTaskResult["status"] = runError ? "error" : allPassed ? "pass" : "fail";

      return {
        taskId: task.id,
        taskName: task.name,
        status,
        assertions: assertionResults,
        durationMs: Date.now() - start,
        turns,
        toolsUsed,
        toolCalls,
        usage,
        ...(runError ? { error: runError } : {}),
      };
    } finally {
      disposeCoreListeners?.();
      if (coreSessionId) await this.core.cleanupSession(coreSessionId).catch(() => undefined);
      if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
      if (sessionsRoot) await rm(sessionsRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async saveReport(report: EvalRunReport): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    await writeUtf8Atomically(path.join(this.runsDir, `${report.runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
}

function makeScopedCore(core: CoreClientLike): { core: CoreClientLike; dispose(): void } {
  const listeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];
  const proxy: CoreClientLike = new Proxy(core, {
    get(target, property) {
      if (property === "on") {
        return (event: string, listener: (...args: unknown[]) => void) => {
          listeners.push({ event, listener });
          const on = Reflect.get(target, property) as (event: string, listener: (...args: unknown[]) => void) => unknown;
          on.call(target, event, listener);
          return proxy;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    core: proxy,
    dispose() {
      const off = (core as unknown as { off?: (event: string, listener: (...args: unknown[]) => void) => unknown }).off;
      if (off) for (const item of listeners) off.call(core, item.event, item.listener);
      listeners.length = 0;
    },
  };
}

function createEvalIndexService(): Pick<IndexManager, "searchSymbols" | "symbolSummary" | "noteTurnBoundary"> {
  return {
    async noteTurnBoundary() {
      return undefined;
    },
    async searchSymbols(_cwd, query) {
      return query.toLowerCase().includes("greet") ? [{
        name: "greet",
        kind: "function",
        path: "src/hello.ts",
        startLine: 1,
        endLine: 1,
        signature: "export function greet(): string",
      }] : [];
    },
    async symbolSummary() {
      return [{ path: "src/hello.ts", modifiedMs: 0, symbols: [{ name: "greet", kind: "function" }] }];
    },
  };
}

function createEvalDiagnosticsService(): Pick<DiagnosticsService, "run"> {
  return {
    async run(sessionId, cwd, options = {}) {
      const startedAt = new Date().toISOString();
      const runId = `diagnostic-eval-${randomUUID()}`;
      const record = {
        runId,
        sessionId,
        ...(options.agentRunId ? { agentRunId: options.agentRunId } : {}),
        command: options.command ?? "npm test",
        cwd,
        exitCode: 0,
        startedAt,
        finishedAt: new Date().toISOString(),
        diagnostics: { tool: "vitest" as const, summary: { passed: 2, failed: 0, skipped: 0, durationMs: 12 }, failures: [] },
        parseFallback: false,
        signature: "eval-passing-suite",
        repeatedSignatureCount: 1,
      };
      return { record, feedback: "Tests [vitest]: 2 passed, 0 failed, 0 skipped in 12ms (exit 0)." };
    },
  };
}

function createEvalScmService(): Pick<ScmService, "status" | "diff"> {
  return {
    async status() {
      return {
        isRepo: true,
        branch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [{ path: "src/hello.ts", code: " M" }],
        untracked: [],
        totals: { staged: 0, unstaged: 1, untracked: 0 },
        truncated: false,
      };
    },
    async diff() {
      const diff = "diff --git a/src/hello.ts b/src/hello.ts\n--- a/src/hello.ts\n+++ b/src/hello.ts\n";
      return { isRepo: true, stat: " src/hello.ts | 1 +", diff, totalBytes: Buffer.byteLength(diff), truncated: false };
    },
  };
}

function emptyUsage(): EvalTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sumUsage(values: EvalTokenUsage[]): EvalTokenUsage {
  return values.reduce((total, value) => ({
    inputTokens: total.inputTokens + value.inputTokens,
    outputTokens: total.outputTokens + value.outputTokens,
    cacheRead: total.cacheRead + value.cacheRead,
    cacheWrite: total.cacheWrite + value.cacheWrite,
    totalTokens: total.totalTokens + value.totalTokens,
  }), emptyUsage());
}

function normalizeReport(value: unknown): EvalRunReport {
  const report = value as Partial<EvalRunReport>;
  if (!report.runId || !report.startedAt || !report.finishedAt || !Array.isArray(report.taskResults)) {
    throw new Error("Invalid evaluation report");
  }
  const taskResults = report.taskResults.map((result) => ({
    ...result,
    toolsUsed: Array.isArray(result.toolsUsed) ? result.toolsUsed : [],
    toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : (Array.isArray(result.toolsUsed) ? result.toolsUsed : []),
    usage: result.usage ?? emptyUsage(),
  }));
  return {
    ...report,
    schemaVersion: 1,
    taskSetId: "owc-smoke-v1",
    provider: "eval-mock",
    model: "eval-model",
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    taskResults,
    summary: {
      total: taskResults.length,
      passed: taskResults.filter((result) => result.status === "pass").length,
      failed: taskResults.filter((result) => result.status === "fail").length,
      errored: taskResults.filter((result) => result.status === "error").length,
      durationMs: report.summary?.durationMs ?? taskResults.reduce((total, result) => total + result.durationMs, 0),
      usage: report.summary?.usage ?? sumUsage(taskResults.map((result) => result.usage)),
    },
  };
}

function extractToolCalls(messages: ChatMessage[]): string[] {
  const tools: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") tools.push(block.name);
    }
  }
  return tools;
}

interface AssertionContext {
  workspaceDir: string;
  messages: ChatMessage[];
  turns: number;
  toolsUsed: string[];
  toolCalls: string[];
}

async function evaluateAssertions(assertions: EvalAssertion, ctx: AssertionContext): Promise<EvalAssertionResult[]> {
  const results: EvalAssertionResult[] = [];

  if (assertions.toolUsed) {
    const missing = assertions.toolUsed.filter((tool) => !ctx.toolsUsed.includes(tool));
    results.push({
      name: `toolUsed: [${assertions.toolUsed.join(", ")}]`,
      passed: missing.length === 0,
      detail: missing.length === 0
        ? `used: ${ctx.toolsUsed.join(", ")}`
        : `missing: ${missing.join(", ")}`,
    });
  }

  if (assertions.toolOrder) {
    const passed = JSON.stringify(assertions.toolOrder) === JSON.stringify(ctx.toolCalls);
    results.push({
      name: `toolOrder: [${assertions.toolOrder.join(", ")}]`,
      passed,
      detail: `actual: [${ctx.toolCalls.join(", ")}]`,
    });
  }

  if (assertions.toolResultContains) {
    const callNames = new Map<string, string>();
    const toolResults = new Map<string, Array<{ content: string; isError?: boolean }>>();
    for (const message of ctx.messages) {
      for (const block of message.content) {
        if (block.type === "tool_call") callNames.set(block.id, block.name);
        if (block.type === "tool_result") {
          const name = callNames.get(block.toolCallId);
          if (name) toolResults.set(name, [...(toolResults.get(name) ?? []), { content: block.content, isError: block.isError }]);
        }
      }
    }
    for (const [tool, expected] of Object.entries(assertions.toolResultContains)) {
      const matches = (toolResults.get(tool) ?? []).some((result) => !result.isError && result.content.includes(expected));
      results.push({ name: `toolResultContains: ${tool} ~ "${expected}"`, passed: matches, detail: matches ? "found" : "not found in a successful tool result" });
    }
  }

  if (assertions.fileExists) {
    for (const filePath of assertions.fileExists) {
      const exists = await stat(path.join(ctx.workspaceDir, filePath)).then(() => true).catch(() => false);
      results.push({
        name: `fileExists: ${filePath}`,
        passed: exists,
        detail: exists ? "exists" : "not found",
      });
    }
  }

  if (assertions.fileContains) {
    for (const [filePath, expectedText] of Object.entries(assertions.fileContains)) {
      const content = await readFile(path.join(ctx.workspaceDir, filePath), "utf8").catch(() => null);
      const contains = content !== null && content.includes(expectedText);
      results.push({
        name: `fileContains: ${filePath} ~ "${expectedText}"`,
        passed: contains,
        detail: contains ? "found" : content === null ? "file not found" : "text not found",
      });
    }
  }

  if (assertions.messageContains) {
    const assistantText = ctx.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const contains = assistantText.includes(assertions.messageContains);
    results.push({
      name: `messageContains: "${assertions.messageContains}"`,
      passed: contains,
      detail: contains ? "found in assistant messages" : "not found in assistant messages",
    });
  }

  if (assertions.maxTurns !== undefined) {
    const within = ctx.turns <= assertions.maxTurns;
    results.push({
      name: `maxTurns: ${assertions.maxTurns}`,
      passed: within,
      detail: within ? `turns: ${ctx.turns}` : `turns ${ctx.turns} > ${assertions.maxTurns}`,
    });
  }

  return results;
}
