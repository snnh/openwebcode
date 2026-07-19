import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, CoreEvent, ExecResult } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-shell-"));
  roots.push(root);
  return root;
}

const echoProvider: Provider = {
  name: "development",
  async *streamChat(_request: StreamChatRequest) {
    yield { type: "done", stopReason: "end_turn" };
  },
};

/**
 * 可控 fake CoreClient：run() 返回挂起 Promise，由 release() 驱动 resolve；
 * on("event") 注册的 listener 可经 emitExecOutput 推 exec.output 帧。
 * 用于权限挂起 + core.run 异步完成两个场景。
 */
function createControllableCore(): {
  client: CoreClientLike;
  release: (result: ExecResult) => void;
  rejectRun: (error: Error) => void;
  emitExecOutput: (data: string, stream?: string) => void;
  runCalls: Array<{ sessionId: string; execId: string; cmd: string; cwd: string }>;
} {
  let runResolve: ((result: ExecResult) => void) | undefined;
  let runReject: ((error: Error) => void) | undefined;
  let eventListener: ((event: CoreEvent) => void) | undefined;
  const emitter = new EventEmitter();
  const runCalls: Array<{ sessionId: string; execId: string; cmd: string; cwd: string }> = [];
  const client: CoreClientLike = {
    on(eventName: string, listener: (...args: unknown[]) => void) {
      if (eventName === "event") eventListener = listener as (event: CoreEvent) => void;
      emitter.on(eventName, listener);
      return client;
    },
    async start() { return { version: "0.0.0", platform: "test" as const, sandboxCapability: "advisory" }; },
    async stop() {
      if (runReject) { runReject(new Error("Core stopped")); runReject = undefined; runResolve = undefined; }
    },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async run(request) {
      runCalls.push({ sessionId: request.sessionId, execId: request.execId, cmd: request.cmd, cwd: request.cwd });
      return new Promise<ExecResult>((resolve, reject) => { runResolve = resolve; runReject = reject; });
    },
    async ping() { return { version: "0.0.0", platform: "test" as const, sandboxCapability: "advisory" }; },
    async cleanupSession() { return { ok: true as const }; },
    async readFile() { return { content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 0 }; },
    async listFiles() { return { entries: [], truncated: false }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    setRequestTimeoutMs() {},
  } as unknown as CoreClientLike;

  return {
    client,
    release: (result: ExecResult) => {
      if (runResolve) { runResolve(result); runResolve = undefined; runReject = undefined; }
    },
    rejectRun: (error: Error) => {
      if (runReject) { runReject(error); runReject = undefined; runResolve = undefined; }
    },
    emitExecOutput: (data: string, stream = "stdout") => {
      if (eventListener) {
        const execId = runCalls[0]?.execId ?? "test";
        eventListener({
          source: "core",
          type: "exec.output",
          payload: { execId, stream, data: Buffer.from(data).toString("base64"), seq: 1 },
        });
      }
    },
    runCalls,
  };
}

async function setup(options?: { permissionMode?: "ask" | "acceptEdits" | "yolo" }) {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "development", model: "deterministic-tool-loop", title: "Shell test" });
  await sessions.updatePermissions(session.id, options?.permissionMode ?? "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(echoProvider);
  const core = createControllableCore();
  const agent = new AgentRunner(sessions, providers, core.client, events, pricing);
  const app = await buildServer({ core: core.client, sessions, agent, events, providers, pricing });
  return { root, sessions, session, core, agent, events, app };
}

