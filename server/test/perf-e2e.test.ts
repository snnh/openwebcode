/**
 * 0.5.0 Phase 2 端到端验证：perf 采样、provider 并发统计、messages 分页 REST。
 *
 * misc-api.test.ts 只验证空态与接口结构（注释明确“直接调用内部方法不现实”），
 * 本文件触发一次真实 run（含工具调用），证明 perf 三阶段耗时被真实采集并通过
 * REST 暴露，同时覆盖 messages 分页 REST 端点（session-pagination.test.ts 只测 store 层）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, type RunPerfRecord } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupWithToolRun() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-perf-e2e-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "files", model: "claude-opus-4-8" });
  // 自动批准 edit_file，使工具调用无需交互确认即可执行（覆盖 toolExecMs）
  await sessions.updatePermissions(session.id, "acceptEdits", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const editCalls: Array<{ sessionId: string; path: string }> = [];
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async editFile(request: { sessionId: string; path: string; oldText: string; newText: string }) {
      editCalls.push({ sessionId: request.sessionId, path: request.path });
      return { matches: 1 };
    },
  } as unknown as CoreClient;
  const requests: StreamChatRequest[] = [];
  let turn = 0;
  const provider: Provider = {
    name: "files",
    async *streamChat(request) {
      requests.push(request);
      if (turn++ === 0) {
        yield { type: "tool_call", id: "edit-1", name: "edit_file", input: { path: "src/a.ts", oldText: "a", newText: "b" } };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider, 2);
  const events = new EventBus();
  const perfEvents: AppEvent[] = [];
  events.on("event", (event: AppEvent) => { if (event.type === "run.perf") perfEvents.push(event); });
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  apps.push(app);
  return { root, session, agent, app, perfEvents, editCalls, requests };
}

describe("Phase 2 端到端：perf 采样与 REST（真实 run）", () => {
  it("真实 run（含工具调用）后 perf 记录含非零阶段耗时并通过 REST 暴露", async () => {
    const { session, agent, app, perfEvents, editCalls } = await setupWithToolRun();

    await agent.run(session.id, "edit it");

    // 工具确实被执行（toolExecMs 有来源）
    expect(editCalls).toHaveLength(1);

    // run.perf 事件已发布
    expect(perfEvents).toHaveLength(1);
    const evt = perfEvents[0]!.payload as RunPerfRecord;
    expect(evt.stages.contextBuildMs).toBeGreaterThan(0);
    expect(evt.stages.providerCallMs).toBeGreaterThan(0);
    expect(evt.stages.toolExecMs).toBeGreaterThan(0);
    expect(evt.stages.totalMs).toBeGreaterThanOrEqual(evt.stages.contextBuildMs + evt.stages.providerCallMs + evt.stages.toolExecMs);
    // turnCount 计工具执行回合（end_turn 回合在 return 前不到达累加点）
    expect(evt.turnCount).toBe(1);

    // REST: GET /api/sessions/:id/perf 返回环形缓冲中的真实记录
    const perfRes = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/perf` });
    expect(perfRes.statusCode).toBe(200);
    const body = perfRes.json<{ records: RunPerfRecord[] }>();
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.stages.toolExecMs).toBeGreaterThan(0);
    expect(body.records[0]!.runId).toBe(evt.runId);
  });

  it("GET /api/providers/stats 返回 per-provider 并发统计结构", async () => {
    const { app } = await setupWithToolRun();
    const res = await app.inject({ method: "GET", url: "/api/providers/stats" });
    expect(res.statusCode).toBe(200);
    const stats = res.json<Record<string, { active: number; queued: number; maxConcurrent: number }>>();
    expect(stats["files"]).toMatchObject({ active: 0, queued: 0, maxConcurrent: 2 });
  });
});

describe("Phase 2 端到端：messages 分页 REST", () => {
  it("GET /api/sessions/:id/messages?before=&limit= 尾读分页与全量一致、hasMore 正确", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-msg-page-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "p", model: "m" });
    // 构造足够多消息
    const all = [];
    for (let i = 0; i < 120; i++) {
      all.push(await sessions.appendMessage(session.id, "user", [{ type: "text", text: `m-${i}` }]));
    }
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, new EventBus(), pricing);
    const app = await buildServer({ core, sessions, agent, events: new EventBus(), providers, pricing });
    apps.push(app);

    // 尾读：GET /api/sessions/:id?limit=50
    const tailRes = await app.inject({ method: "GET", url: `/api/sessions/${session.id}?limit=50` });
    expect(tailRes.statusCode).toBe(200);
    const tail = tailRes.json<{ messages: { id: string }[]; messageCount: number; hasMoreMessages: boolean }>();
    expect(tail.messages).toHaveLength(50);
    expect(tail.messageCount).toBe(120);
    expect(tail.hasMoreMessages).toBe(true);
    // 尾部应是最后 50 条
    expect(tail.messages[0]!.id).toBe(all[70]!.id);
    expect(tail.messages[49]!.id).toBe(all[119]!.id);

    // 向前翻页：GET /api/sessions/:id/messages?before=<oldest loaded>&limit=50
    const beforeId = tail.messages[0]!.id;
    const pageRes = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages?before=${beforeId}&limit=50` });
    expect(pageRes.statusCode).toBe(200);
    const page = pageRes.json<{ messages: { id: string }[]; hasMore: boolean; totalLines: number }>();
    expect(page.messages).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.totalLines).toBe(120);
    expect(page.messages[0]!.id).toBe(all[20]!.id);
    expect(page.messages[49]!.id).toBe(all[69]!.id);

    // 再向前翻到头
    const beforeId2 = page.messages[0]!.id;
    const page2Res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages?before=${beforeId2}&limit=50` });
    expect(page2Res.statusCode).toBe(200);
    const page2 = page2Res.json<{ messages: { id: string }[]; hasMore: boolean }>();
    expect(page2.messages).toHaveLength(20);
    expect(page2.hasMore).toBe(false);
    expect(page2.messages[0]!.id).toBe(all[0]!.id);

    // 合并 = 全量
    const merged = [...page2.messages, ...page.messages, ...tail.messages].map((m) => m.id);
    expect(merged).toEqual(all.map((m) => m.id));
  });

  it("GET /api/sessions/:id/messages 缺少 before 返回 400", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-msg-page-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "p", model: "m" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, new EventBus(), pricing);
    const app = await buildServer({ core, sessions, agent, events: new EventBus(), providers, pricing });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
    expect(res.statusCode).toBe(400);
  });
});
