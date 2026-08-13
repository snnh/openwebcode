import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ExtensionManager } from "../src/extensions/extension-manager.js";
import { EvalEvaluator } from "../src/eval/evaluator.js";
import { EVAL_TASKS } from "../src/eval/tasks.js";
import { usage } from "../src/eval/mock-provider.js";
import type { EvalTask } from "../src/eval/types.js";
import { makeEvalCore } from "./helpers/eval-core.js";
import { makeFakeCore } from "./helpers/fake-core.js";
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

  it("runTasks 执行全部任务并全部通过", async () => {
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
  });

  it("runTasks 指定单个任务执行", async () => {
    const root = await tempRoot("owc-eval-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());
    const report = await evaluator.runTasks(["create-file"]);
    expect(report.summary.total).toBe(1);
    expect(report.taskResults[0].taskId).toBe("create-file");
    expect(report.taskResults[0].status).toBe("pass");
    expect(report.taskResults[0].toolsUsed).toContain("write_file");
  });

  it("runTasks 未知任务 ID 抛错", async () => {
    const root = await tempRoot("owc-eval-");
    const evaluator = new EvalEvaluator(root, makeEvalCore());
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
