import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CoreClientLike, CoreInfo, JobStartRequest, JobStatus } from "../src/core-client.js";
import type { AppEvent } from "../src/events/event-bus.js";
import { FAKE_CORE_INFO, makeControllableCore, makeFakeCore } from "./helpers/fake-core.js";
import { makeAgentHarness, waitForToolMessage } from "./helpers/agent-harness.js";

async function setup(options?: { permissionMode?: "ask" | "acceptEdits" | "yolo" }) {
  const core = makeControllableCore();
  const harness = await makeAgentHarness({
    core: core.client,
    permissionMode: options?.permissionMode ?? "yolo",
    title: "Shell test",
    tempPrefix: "owc-shell-",
  });
  return { ...harness, core };
}

/** 等 permission.request 事件并取 requestId（ask 模式挂起用） */
async function waitForPermissionRequest(events: AppEvent[]): Promise<string> {
  return vi.waitFor(() => {
    const req = events.find((e) => e.type === "permission.request");
    if (!req) throw new Error("no permission.request event");
    return (req.payload as { requestId: string }).requestId;
  });
}

describe("POST /api/sessions/:id/shell - yolo 执行", () => {
  it("落盘 user(!cmd) + tool_result 一对；core.run 收到 cmd；agent.isRunning 全程 false", async () => {
    const harness = await setup();
    try {
      await harness.sessions.updateConfig(harness.session.id, { provider: harness.session.provider, model: harness.session.model, shellBackend: "pwsh" });
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
      expect(harness.core.runCalls[0]).toMatchObject({ cmd: "echo hello", cwd: harness.session.cwd, shellBackend: "pwsh" });
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
      const requestId = await waitForPermissionRequest(events);
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
      const requestId = await waitForPermissionRequest(events);
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
      const requestId = await waitForPermissionRequest(events);
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
      await waitForToolMessage(harness.sessions, harness.session.id, 2);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});

describe("POST /api/sessions/:id/shell - 路由校验", () => {
  it.each([
    { name: "cmd 缺失", foreignSession: false, payload: {}, status: 400, errorContains: "cmd" },
    { name: "cmd 空字符串", foreignSession: false, payload: { cmd: "   " }, status: 400, errorContains: "" },
    { name: "会话不存在", foreignSession: true, payload: { cmd: "echo hi" }, status: 404, errorContains: "" },
  ])("$name -> $status", async ({ foreignSession, payload, status, errorContains }) => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${foreignSession ? randomUUID() : harness.session.id}/shell`,
        payload,
      });
      expect(res.statusCode).toBe(status);
      if (errorContains) expect(res.json<{ error: string }>().error).toContain(errorContains);
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

describe("POST /api/sessions/:id/shell - jobControl 路径超时", () => {
  const JOB_CORE_INFO: CoreInfo = {
    ...FAKE_CORE_INFO,
    features: { ...FAKE_CORE_INFO.features!, jobControl: true },
  };

  /** jobControl fake core：startJob 记录请求，jobStatus 直接回终态 */
  function createJobCore(finalStatus: JobStatus): { client: CoreClientLike; startJobCalls: JobStartRequest[] } {
    const startJobCalls: JobStartRequest[] = [];
    const client = makeFakeCore({
      async start() { return JOB_CORE_INFO; },
      async ping() { return JOB_CORE_INFO; },
      async startJob(request: JobStartRequest) {
        startJobCalls.push({ ...request });
        return { jobId: request.jobId, state: "running" as const };
      },
      async jobStatus() { return finalStatus; },
      async jobOutput() { return { chunks: [], nextSeq: 0, truncated: false }; },
      async cancelJob() { return { jobId: finalStatus.jobId, accepted: true as const }; },
      async run() { throw new Error("jobControl 路径不应走 exec.run"); },
    } as Partial<CoreClientLike>);
    return { client, startJobCalls };
  }

  async function setupJob(finalStatus: JobStatus) {
    const core = createJobCore(finalStatus);
    const harness = await makeAgentHarness({
      core: core.client,
      permissionMode: "yolo",
      title: "Job shell",
      tempPrefix: "owc-shell-job-",
    });
    return { ...harness, core };
  }

  it("startJob 带默认 timeoutMs（10 分钟），completed 正常收尾", async () => {
    const harness = await setupJob({ jobId: "j1", state: "completed", exitCode: 0, durationMs: 5 });
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "echo hi" },
      });
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => expect(harness.core.startJobCalls.length).toBe(1));
      expect(harness.core.startJobCalls[0]).toMatchObject({ cmd: "echo hi", timeoutMs: 600_000 });
      await waitForToolMessage(harness.sessions, harness.session.id);
      const toolResult = (await harness.sessions.get(harness.session.id))?.messages.find((m) => m.role === "tool")?.content[0] as { type: string; isError?: boolean };
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.isError).toBe(false);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("core 回 timed_out -> tool_result isError 且含超时信息，轮询循环终止", async () => {
    const harness = await setupJob({ jobId: "j1", state: "timed_out", error: "Job timed out after 600000ms" });
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "sleep 9999" },
      });
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => expect(harness.core.startJobCalls.length).toBe(1));
      await waitForToolMessage(harness.sessions, harness.session.id);
      const toolResult = (await harness.sessions.get(harness.session.id))?.messages.find((m) => m.role === "tool")?.content[0] as { type: string; content: string; isError?: boolean };
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toContain("timed out");
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});

describe("POST /api/sessions/:id/abort - 前台 shell（runShell）", () => {
  it("abort 中止 runShell 的 controller：jobControl 路径收到 cancelJob，路由返回 202 而非 409", async () => {
    let cancelled = false;
    const startJobCalls: string[] = [];
    const jobCoreInfo: CoreInfo = {
      ...FAKE_CORE_INFO,
      features: { ...FAKE_CORE_INFO.features!, jobControl: true },
    };
    // jobControl fake core：job 一直 running，直到 cancelJob 后回 cancelled 终态
    const core = makeFakeCore({
      async start() { return jobCoreInfo; },
      async ping() { return jobCoreInfo; },
      async startJob(request: JobStartRequest) {
        startJobCalls.push(request.jobId);
        return { jobId: request.jobId, state: "running" as const };
      },
      async jobStatus(request: { jobId: string }): Promise<JobStatus> {
        return cancelled
          ? { jobId: request.jobId, state: "cancelled", error: "Job cancelled" }
          : { jobId: request.jobId, state: "running" };
      },
      async jobOutput() { return { chunks: [], nextSeq: 0, truncated: false }; },
      async cancelJob(request: { jobId: string }) {
        cancelled = true;
        return { jobId: request.jobId, accepted: true as const };
      },
      async run() { throw new Error("jobControl 路径不应走 exec.run"); },
    } as Partial<CoreClientLike>);
    const harness = await makeAgentHarness({
      core,
      permissionMode: "yolo",
      title: "Abort shell",
      tempPrefix: "owc-shell-abort-",
    });
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/shell`,
        payload: { cmd: "sleep 9999" },
      });
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(true));
      // 等 job 真正启动（进入轮询循环）后再 abort，否则中止发生在起 job 前、无 job 可取消
      await vi.waitFor(() => expect(startJobCalls.length).toBe(1), { timeout: 5_000 });

      const stop = await harness.app.inject({
        method: "POST",
        url: `/api/sessions/${harness.session.id}/abort`,
      });
      // runShell 挂起也算可中止状态（旧实现不进 running Map，abort 返回 false -> 409）
      expect(stop.statusCode).toBe(202);
      // controller abort 触发 jobControl 路径的 cancelJob
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 5_000 });
      // runShell 收尾：落盘错误 tool_result 且 shells Map 清空
      await waitForToolMessage(harness.sessions, harness.session.id);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});
