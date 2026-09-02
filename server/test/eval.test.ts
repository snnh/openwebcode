import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { DiagnosticsService, MAX_FEEDBACK_FAILURES, MAX_FEEDBACK_FIELD_CHARS, failureSignature } from "../src/diagnostics/service.js";
import { fallbackDiagnosticSet, parseTestOutput } from "../src/diagnostics/parsers.js";
import { EventBus } from "../src/events/event-bus.js";
import type { ExtensionManager } from "../src/extensions/extension-manager.js";
import { EvalEvaluator } from "../src/eval/evaluator.js";
import { EVAL_TASKS } from "../src/eval/tasks.js";
import { usage } from "../src/eval/mock-provider.js";
import type { EvalTask } from "../src/eval/types.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeEvalCore } from "./helpers/eval-core.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeJobReplayCore } from "./helpers/fake-job-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildEvalApp(opts: { extensionsEnabled: boolean; withEvaluator: boolean }) {
  const root = await tempRoot("owc-eval-api-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const core = makeFakeCore();
  const events = new EventBus();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const extensions = { isEnabled: () => opts.extensionsEnabled } as unknown as ExtensionManager;
  const deps: Record<string, unknown> = { core, sessions, agent, events, providers, pricing, extensions };
  if (opts.withEvaluator) deps.evalEvaluator = new EvalEvaluator(root, makeEvalCore());
  const app = await buildServer(deps as Parameters<typeof buildServer>[0]);
  apps.push(app);
  return { app, root };
}