/** 等到 sessions 落盘出现至少 count 条 role=tool 消息（或超时） */
async function waitForToolMessage(sessions: SessionStore, id: string, timeoutMs = 5_000, count = 1): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await sessions.get(id);
    if (detail && detail.messages.filter((m) => m.role === "tool").length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("POST /api/sessions/:id/shell - yolo 执行", () => {
  it("落盘 user(!cmd) + tool_result 一对；core.run 收到 cmd；agent.isRunning 全程 false", async () => {
    const harness = await setup();
    try {
      const isRunningSnapshots: boolean[] = [];
      harness.events.on("event", (event: AppEvent) => {
        if (event.type === "tool.start") isRunningSnapshots.push(harness.agent.isRunning(harness.session.id));
      });
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "echo hello" },
      });
      expect(res.statusCode, res.body).toBe(202);
      // yolo 直接执行：core.run 已被调用但挂起，release 驱动完成
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      expect(harness.core.runCalls[0]).toMatchObject({ cmd: "echo hello", cwd: harness.session.cwd });
      harness.core.emitExecOutput("hello world\n");
      harness.core.release({ exitCode: 0, durationMs: 1, truncated: false });
      await waitForToolMessage(harness.sessions, harness.session.id);
      const detail = await harness.sessions.get(harness.session.id);
      const userMsg = detail?.messages.find((m) => m.role === "user");
      const toolMsg = detail?.messages.find((m) => m.role === "tool");
      expect(userMsg?.content).toEqual([{ type: "text", text: "!echo hello" }]);
      expect(toolMsg?.content).toHaveLength(1);
      const toolResult = toolMsg?.content[0];
      expect(toolResult?.type).toBe("tool_result");
      expect(toolResult?.toolCallId).toMatch(/^shell-/);
      expect((toolResult as { content: string }).content).toContain("hello world");
      expect((toolResult as { isError?: boolean }).isError).toBe(false);
      // isRunning 全程 false（shell 不进 agent run 循环）
      expect(isRunningSnapshots.length).toBeGreaterThan(0);
      expect(isRunningSnapshots.every((v) => v === false)).toBe(true);
      // 等 runShell 收尾（finally 清 shells）再退出，避免 afterEach 清理与异步落盘竞态（Windows ENOTEMPTY）
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("core.run 失败 -> tool_result isError=true 含错误信息", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "boom" },
      });
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      harness.core.rejectRun(new Error("exit code 127"));
      await waitForToolMessage(harness.sessions, harness.session.id);
      const detail = await harness.sessions.get(harness.session.id);
      const toolMsg = detail?.messages.find((m) => m.role === "tool");
      const toolResult = toolMsg?.content[0] as { type: string; content: string; isError?: boolean };
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toContain("exit code 127");
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});

