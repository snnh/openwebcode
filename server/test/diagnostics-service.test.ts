import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreClientLike } from "../src/core-client.js";
import { DiagnosticsService, MAX_FEEDBACK_FAILURES, MAX_FEEDBACK_FIELD_CHARS, failureSignature } from "../src/diagnostics/service.js";
import { EventBus } from "../src/events/event-bus.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 假 core：job 输出一次性返回给定文本，状态 completed。 */
function fakeCore(output: string, exitCode = 0): CoreClientLike {
  let served = false;
  const core = {
    on() { return core; },
    async startJob() { served = false; return { jobId: "j", state: "running" as const }; },
    async jobStatus() { return { jobId: "j", state: "completed" as const, exitCode, durationMs: 7 }; },
    async jobOutput(request: { afterSeq: number }) {
      if (request.afterSeq === 0 && !served) {
        served = true;
        return { chunks: [{ seq: 1, stream: "stdout" as const, data: output }], nextSeq: 2, truncated: false };
      }
      return { chunks: [], nextSeq: request.afterSeq, truncated: false };
    },
    async cancelJob(request: { jobId: string }) { return { jobId: request.jobId, accepted: true as const }; },
  } as unknown as CoreClientLike;
  return core;
}

async function setup(output: string, exitCode = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-diag-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
  const events = new EventBus();
  const published: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event: { type: string; payload: unknown }) => published.push(event));
  const service = new DiagnosticsService(fakeCore(output, exitCode), sessions, events);
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
