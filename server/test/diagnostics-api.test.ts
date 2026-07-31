import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { DiagnosticsService } from "../src/diagnostics/service.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeJobReplayCore } from "./helpers/fake-job-core.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PYTEST_OUTPUT = [
  "collected 2 items",
  "FAILED tests/test_math.py::test_divides - AssertionError: assert 3 == 4",
  "========================= 1 failed, 1 passed in 0.42s ==========================",
].join("\n");

async function setup(options: { withDiagnostics?: boolean; output?: string; exitCode?: number } = {}) {
  const { withDiagnostics = true, output = PYTEST_OUTPUT, exitCode = 1 } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-diag-api-"));
  roots.push(root);
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
    const { app, session, published } = await setup();
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
    const { app } = await setup();
    const missing = await app.inject({ method: "POST", url: "/api/sessions/00000000-0000-4000-8000-000000000000/tests/run", payload: {} });
    expect(missing.statusCode).toBe(404);
    const missingLatest = await app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/diagnostics/latest" });
    expect(missingLatest.statusCode).toBe(404);
    const noService = await setup({ withDiagnostics: false });
    expect((await noService.app.inject({ method: "POST", url: `/api/sessions/${noService.session.id}/tests/run`, payload: {} })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/diagnostics/latest` })).statusCode).toBe(501);
  });

  it("无法检测测试命令且未提供 command 时 400", async () => {
    const { app, session } = await setup();
    const run = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/tests/run`, payload: {} });
    expect(run.statusCode).toBe(400);
    expect(run.json().error).toContain("No test command detected");
  });
});
