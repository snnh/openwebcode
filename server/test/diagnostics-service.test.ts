import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { DiagnosticsService, MAX_FEEDBACK_FAILURES, MAX_FEEDBACK_FIELD_CHARS, failureSignature } from "../src/diagnostics/service.js";
import { fallbackDiagnosticSet, parseTestOutput } from "../src/diagnostics/parsers.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeJobReplayCore } from "./helpers/fake-job-core.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(output: string, exitCode = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-diag-"));
  roots.push(root);
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
const apiRoots: string[] = [];
const apiApps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apiApps.splice(0).map((app) => app.close()));
  await Promise.all(apiRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PYTEST_OUTPUT = [
  "collected 2 items",
  "FAILED tests/test_math.py::test_divides - AssertionError: assert 3 == 4",
  "========================= 1 failed, 1 passed in 0.42s ==========================",
].join("\n");

async function apiSetup(options: { withDiagnostics?: boolean; output?: string; exitCode?: number } = {}) {
  const { withDiagnostics = true, output = PYTEST_OUTPUT, exitCode = 1 } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-diag-api-"));
  apiRoots.push(root);
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
  apiApps.push(app);
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