describe("EvalEvaluator（0.5.0 Phase 3a）", () => {
  it("listTasks 返回全部内置任务且不含 script", async () => {
    const root = await tempRoot("owc-eval-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());
    const tasks = evaluator.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    for (const task of tasks) {
      expect(task.id).toBeTruthy();
      expect(task.name).toBeTruthy();
      expect(task.script).toBeUndefined();
    }
    expect(tasks.map((t) => t.id)).toEqual(expect.arrayContaining(["create-file", "use-grep", "multi-step"]));
  });

  it("runTasks：全量/单个/未知 ID", async () => {
    const root = await tempRoot("owc-eval-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());

    const report = await evaluator.runTasks();
    expect(report.summary.total).toBeGreaterThanOrEqual(3);
    expect(report.summary.passed).toBe(report.summary.total);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.errored).toBe(0);
    for (const result of report.taskResults) {
      expect(result.status).toBe("pass");
      expect(result.assertions.length).toBeGreaterThan(0);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }

    const single = await evaluator.runTasks(["create-file"]);
    expect(single.summary.total).toBe(1);
    expect(single.taskResults[0].taskId).toBe("create-file");
    expect(single.taskResults[0].status).toBe("pass");
    expect(single.taskResults[0].toolsUsed).toContain("write_file");

    await expect(evaluator.runTasks(["nonexistent"])).rejects.toThrow("Unknown eval task");
  });

  it("断言失败判定正确（fileExists 不匹配 -> status=fail）", async () => {
    const root = await tempRoot("owc-eval-");
    const badTask: EvalTask = {
      id: "test-fail-case",
      name: "失败判定测试",
      description: "断言不存在的文件",
      workspace: "create-file",
      instruction: "test",
      assertions: { fileExists: ["nonexistent.ts"] },
      script: [
        [
          { type: "tool_call", id: "tf-1", name: "write_file", input: { path: "src/hello.ts", content: "hi\n", createDirs: true } },
          usage(),
          { type: "done", stopReason: "tool_use" },
        ],
        [usage(), { type: "done", stopReason: "end_turn" }],
      ],
    };
    EVAL_TASKS.push(badTask);
    try {
      const evaluator = new EvalEvaluator(root, makeEvalCore());
      const report = await evaluator.runTasks(["test-fail-case"]);
      expect(report.summary.failed).toBe(1);
      expect(report.taskResults[0].status).toBe("fail");
      const fileExistsResult = report.taskResults[0].assertions.find((a) => a.name.includes("nonexistent.ts"));
      expect(fileExistsResult).toBeDefined();
      expect(fileExistsResult!.passed).toBe(false);
    } finally {
      EVAL_TASKS.pop();
    }
  });

  it("评测数据目录隔离：不写入用户 sessions 目录", async () => {
    const root = await tempRoot("owc-eval-");
    const userSessionsDir = path.join(root, "user-sessions");
    // 确认用户 sessions 目录初始为空
    let entries = await readdir(userSessionsDir).catch(() => []);
    expect(entries).toEqual([]);
    const evaluator = new EvalEvaluator(root, makeEvalCore());
    await evaluator.runTasks();
    // 评测完成后用户 sessions 目录仍为空
    entries = await readdir(userSessionsDir).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("报告 JSON 结构正确并可持久化读取", async () => {
    const root = await tempRoot("owc-eval-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());
    const report = await evaluator.runTasks(["create-file"]);
    expect(report.runId).toMatch(/^eval-/);
    expect(report.startedAt).toBeTruthy();
    expect(report.finishedAt).toBeTruthy();
    expect(report.taskResults).toHaveLength(1);
    const result = report.taskResults[0];
    expect(result.taskId).toBe("create-file");
    expect(result.taskName).toBe("创建文件");
    expect(result.status).toBe("pass");
    expect(result.assertions).toBeInstanceOf(Array);
    // 断言判定正确：toolUsed + fileContains 匹配均通过
    const toolUsedResult = result.assertions.find((a) => a.name.startsWith("toolUsed"));
    expect(toolUsedResult).toBeDefined();
    expect(toolUsedResult!.passed).toBe(true);
    const fileContainsResult = result.assertions.find((a) => a.name.startsWith("fileContains"));
    expect(fileContainsResult).toBeDefined();
    expect(fileContainsResult!.passed).toBe(true);
    expect(result.turns).toBeGreaterThanOrEqual(0);
    expect(result.toolsUsed).toBeInstanceOf(Array);
    expect(result.toolCalls).toEqual(["write_file"]);
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 });
    expect(report.summary.usage.totalTokens).toBe(4);

    // getRun
    const retrieved = await evaluator.getRun(report.runId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.runId).toBe(report.runId);

    // listRuns
    const runs = await evaluator.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.some((r) => r.runId === report.runId)).toBe(true);
  });

  it("getRun 不存在的 runId 返回 undefined", async () => {
    const root = await tempRoot("owc-eval-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());
    expect(await evaluator.getRun("nonexistent")).toBeUndefined();
    expect(await evaluator.getRun("../sessions/secret")).toBeUndefined();
  });

  it("同一 evaluator 只允许一个评测运行，避免并发耗尽 Core 与临时工作区资源", async () => {
    const root = await tempRoot("owc-eval-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());
    const first = evaluator.runTasks(["use-grep"]);
    await expect(evaluator.runTasks(["create-file"])).rejects.toThrow("already in progress");
    await expect(first).resolves.toMatchObject({ summary: { passed: 1, total: 1 } });
  });

  it("归档基线/候选对比并识别状态、工具、token 与耗时差异", async () => {
    const root = await tempRoot("owc-eval-compare-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());
    const task = EVAL_TASKS.find((item) => item.id === "create-file")!;
    const originalAssertions = task.assertions;
    const baseline = await evaluator.runTasks([task.id]);
    try {
      task.assertions = { ...originalAssertions, fileContains: { "src/hello.ts": "missing-candidate-text" } };
      const candidate = await evaluator.runTasks([task.id]);
      const comparison = await evaluator.compareRuns(baseline.runId, candidate.runId);
      expect(comparison).toBeDefined();
      expect(comparison!.summary.regressions).toBe(1);
      expect(comparison!.tasks[0]).toMatchObject({ baselineStatus: "pass", candidateStatus: "fail", regressed: true });
      expect(comparison!.baseline.runId).toBe(baseline.runId);
      expect(comparison!.candidate.runId).toBe(candidate.runId);
      expect(await evaluator.getComparison(comparison!.comparisonId)).toEqual(comparison);
      expect((await evaluator.listComparisons())[0].comparisonId).toBe(comparison!.comparisonId);
      expect(await evaluator.getComparison("../runs/escape")).toBeUndefined();
    } finally {
      task.assertions = originalAssertions;
    }
  });

  it("测试用 mock core 拒绝逃逸隔离工作区", async () => {
    const root = await tempRoot("owc-eval-core-");
    const core = makeEvalCore();
    await core.configureSession({ sessionId: "s1", cwd: root, sandbox: { enabled: true, readRoots: [root], writeRoots: [root], denyPaths: [], network: "deny" } });
    await expect(core.writeFile({ sessionId: "s1", path: "../escape.txt", content: "no" })).rejects.toThrow("escapes evaluation workspace");
  });
});

describe("eval REST 端点（0.5.0 Phase 3a）", () => {
  it("扩展启用时 GET /api/eval/tasks 返回任务列表", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    const res = await app.inject({ method: "GET", url: "/api/eval/tasks" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tasks).toBeInstanceOf(Array);
    expect(body.tasks.length).toBeGreaterThanOrEqual(3);
    expect(body.tasks[0].script).toBeUndefined();
  });

  it("扩展启用时 POST /api/eval/run 执行评测并返回报告", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    const res = await app.inject({ method: "POST", url: "/api/eval/run", payload: { taskIds: ["create-file"] } });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.runId).toMatch(/^eval-/);
    expect(report.summary.total).toBe(1);
    expect(report.summary.passed).toBe(1);
    expect(report.taskResults[0].taskId).toBe("create-file");
    expect(report.taskResults[0].status).toBe("pass");
  });

  it("POST /api/eval/run 不带 taskIds 执行全部任务", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    const res = await app.inject({ method: "POST", url: "/api/eval/run", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.total).toBeGreaterThanOrEqual(3);
  });

  it("GET /api/eval/runs/:runId 返回已运行的报告", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    const runRes = await app.inject({ method: "POST", url: "/api/eval/run", payload: { taskIds: ["create-file"] } });
    const runId = runRes.json().runId;
    const res = await app.inject({ method: "GET", url: `/api/eval/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().runId).toBe(runId);
  });

  it("GET /api/eval/runs/:runId 不存在时 404", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    const res = await app.inject({ method: "GET", url: "/api/eval/runs/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/eval/runs 返回历史报告列表", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    await app.inject({ method: "POST", url: "/api/eval/run", payload: { taskIds: ["create-file"] } });
    const res = await app.inject({ method: "GET", url: "/api/eval/runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toBeInstanceOf(Array);
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/eval/compare 生成可归档对比并可列表/读取", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    const first = await app.inject({ method: "POST", url: "/api/eval/run", payload: { taskIds: ["create-file"] } });
    const second = await app.inject({ method: "POST", url: "/api/eval/run", payload: { taskIds: ["create-file"] } });
    const res = await app.inject({ method: "POST", url: "/api/eval/compare", payload: { baselineRunId: first.json().runId, candidateRunId: second.json().runId } });
    expect(res.statusCode).toBe(200);
    const comparison = res.json();
    expect(comparison.comparisonId).toMatch(/^comparison-/);
    expect(comparison.baseline.runId).toBe(first.json().runId);
    const list = await app.inject({ method: "GET", url: "/api/eval/comparisons" });
    expect(list.json().comparisons[0].comparisonId).toBe(comparison.comparisonId);
    const get = await app.inject({ method: "GET", url: `/api/eval/comparisons/${comparison.comparisonId}` });
    expect(get.statusCode).toBe(200);
  });

  it("POST /api/eval/compare 拒绝相同或未知报告", async () => {
    const { app } = await buildEvalApp({ extensionsEnabled: true, withEvaluator: true });
    const same = await app.inject({ method: "POST", url: "/api/eval/compare", payload: { baselineRunId: "eval-11111111-1111-4111-8111-111111111111", candidateRunId: "eval-11111111-1111-4111-8111-111111111111" } });
    expect(same.statusCode).toBe(400);
    const unknown = await app.inject({ method: "POST", url: "/api/eval/compare", payload: { baselineRunId: "eval-11111111-1111-4111-8111-111111111111", candidateRunId: "eval-22222222-2222-4222-8222-222222222222" } });
    expect(unknown.statusCode).toBe(404);
  });

  it.each([
    {
      name: "扩展禁用时所有 eval 端点返回 503",
      options: { extensionsEnabled: false, withEvaluator: true },
      endpoints: [
        { method: "GET" as const, url: "/api/eval/tasks" },
        { method: "POST" as const, url: "/api/eval/run", payload: {} },
        { method: "GET" as const, url: "/api/eval/runs/test" },
        { method: "GET" as const, url: "/api/eval/runs" },
        { method: "POST" as const, url: "/api/eval/compare", payload: { baselineRunId: "a", candidateRunId: "b" } },
        { method: "GET" as const, url: "/api/eval/comparisons" },
      ],
    },
    {
      name: "未注入 evalEvaluator 时所有 eval 端点返回 503",
      options: { extensionsEnabled: true, withEvaluator: false },
      endpoints: [
        { method: "GET" as const, url: "/api/eval/tasks" },
        { method: "POST" as const, url: "/api/eval/run", payload: {} },
        { method: "GET" as const, url: "/api/eval/runs" },
        { method: "GET" as const, url: "/api/eval/comparisons" },
      ],
    },
  ])("$name", async ({ options, endpoints }) => {
    const { app } = await buildEvalApp(options);
    for (const ep of endpoints) {
      const res = await app.inject(ep);
      expect(res.statusCode).toBe(503);
    }
  });
});

async function setup(output: string, exitCode = 0) {
  const root = await tempRoot("owc-diag-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
  const events = new EventBus();
  const published: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event: { type: string; payload: unknown }) => published.push(event));
  const service = new DiagnosticsService(makeJobReplayCore(output, { exitCode }), sessions, events);
  return { root, sessions, session, events, published, service };
}

function failureOutput(count: number): string {
  const failedLines = Array.from({ length: count }, (_, index) => `FAILED tests/test_mod.py::test_case_${index} - AssertionError: boom ${index}`).join("\n");
  return `============================= test session starts ==============================\ncollected ${count} items\n\n${failedLines}\n========================= ${count} failed in 1.00s ==========================\n`;
}

describe("DiagnosticsService（0.4.0 Phase 3a）", () => {
  it("解析成功：artifact 持久化 + diagnostics.updated 事件 + latest 可读", async () => {
    const { session, service, published } = await setup(failureOutput(2), 1);
    const { record } = await service.run(session.id, "D:/proj", { command: "pytest" });
    expect(record.parseFallback).toBe(false);
    expect(record.diagnostics.tool).toBe("pytest");
    expect(record.diagnostics.summary.failed).toBe(2);
    expect(record.exitCode).toBe(1);
    const latest = await service.latest(session.id);
    expect(latest?.runId).toBe(record.runId);
    const update = published.find((event) => event.type === "diagnostics.updated");
    expect(update).toBeDefined();
    expect(update!.payload).toMatchObject({ sessionId: session.id, runId: record.runId, summary: { failed: 2 } });
  });

  it("解析失败回退：原文尾部保留在 artifact，不丢数据", async () => {
    const garbage = "x".repeat(20_000);
    const { session, service } = await setup(garbage, 2);
    const { record, feedback } = await service.run(session.id, "D:/proj", { command: "make weird" });
    expect(record.parseFallback).toBe(true);
    expect(record.diagnostics.failures).toEqual([]);
    expect(record.outputTail).toBeDefined();
    expect(record.outputTail!.length).toBeLessThanOrEqual(8_000);
    expect(record.outputTail!.endsWith("x".repeat(100))).toBe(true);
    const latest = await service.latest(session.id);
    expect(latest?.outputTail).toBe(record.outputTail);
    expect(feedback).toContain("could not be parsed");
    // parseFallback 记录不列 failure，也不触发用户介入提示
    expect(feedback).not.toContain("请用户介入");
  });

  it("大输出有界回授：>20 条 failure 截断、字段 ≤500 字符，完整结果只在 artifact", async () => {
    const { session, service } = await setup(failureOutput(25), 1);
    const { record, feedback } = await service.run(session.id, "D:/proj", { command: "pytest" });
    expect(record.diagnostics.failures).toHaveLength(25);
    const enumerated = feedback.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(enumerated).toHaveLength(MAX_FEEDBACK_FAILURES);
    expect(feedback).toContain("5 more failure(s)");
    expect(feedback).toContain(`runId=${record.runId}`);
    for (const line of feedback.split("\n")) expect(line.length).toBeLessThanOrEqual(MAX_FEEDBACK_FIELD_CHARS + 40);
  });

  it("message/excerpt 超长截断到 500 字符", async () => {
    const longMessage = `FAILED tests/test_x.py::test_big - AssertionError: ${"y".repeat(2_000)}`;
    const { session, service } = await setup(`collected 1 items\n${longMessage}\n==== 1 failed in 0.10s ====\n`, 1);
    const { record, feedback } = await service.run(session.id, "D:/proj", { command: "pytest" });
    expect(record.diagnostics.failures[0].message.length).toBeGreaterThan(500);
    const failureLine = feedback.split("\n").find((line) => line.startsWith("1. "));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("…(truncated)");
    expect(failureLine!.length).toBeLessThan(600);
  });

  it("连续两次相同失败签名：回授摘要附用户介入提示（不中断）", async () => {
    const { session, service } = await setup(failureOutput(2), 1);
    const first = await service.run(session.id, "D:/proj", { command: "pytest" });
    expect(first.record.repeatedSignatureCount).toBe(1);
    expect(first.feedback).not.toContain("请用户介入");
    const second = await service.run(session.id, "D:/proj", { command: "pytest" });
    expect(second.record.repeatedSignatureCount).toBe(2);
    expect(second.feedback).toContain("相同失败已连续出现 2 次");
    expect(second.feedback).toContain("请用户介入");
  });

  it("失败签名只含 name+file+line，与消息内容无关", () => {
    const base = { tool: "pytest" as const, summary: { passed: 0, failed: 1, skipped: 0, durationMs: 0 } };
    const a = failureSignature({ ...base, failures: [{ name: "t", file: "f.py", line: 1, message: "one" }] });
    const b = failureSignature({ ...base, failures: [{ name: "t", file: "f.py", line: 1, message: "two" }] });
    const c = failureSignature({ ...base, failures: [{ name: "t", file: "f.py", line: 2, message: "one" }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("未检测到测试命令且无覆盖时报错", async () => {
    const { session, service, root } = await setup("");
    await expect(service.run(session.id, root)).rejects.toThrow("No test command detected");
  });

  it("项目类型检测：package.json vitest / pyproject / go.mod / sln", async () => {
    const { session, service, root } = await setup(failureOutput(1), 1);
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"x\"\n");
    const { record } = await service.run(session.id, root);
    expect(record.command).toBe("pytest");
    // 自定义命令覆盖检测
    const overridden = await service.run(session.id, root, { command: "pytest -k slow" });
    expect(overridden.record.command).toBe("pytest -k slow");
  });
});

// ---- diagnostics-api 组（合并） ----

const PYTEST_OUTPUT = [
  "collected 2 items",
  "FAILED tests/test_math.py::test_divides - AssertionError: assert 3 == 4",
  "========================= 1 failed, 1 passed in 0.42s ==========================",
].join("\n");

async function apiSetup(options: { withDiagnostics?: boolean; output?: string; exitCode?: number } = {}) {
  const { withDiagnostics = true, output = PYTEST_OUTPUT, exitCode = 1 } = options;
  const root = await tempRoot("owc-diag-api-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const core = makeJobReplayCore(output, { exitCode, durationMs: 420 });
  const events = new EventBus();
  const published: Array<{ type: string; sessionId?: string; payload: unknown }> = [];
  events.on("event", (event: { type: string; sessionId?: string; payload: unknown }) => published.push(event));
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const diagnostics = new DiagnosticsService(core, sessions, events);
  agent.setDiagnostics(diagnostics);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, ...(withDiagnostics ? { diagnostics } : {}) });
  apps.push(app);
  return { app, session, published };
}

describe("诊断 REST 契约（0.4.0 Phase 3a）", () => {
  it("POST tests/run 执行测试并返回 record+feedback；GET diagnostics/latest 返回同一记录", async () => {
    const { app, session, published } = await apiSetup();
    // 未运行前 latest 404
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/diagnostics/latest` })).statusCode).toBe(404);
    const run = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/tests/run`, payload: { command: "pytest" } });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    // record 结构（pytest 解析细节由 diagnostics-parsers golden 覆盖）
    expect(body.record).toMatchObject({
      sessionId: session.id,
      command: "pytest",
      exitCode: 1,
      parseFallback: false,
      diagnostics: { tool: "pytest" },
    });
    expect(body.feedback).toContain("1 passed, 1 failed");
    // WS 广播事件（含 sessionId、runId、summary）
    const update = published.find((event) => event.type === "diagnostics.updated");
    expect(update).toBeDefined();
    expect(update!.sessionId).toBe(session.id);
    expect(update!.payload).toMatchObject({ sessionId: session.id, runId: body.record.runId, summary: { failed: 1 } });
    // latest 返回同一记录
    const latest = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/diagnostics/latest` });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().runId).toBe(body.record.runId);
  });

  it("未知会话 404；未注入诊断服务 501", async () => {
    const { app } = await apiSetup();
    const missing = await app.inject({ method: "POST", url: "/api/sessions/00000000-0000-4000-8000-000000000000/tests/run", payload: {} });
    expect(missing.statusCode).toBe(404);
    const missingLatest = await app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/diagnostics/latest" });
    expect(missingLatest.statusCode).toBe(404);
    const noService = await apiSetup({ withDiagnostics: false });
    expect((await noService.app.inject({ method: "POST", url: `/api/sessions/${noService.session.id}/tests/run`, payload: {} })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/diagnostics/latest` })).statusCode).toBe(501);
  });

  it("无法检测测试命令且未提供 command 时 400", async () => {
    const { app, session } = await apiSetup();
    const run = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/tests/run`, payload: {} });
    expect(run.statusCode).toBe(400);
    expect(run.json().error).toContain("No test command detected");
  });
});

