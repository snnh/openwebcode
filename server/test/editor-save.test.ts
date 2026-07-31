import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { CoreRpcError, type CoreClientLike, type CoreInfo, type FsWriteRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-editor-save-"));
  roots.push(root);
  return root;
}

const echoProvider = makeStubProvider("test-stub", async function* () {
  yield { type: "done", stopReason: "end_turn" };
});

const FAKE_CORE_INFO: CoreInfo = {
  version: "0.5.0-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

/** 记录 writeFile 调用的 fake CoreClient（其余原语空实现）。 */
function createFakeCore(): { client: CoreClientLike; writeCalls: FsWriteRequest[] } {
  const writeCalls: FsWriteRequest[] = [];
  const emitter = new EventEmitter();
  const client = {
    on(eventName: string, listener: (...args: unknown[]) => void) { emitter.on(eventName, listener); return client; },
    async start() { return FAKE_CORE_INFO; },
    async stop() { /* noop */ },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async ping() { return FAKE_CORE_INFO; },
    async cleanupSession() { return { ok: true as const }; },
    async readFile() { return { content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false }; },
    async writeFile(request: FsWriteRequest) {
      if (request.expectedSha256 === "f".repeat(64)) throw new CoreRpcError(-32004, "file changed since it was read");
      writeCalls.push({ ...request });
      return { ok: true as const };
    },
    async editFile() { return { matches: 0 }; },
    async listFiles() { return { entries: [], truncated: false }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    setRequestTimeoutMs() { /* noop */ },
  } as unknown as CoreClientLike;
  return { client, writeCalls };
}

async function setup(options?: { permissionMode?: "ask" | "acceptEdits" | "yolo"; agentMode?: "plan" | "code" }) {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: "Editor save test" });
  await sessions.updatePermissions(session.id, options?.permissionMode ?? "yolo", []);
  if (options?.agentMode) await sessions.updateConfig(session.id, { provider: session.provider, model: session.model, agentMode: options.agentMode });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(echoProvider);
  const core = createFakeCore();
  const agent = new AgentRunner(sessions, providers, core.client, events, pricing);
  const app = await buildServer({ core: core.client, sessions, agent, events, providers, pricing });
  return { root, sessions, session, core, agent, events, app };
}

function saveRequest(app: Awaited<ReturnType<typeof setup>>["app"], sessionId: string, payload: unknown) {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const withRevision = value && typeof value.path === "string" && typeof value.content === "string" && value.expectedRevision === undefined
    ? { ...value, expectedRevision: "0".repeat(64) }
    : payload;
  return app.inject({ method: "PUT", url: `/api/sessions/${sessionId}/files/content`, payload: withRevision });
}

describe("PUT /api/sessions/:id/files/content（编辑器保存，0.5.0 Phase 1a）", () => {
  it("yolo 直接写入：core.writeFile 收到 path/content，不落盘消息", async () => {
    const harness = await setup();
    try {
      const res = await saveRequest(harness.app, harness.session.id, { path: "src/a.ts", content: "export const a = 1;\n" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(harness.core.writeCalls).toHaveLength(1);
      expect(harness.core.writeCalls[0]).toMatchObject({ sessionId: harness.session.id, path: "src/a.ts", content: "export const a = 1;\n" });
      expect(harness.core.writeCalls[0]?.expectedSha256).toBe("0".repeat(64));
      const detail = await harness.sessions.get(harness.session.id);
      expect(detail?.messages ?? []).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  });

  it("ask 模式挂起权限审批：permission.request 事件 → respond allow 后写入", async () => {
    const harness = await setup({ permissionMode: "ask" });
    try {
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      const pending = saveRequest(harness.app, harness.session.id, { path: "src/a.ts", content: "x" });
      // 审批挂起：写入尚未发生，permission.request 事件已发出（tool=write_file，input 带 path）
      await vi.waitFor(() => {
        const request = events.find((event) => event.type === "permission.request");
        expect(request, "permission.request 事件").toBeTruthy();
      });
      expect(harness.core.writeCalls).toHaveLength(0);
      const request = events.find((event) => event.type === "permission.request")!;
      const payload = request.payload as { requestId: string; tool: string; input: { path?: string } };
      expect(payload.tool).toBe("write_file");
      expect(payload.input.path).toBe("src/a.ts");
      const respond = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/permissions/respond`,
        payload: { requestId: payload.requestId, decision: "allow" },
      });
      expect(respond.statusCode).toBe(200);
      const res = await pending;
      expect(res.statusCode, res.body).toBe(200);
      expect(harness.core.writeCalls).toHaveLength(1);
    } finally {
      await harness.app.close();
    }
  });

  it("ask 模式用户拒绝 → 403，不写入", async () => {
    const harness = await setup({ permissionMode: "ask" });
    try {
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      const pending = saveRequest(harness.app, harness.session.id, { path: "src/a.ts", content: "x" });
      await vi.waitFor(() => expect(events.some((event) => event.type === "permission.request")).toBe(true));
      const payload = (events.find((event) => event.type === "permission.request")!).payload as { requestId: string };
      await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/permissions/respond`,
        payload: { requestId: payload.requestId, decision: "deny" },
      });
      const res = await pending;
      expect(res.statusCode).toBe(403);
      expect(harness.core.writeCalls).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  });

  it("plan 模式只读门禁：403 拦截，不写入、不发审批事件", async () => {
    const harness = await setup({ permissionMode: "yolo", agentMode: "plan" });
    try {
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      const res = await saveRequest(harness.app, harness.session.id, { path: "src/a.ts", content: "x" });
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("Plan");
      expect(harness.core.writeCalls).toHaveLength(0);
      expect(events.some((event) => event.type === "permission.request")).toBe(false);
    } finally {
      await harness.app.close();
    }
  });

  it("参数校验与互斥：缺 path/content 400，未知会话 404", async () => {
    const harness = await setup();
    try {
      expect((await saveRequest(harness.app, harness.session.id, { content: "x" })).statusCode).toBe(400);
      expect((await saveRequest(harness.app, harness.session.id, { path: "a.ts" })).statusCode).toBe(400);
      expect((await saveRequest(harness.app, "00000000-0000-4000-8000-000000000000", { path: "a.ts", content: "x" })).statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  });

  it("文件 revision 已变化时返回 409 且不覆盖内容", async () => {
    const harness = await setup();
    try {
      const res = await saveRequest(harness.app, harness.session.id, {
        path: "src/a.ts",
        content: "stale",
        expectedRevision: "f".repeat(64),
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: "file changed since it was read" });
      expect(harness.core.writeCalls).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  });
});