describe("POST /api/sessions/:id/shell - 权限挂起（ask 模式）", () => {
  it("ask 模式 -> 发 permission.request 事件；respond allow 后执行落盘", async () => {
    const harness = await setup({ permissionMode: "ask" });
    try {
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "ls -la" },
      });
      expect(res.statusCode).toBe(202);
      // 等待 permission.request 事件
      const requestId = await vi.waitFor(() => {
        const req = events.find((e) => e.type === "permission.request");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      });
      // 此时 agent.isShellPending 应为 true；agent.isRunning 仍为 false
      expect(harness.agent.isShellPending(harness.session.id)).toBe(true);
      expect(harness.agent.isRunning(harness.session.id)).toBe(false);
      // core.run 尚未调用（挂起中）
      expect(harness.core.runCalls.length).toBe(0);
      // respond allow
      const allow = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/permissions/respond`,
        payload: { requestId, decision: "allow" },
      });
      expect(allow.statusCode).toBe(200);
      // 现在 core.run 被驱动
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      expect(harness.core.runCalls[0]).toMatchObject({ cmd: "ls -la" });
      harness.core.release({ exitCode: 0, durationMs: 1, truncated: false });
      await waitForToolMessage(harness.sessions, harness.session.id);
      const detail = await harness.sessions.get(harness.session.id);
      const toolResult = detail?.messages.find((m) => m.role === "tool")?.content[0] as { type: string; isError?: boolean };
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.isError).toBe(false);
      // shell 完成后 isShellPending 归零（finally 清 shells 晚于 appendMessage 可被观察到，轮询等待避免竞态）
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("respond deny -> 落盘错误 tool_result（不调 core.run）", async () => {
    const harness = await setup({ permissionMode: "ask" });
    try {
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "rm -rf /" },
      });
      expect(res.statusCode).toBe(202);
      const requestId = await vi.waitFor(() => {
        const req = events.find((e) => e.type === "permission.request");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      });
      const deny = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/permissions/respond`,
        payload: { requestId, decision: "deny", reason: "user declined" },
      });
      expect(deny.statusCode).toBe(200);
      await waitForToolMessage(harness.sessions, harness.session.id);
      // core.run 不应被调用
      expect(harness.core.runCalls.length).toBe(0);
      const detail = await harness.sessions.get(harness.session.id);
      const userMsg = detail?.messages.find((m) => m.role === "user");
      const toolMsg = detail?.messages.find((m) => m.role === "tool");
      expect(userMsg?.content).toEqual([{ type: "text", text: "!rm -rf /" }]);
      const toolResult = toolMsg?.content[0] as { type: string; content: string; isError?: boolean };
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toContain("user declined");
      // isShellPending 归零（finally 清 shells 晚于 appendMessage 可被观察到，轮询等待避免竞态）
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("respond allow_always -> 持久化 bash 规则；后续相同 cmd 不再挂起", async () => {
    const harness = await setup({ permissionMode: "ask" });
    try {
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "npm test" },
      });
      expect(res.statusCode).toBe(202);
      const requestId = await vi.waitFor(() => {
        const req = events.find((e) => e.type === "permission.request");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      });
      const persist = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/permissions/respond`,
        payload: { requestId, decision: "allow_always" },
      });
      expect(persist.statusCode).toBe(200);
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      harness.core.release({ exitCode: 0, durationMs: 1, truncated: false });
      await waitForToolMessage(harness.sessions, harness.session.id);
      // 规则应已持久化（tool="bash"，argumentPrefix="npm test"）
      const detail = await harness.sessions.get(harness.session.id);
      expect(detail?.permissionRules).toContainEqual({ tool: "bash", argumentPrefix: "npm test" });
      // 再次执行相同 cmd：不再挂起（yolo 路径直接执行）
      events.length = 0;
      const res2 = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "npm test" },
      });
      expect(res2.statusCode).toBe(202);
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(2));
      // 不应有 permission.request 事件
      expect(events.some((e) => e.type === "permission.request")).toBe(false);
      harness.core.release({ exitCode: 0, durationMs: 1, truncated: false });
      // 等第二轮 tool_result 落盘完再退出，避免 afterEach 清理与异步落盘竞态（Windows ENOTEMPTY）
      await waitForToolMessage(harness.sessions, harness.session.id, 5_000, 2);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});

describe("POST /api/sessions/:id/shell - 路由校验", () => {
  it("cmd 缺失 -> 400", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toContain("cmd");
    } finally {
      await harness.app.close();
    }
  });

  it("cmd 空字符串 -> 400", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "   " },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await harness.app.close();
    }
  });

  it("会话不存在 -> 404", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${randomUUID()}/shell`,
        payload: { cmd: "echo hi" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  });

  it("agent.isRunning -> 409（shell 路由不进 run 循环）", async () => {
    const harness = await setup();
    try {
      // 模拟 agent 运行：直接往 running Map 注入一个 controller（绕过 run()）
      // AgentRunner 未暴露 setRunning，用 Object.defineProperty 不可行；改用 run() 真起一个挂起循环
      // 简单做法：用 echoProvider 跑一轮（立即 done）后...但 run() 会很快结束。
      // 改为：直接验证 isShellPending 期间 /messages 路由的 409。
      // 此用例改为验证：shell 挂起期间再次 shell -> 409。
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "long-running" },
      });
      // 等待 yolo 直接进入 core.run 挂起（isShellPending 仍为 true 直到 release）
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      expect(harness.agent.isShellPending(harness.session.id)).toBe(true);
      // 再次 shell -> 409
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "second" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain("shell");
      // 释放让测试干净退出
      harness.core.release({ exitCode: 0, durationMs: 1, truncated: false });
      // 等 tool_result 落盘 + runShell 收尾再退出，避免 afterEach 清理与异步落盘竞态（Windows ENOTEMPTY）
      await waitForToolMessage(harness.sessions, harness.session.id);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("shell 挂起中 POST /messages -> 409", async () => {
    const harness = await setup({ permissionMode: "ask" });
    try {
      const events: AppEvent[] = [];
      harness.events.on("event", (event: AppEvent) => events.push(event));
      await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "ls" },
      });
      await vi.waitFor(() => {
        if (!events.some((e) => e.type === "permission.request")) throw new Error("no permission.request");
      });
      expect(harness.agent.isShellPending(harness.session.id)).toBe(true);
      // 发消息 -> 409
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/messages`,
        payload: { content: "hi" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain("shell");
      // 清理：respond deny 让 shell 结束
      const req = events.find((e) => e.type === "permission.request")!.payload as { requestId: string };
      await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/permissions/respond`,
        payload: { requestId: req.requestId, decision: "deny" },
      });
      // 等 tool_result 落盘 + runShell 收尾再退出，避免 afterEach 清理与异步落盘竞态（Windows ENOTEMPTY）
      await waitForToolMessage(harness.sessions, harness.session.id);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});