// ---- diagnostics-parsers 组（合并） ----
const FIXTURES = path.join(__dirname, "fixtures", "diagnostics");
const diagFixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");

describe("测试输出解析器 golden（0.4.0 Phase 3a）", () => {
  it("vitest --reporter=json：JSON 输出解析为 DiagnosticSet", async () => {
    const output = await diagFixture("vitest-json.txt");
    const parsed = parseTestOutput("npx vitest run --reporter=json", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("vitest");
    expect(parsed!.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({
      name: "math > divides numbers",
      file: "D:/proj/src/math.test.ts",
      line: 11,
    });
    expect(parsed!.failures[0].message).toContain("expected 2 to be 3");
  });

  it("vitest 文本输出：FAIL 块 + 摘要行", async () => {
    const output = await diagFixture("vitest-text.txt");
    const parsed = parseTestOutput("npx vitest run", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("vitest");
    expect(parsed!.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, durationMs: 312 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "math > divides numbers", file: "src/math.test.ts" });
    expect(parsed!.failures[0].message).toContain("AssertionError: expected 2 to be 3");
  });

  it("pytest 文本输出：FAILED 行 + short summary", async () => {
    const output = await diagFixture("pytest-text.txt");
    const parsed = parseTestOutput("pytest", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("pytest");
    expect(parsed!.summary).toMatchObject({ passed: 3, failed: 1, skipped: 0, durationMs: 420 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "tests/test_math.py::test_divides", file: "tests/test_math.py" });
    expect(parsed!.failures[0].message).toContain("AssertionError");

    const parsedCrlf = parseTestOutput("pytest", output.replace(/\n/g, "\r\n"));
    expect(parsedCrlf).toEqual(parsed);
  });

  it("go test -json：事件流解析", async () => {
    const output = await diagFixture("go-json.txt");
    const parsed = parseTestOutput("go test -json ./...", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("go");
    expect(parsed!.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1, durationMs: 50 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "TestDivide", file: "example.com/proj/math" });
    expect(parsed!.failures[0].message).toContain("got 3, want 4");
  });

  it("go test 文本输出：--- FAIL 块 + 包行时长", async () => {
    const output = await diagFixture("go-text.txt");
    const parsed = parseTestOutput("go test ./...", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("go");
    expect(parsed!.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1, durationMs: 50 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "TestDivide" });
    expect(parsed!.failures[0].message).toContain("got 3, want 4");
  });

  it("dotnet test trx：XML 内联输出解析", async () => {
    const output = await diagFixture("dotnet-trx.txt");
    const parsed = parseTestOutput("dotnet test --logger trx", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("dotnet");
    expect(parsed!.summary).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
    expect(parsed!.summary.durationMs).toBe(4);
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "Proj.Tests.MathTests.Divides" });
    expect(parsed!.failures[0].message).toContain("Assert.AreEqual failed");
    expect(parsed!.failures[0].excerpt).toContain("MathTests.cs:line 13");
  });

  it("dotnet test 文本输出：Failed! 摘要 + Failed 块", async () => {
    const output = await diagFixture("dotnet-text.txt");
    const parsed = parseTestOutput("dotnet test", output);
    expect(parsed).toBeDefined();
    expect(parsed!.tool).toBe("dotnet");
    expect(parsed!.summary).toMatchObject({ passed: 2, failed: 1, skipped: 1, durationMs: 12 });
    expect(parsed!.failures).toHaveLength(1);
    expect(parsed!.failures[0]).toMatchObject({ name: "Proj.Tests.MathTests.Divides" });
    expect(parsed!.failures[0].message).toContain("Assert.AreEqual failed");
  });

  it("解析失败回退：乱输出返回 undefined，fallback 保留工具识别与空 failures", () => {
    const garbage = "@@not-a-test-output@@\n\x00\x01 random bytes !!!\n";
    expect(parseTestOutput("make weird", garbage)).toBeUndefined();
    const fallback = fallbackDiagnosticSet("make weird", garbage);
    expect(fallback.tool).toBe("unknown");
    expect(fallback.summary).toEqual({ passed: 0, failed: 0, skipped: 0, durationMs: 0 });
    expect(fallback.failures).toEqual([]);
    // 已知命令但输出无法解析：回退保留工具名
    const pytestFallback = fallbackDiagnosticSet("pytest --weird", garbage);
    expect(pytestFallback.tool).toBe("pytest");
  });
});
