import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, IndexScanEntry } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { IndexManager } from "../src/index/index-manager.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
const managers: IndexManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const UTIL_TS = "export function getTopSymbols(): string {\n  return \"x\";\n}\n";
const MANIFEST: IndexScanEntry[] = [{ path: "src/util.ts", size: UTIL_TS.length, modifiedMs: 100, sha256: "u1" }];

function createFakeScanCore(): CoreClientLike {
  let served = false;
  const jsonl = MANIFEST.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    + JSON.stringify({ summary: { entries: MANIFEST.length, truncated: false, reason: null, hashTruncated: false } }) + "\n";
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async startIndexScan() { served = false; return { jobId: "j", state: "running" as const }; },
    async jobStatus() { return { jobId: "j", state: "completed" as const }; },
    async jobOutput(request: { afterSeq: number }) {
      if (request.afterSeq === 0 && !served) {
        served = true;
        return { chunks: [{ seq: 1, stream: "stdout" as const, data: jsonl }], nextSeq: 2, truncated: false };
      }
      return { chunks: [], nextSeq: request.afterSeq, truncated: false };
    },
    async cancelJob(request: { jobId: string }) { return { jobId: request.jobId, accepted: true as const }; },
    async readFile() { return { content: UTIL_TS, totalLines: 3, encoding: "utf-8" as const, truncated: false }; },
    async watchFiles() { throw new Error("fs.watch unavailable"); },
  } as unknown as CoreClientLike;
  return core;
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-index-api-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const core = createFakeScanCore();
  const events = new EventBus();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const indexManager = new IndexManager(core, path.join(root, "index"), events, { pollMs: 1, autoRefresh: false });
  managers.push(indexManager);
  agent.setIndexManager(indexManager);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, indexManager });
  apps.push(app);
  return { app, session };
}

async function waitForStatus(app: Awaited<ReturnType<typeof setup>>["app"], sessionId: string, want: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const response = await app.inject({ method: "GET", url: `/api/workspaces/index/status?sessionId=${sessionId}` });
    if (response.json().status === want) return;
    if (Date.now() - start > 3_000) throw new Error(`status did not become ${want}: ${response.body}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("索引 REST 契约（§7.2）", () => {
  it("status 缺 sessionId 400、未知会话 404、未建索引 missing", async () => {
    const { app, session } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/workspaces/index/status" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/workspaces/index/status?sessionId=00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    const missing = await app.inject({ method: "GET", url: `/api/workspaces/index/status?sessionId=${session.id}` });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ status: "missing", files: 0, symbols: 0 });
  });

  it("rebuild 202 → fresh；symbols 查询支持 q/kind/limit；cancel 无任务 409", async () => {
    const { app, session } = await setup();
    // 未建索引时 symbols 查询 409 且引导显式重建
    const unavailable = await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}&q=getTop` });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ code: "INDEX_UNAVAILABLE" });
    // files 端点同样 409（前端据此回退 complete-path）
    const filesUnavailable = await app.inject({ method: "GET", url: `/api/workspaces/files?sessionId=${session.id}&q=util` });
    expect(filesUnavailable.statusCode).toBe(409);
    expect(filesUnavailable.json()).toMatchObject({ code: "INDEX_UNAVAILABLE" });

    const rebuild = await app.inject({ method: "POST", url: "/api/workspaces/index/rebuild", payload: { sessionId: session.id } });
    expect(rebuild.statusCode).toBe(202);
    expect(rebuild.json()).toMatchObject({ accepted: true });
    expect(rebuild.json().jobId).toMatch(/^index-/);
    await waitForStatus(app, session.id, "fresh");

    const hits = await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}&q=getTop&kind=function&limit=10` });
    expect(hits.statusCode).toBe(200);
    expect(hits.json()).toMatchObject({ indexStatus: "fresh" });
    expect(hits.json().symbols).toHaveLength(1);
    expect(hits.json().symbols[0]).toMatchObject({ name: "getTopSymbols", kind: "function", path: "src/util.ts", startLine: 1 });
    // kind 过滤不命中 → 空
    const none = await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}&q=getTop&kind=class` });
    expect(none.json().symbols).toEqual([]);
    // 缺 q → 空结果而非错误
    const empty = await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().symbols).toEqual([]);
    // limit 非法 → 400
    expect((await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}&q=x&limit=abc` })).statusCode).toBe(400);

    // file 参数（编辑器面包屑，0.5.0 Phase 1a）：按文件精确取符号，前导 ./ 归一
    const byFile = await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}&file=${encodeURIComponent("./src/util.ts")}` });
    expect(byFile.statusCode).toBe(200);
    expect(byFile.json().symbols).toHaveLength(1);
    expect(byFile.json().symbols[0]).toMatchObject({ name: "getTopSymbols", kind: "function", path: "src/util.ts", startLine: 1 });
    const wrongFile = await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}&file=src/other.ts` });
    expect(wrongFile.statusCode).toBe(200);
    expect(wrongFile.json().symbols).toEqual([]);

    // files 端点：索引文件清单搜索（@ 补全数据源，§5.2）
    const files = await app.inject({ method: "GET", url: `/api/workspaces/files?sessionId=${session.id}&q=util` });
    expect(files.statusCode).toBe(200);
    expect(files.json()).toMatchObject({ indexStatus: "fresh" });
    expect(files.json().files).toHaveLength(1);
    expect(files.json().files[0]).toMatchObject({ path: "src/util.ts" });
    // 缺 q → 空结果而非错误；limit 非法 → 400；未知会话 → 404
    const noQuery = await app.inject({ method: "GET", url: `/api/workspaces/files?sessionId=${session.id}` });
    expect(noQuery.statusCode).toBe(200);
    expect(noQuery.json().files).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/workspaces/files?sessionId=${session.id}&q=x&limit=0` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/workspaces/files" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/workspaces/files?sessionId=00000000-0000-4000-8000-000000000000&q=x` })).statusCode).toBe(404);
    // cancel：没有进行中的重建 → 409
    expect((await app.inject({ method: "POST", url: "/api/workspaces/index/rebuild/cancel", payload: { sessionId: session.id } })).statusCode).toBe(409);
    // 参数校验
    expect((await app.inject({ method: "POST", url: "/api/workspaces/index/rebuild", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/workspaces/index/rebuild", payload: { sessionId: "00000000-0000-4000-8000-000000000000" } })).statusCode).toBe(404);
  });

  it("未注入 indexManager 时四个端点 501", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-index-501-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const core = createFakeScanCore();
    const events = new EventBus();
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: `/api/workspaces/index/status?sessionId=${session.id}` })).statusCode).toBe(501);
    expect((await app.inject({ method: "POST", url: "/api/workspaces/index/rebuild", payload: { sessionId: session.id } })).statusCode).toBe(501);
    expect((await app.inject({ method: "GET", url: `/api/workspaces/symbols?sessionId=${session.id}&q=x` })).statusCode).toBe(501);
    expect((await app.inject({ method: "GET", url: `/api/workspaces/files?sessionId=${session.id}&q=x` })).statusCode).toBe(501);
  });
});
