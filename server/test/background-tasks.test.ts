import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { BackgroundTaskRegistry } from "../src/agent/background-tasks.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, ExecResult, CoreEvent } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { SandboxMode } from "../src/sessions/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-bg-"));
  roots.push(root);
  return root;
}

/**
 * 可控制的 fake CoreClient，用于测试后台任务生命周期。
 * - run() 返回一个可控的 Promise（通过 release 方法 resolve 或 reject）
 * - on("event") 注册的 listener 可通过 emitExecOutput 触发
 * - stop() 记录调用
 */
function createControllableCore(): {
  client: CoreClientLike;
  release: (result: ExecResult) => void;
  rejectRun: (error: Error) => void;
  emitExecOutput: (data: string | Buffer) => void;
  stopCalled: () => boolean;
} {
  let runResolve: ((result: ExecResult) => void) | undefined;
  let runReject: ((error: Error) => void) | undefined;
  let stopped = false;
  let eventListener: ((event: CoreEvent) => void) | undefined;
  let sequence = 0;

  const emitter = new EventEmitter();
  const client: CoreClientLike = {
    on(eventName: string, listener: (...args: unknown[]) => void) {
      if (eventName === "event") {
        eventListener = listener as (event: CoreEvent) => void;
      }
      emitter.on(eventName, listener);
      return client;
    },
    async start() { return { version: "0.0.0", platform: "test" as const }; },
    async stop() {
      stopped = true;
      if (runReject) {
        runReject(new Error("Core stopped"));
        runReject = undefined;
        runResolve = undefined;
      }
    },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async run() {
      return new Promise<ExecResult>((resolve, reject) => {
        runResolve = resolve;
        runReject = reject;
      });
    },
    async ping() { return { version: "0.0.0", platform: "test" as const }; },
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
      if (runResolve) {
        runResolve(result);
        runResolve = undefined;
        runReject = undefined;
      }
    },
    rejectRun: (error: Error) => {
      if (runReject) {
        runReject(error);
        runReject = undefined;
        runResolve = undefined;
      }
    },
    emitExecOutput: (data: string | Buffer) => {
      if (eventListener) {
        eventListener({
          source: "core",
          type: "exec.output",
          payload: {
            execId: "test",
            stream: "stdout",
            data: Buffer.from(data).toString("base64"),
            seq: sequence++,
          },
        });
      }
    },
    stopCalled: () => stopped,
  };
}

describe("BackgroundTaskRegistry", () => {
  it("start 返回 taskId 和 status started", async () => {
    const root = await tempRoot();
    const factory = vi.fn(() => createControllableCore().client);
    const registry = new BackgroundTaskRegistry(
      factory,
      async () => undefined,
    );

    const info = await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "echo hello",
      cwd: root,
    });

    expect(info.taskId).toBe("task-001");
    expect(info.status).toBe("running");
    expect(info.sessionId).toBe("s1");
    expect(info.cmd).toBe("echo hello");
    expect(info.cwd).toBe(root);
    expect(info.startedAt).toBeTruthy();
    expect(info.finishedAt).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("get 返回任务信息与输出", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "echo hello",
      cwd: root,
    });

    // 推送输出
    core.emitExecOutput("hello world\n");

    // 完成
    core.release({ exitCode: 0, durationMs: 10, truncated: false });

    // 等待任务完成
    await vi.waitFor(() => {
      const entry = registry.get("task-001");
      expect(entry?.status).toBe("done");
    });

    const entry = registry.get("task-001");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("done");
    expect(entry!.exitCode).toBe(0);
    expect(entry!.output).toContain("hello world");
    expect(entry!.finishedAt).toBeTruthy();
  });

  it("后台任务将相邻 pipe 分片合并后再解码", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({ sessionId: "s1", taskId: "task-gbk", cmd: "echo 中文", cwd: root });
    // UTF-8 的“中文”被刻意拆在两个 pipe 通知中。
    core.emitExecOutput(Buffer.from([0xe4, 0xb8]));
    core.emitExecOutput(Buffer.from([0xad, 0xe6, 0x96, 0x87]));

    expect(registry.get("task-gbk")?.output).toBe("中文");
    core.release({ exitCode: 0, durationMs: 1, truncated: false });
  });

  it("task_output 读取输出；block=true 等到终态", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "sleep 1",
      cwd: root,
    });

    // 先读取非阻塞——应该是 running
    const before = registry.get("task-001");
    expect(before?.status).toBe("running");

    // 完成
    core.release({ exitCode: 0, durationMs: 100, truncated: false });

    // 再读——应该是 done
    await vi.waitFor(() => {
      const entry = registry.get("task-001");
      expect(entry?.status).toBe("done");
    });

    const after = registry.get("task-001");
    expect(after?.exitCode).toBe(0);
  });

  it("task_stop 调 client.stop()，status=stopped", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "sleep 100",
      cwd: root,
    });

    // 停止
    const stopped = await registry.stop("task-001");
    expect(stopped).toBe(true);

    const entry = registry.get("task-001");
    expect(entry?.status).toBe("stopped");
    expect(entry?.finishedAt).toBeTruthy();
    expect(core.stopCalled()).toBe(true);
  });

  it("任务完成后下一轮 system 含完成提示，再下一轮不含（读后即清）", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "echo hello",
      cwd: root,
    });

    // 完成
    core.release({ exitCode: 0, durationMs: 10, truncated: false });

    await vi.waitFor(() => {
      const entry = registry.get("task-001");
      expect(entry?.status).toBe("done");
    });

    // 第一次 drain 应有提示
    const notices1 = registry.drainNotices("s1");
    expect(notices1.length).toBeGreaterThan(0);
    expect(notices1[0]).toContain("task-001");

    // 第二次 drain 应为空（读后即清）
    const notices2 = registry.drainNotices("s1");
    expect(notices2.length).toBe(0);
  });

  it("run reject → status=failed", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "crash",
      cwd: root,
    });

    // 拒绝
    core.rejectRun(new Error("Process crashed"));

    await vi.waitFor(() => {
      const entry = registry.get("task-001");
      expect(entry?.status).toBe("failed");
    });

    const entry = registry.get("task-001");
    expect(entry?.status).toBe("failed");
    expect(entry?.finishedAt).toBeTruthy();
  });

  it("listForSession 返回该会话的任务列表", async () => {
    const root = await tempRoot();
    const core1 = createControllableCore();
    const core2 = createControllableCore();
    let callCount = 0;
    const registry = new BackgroundTaskRegistry(
      () => {
        callCount++;
        return callCount === 1 ? core1.client : core2.client;
      },
      async () => undefined,
    );

    await registry.start({ sessionId: "s1", taskId: "task-001", cmd: "cmd1", cwd: root });
    await registry.start({ sessionId: "s1", taskId: "task-002", cmd: "cmd2", cwd: root });
    await registry.start({ sessionId: "s2", taskId: "task-003", cmd: "cmd3", cwd: root });

    const s1Tasks = registry.listForSession("s1");
    expect(s1Tasks).toHaveLength(2);
    expect(s1Tasks.map((t) => t.taskId).sort()).toEqual(["task-001", "task-002"]);

    const s2Tasks = registry.listForSession("s2");
    expect(s2Tasks).toHaveLength(1);
    expect(s2Tasks[0].taskId).toBe("task-003");
  });

  it("stopForSession 停止该会话所有任务", async () => {
    const root = await tempRoot();
    const core1 = createControllableCore();
    const core2 = createControllableCore();
    let callCount = 0;
    const registry = new BackgroundTaskRegistry(
      () => {
        callCount++;
        return callCount === 1 ? core1.client : core2.client;
      },
      async () => undefined,
    );

    await registry.start({ sessionId: "s1", taskId: "task-001", cmd: "cmd1", cwd: root });
    await registry.start({ sessionId: "s1", taskId: "task-002", cmd: "cmd2", cwd: root });

    await registry.stopForSession("s1");

    const tasks = registry.listForSession("s1");
    expect(tasks.every((t) => t.status === "stopped")).toBe(true);
  });

  it("shutdown 清理所有任务", async () => {
    const root = await tempRoot();
    const core1 = createControllableCore();
    const core2 = createControllableCore();
    let callCount = 0;
    const registry = new BackgroundTaskRegistry(
      () => {
        callCount++;
        return callCount === 1 ? core1.client : core2.client;
      },
      async () => undefined,
    );

    await registry.start({ sessionId: "s1", taskId: "task-001", cmd: "cmd1", cwd: root });
    await registry.start({ sessionId: "s2", taskId: "task-002", cmd: "cmd2", cwd: root });

    await registry.shutdown();

    expect(registry.listForSession("s1")).toHaveLength(0);
    expect(registry.listForSession("s2")).toHaveLength(0);
    expect(core1.stopCalled()).toBe(true);
    expect(core2.stopCalled()).toBe(true);
  });

  it("环形缓冲截断：推送 >256KB 输出，get 返回 truncated", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "big output",
      cwd: root,
    });

    // 推送 300KB 数据
    const bigChunk = "x".repeat(300 * 1024);
    core.emitExecOutput(bigChunk);

    core.release({ exitCode: 0, durationMs: 10, truncated: false });

    await vi.waitFor(() => {
      const entry = registry.get("task-001");
      expect(entry?.status).toBe("done");
    });

    const entry = registry.get("task-001");
    expect(entry?.truncated).toBe(true);
    expect(entry!.output.length).toBeLessThanOrEqual(256 * 1024);
  });

  it("onFinished 回调在任务完成时触发", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const onFinished = vi.fn();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
      onFinished,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "echo hello",
      cwd: root,
    });

    core.release({ exitCode: 0, durationMs: 10, truncated: false });

    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledTimes(1);
    });

    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-001",
        status: "done",
        exitCode: 0,
      }),
    );
  });

  it("已完成任务 stop 返回 true 但不改变状态", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "echo hello",
      cwd: root,
    });

    core.release({ exitCode: 0, durationMs: 10, truncated: false });

    await vi.waitFor(() => {
      const entry = registry.get("task-001");
      expect(entry?.status).toBe("done");
    });

    // 对已完成任务调用 stop
    const stopped = await registry.stop("task-001");
    expect(stopped).toBe(true);

    // 状态不应改变
    const entry = registry.get("task-001");
    expect(entry?.status).toBe("done");
  });

  it("不存在的任务 stop 返回 false", async () => {
    const registry = new BackgroundTaskRegistry(
      () => { throw new Error("Should not be called"); },
      async () => undefined,
    );

    const result = await registry.stop("nonexistent");
    expect(result).toBe(false);
  });
});

describe("BackgroundTaskRegistry — agent-runner integration", () => {
  it("fake core 的 run 不挂起主循环", async () => {
    const root = await tempRoot();
    const core = createControllableCore();
    const registry = new BackgroundTaskRegistry(
      () => core.client,
      async () => undefined,
    );

    // start 应当快速返回（status=running），不等 run 完成
    const startTime = Date.now();
    const info = await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "long running",
      cwd: root,
    });
    const elapsed = Date.now() - startTime;

    expect(info.status).toBe("running");

    // 如果需要很长时间才返回，说明 await 了 run 的完成
    // 即使 run 未 resolve，start 也应在合理时间内返回（< 5s）
    expect(elapsed).toBeLessThan(5000);

    // 确认 run 确实尚未完成
    const entry = registry.get("task-001");
    expect(entry?.status).toBe("running");
  });
});

/** 轮询断言直到通过或超时（后台任务终态由外部 release 驱动） */
async function until(assertion: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("background bash — executeTool 与 REST 路径", () => {
  async function setupE2E(options?: { sandboxMode?: SandboxMode; withoutRegistry?: boolean }) {
    const root = await tempRoot();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({
      cwd: root,
      provider: "fake",
      model: "model",
      ...(options?.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
    });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const cores: Array<ReturnType<typeof createControllableCore>> = [];
    const registry = new BackgroundTaskRegistry(
      () => {
        const controllable = createControllableCore();
        cores.push(controllable);
        return controllable.client;
      },
      async () => undefined,
      (info) => events.publish({ source: "agent", type: "task.finished", sessionId: info.sessionId, payload: info }),
    );
    const requests: StreamChatRequest[] = [];
    const queue: Array<Array<Record<string, unknown>>> = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request: StreamChatRequest) {
        requests.push(request);
        const batch = queue.shift() ?? [{ type: "text_delta", text: "收尾" }, { type: "done", stopReason: "end_turn" }];
        for (const event of batch) yield event as never;
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const mainCore = createControllableCore().client;
    const agent = new AgentRunner(
      sessions, providers, mainCore, events, pricing,
      undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      options?.withoutRegistry ? undefined : registry,
    );
    const app = await buildServer({ core: mainCore, sessions, agent, events, providers, pricing, ...(options?.withoutRegistry ? {} : { backgroundTasks: registry }) });
    return { agent, session, cores, requests, queue, app };
  }

  it("后台 bash 立即回执不阻塞主循环；终态后 REST 可查任务与输出", async () => {
    const harness = await setupE2E();
    try {
      harness.queue.push([
        { type: "tool_call", id: "bg-1", name: "bash", input: { cmd: "npm run build", run_in_background: true } },
        { type: "done", stopReason: "tool_use" },
      ]);
      harness.queue.push([{ type: "text_delta", text: "后台任务已启动" }, { type: "done", stopReason: "end_turn" }]);
      // 后台 core 的 run 保持挂起，但 run() 在第二轮即结束——证明不阻塞主循环
      await harness.agent.run(harness.session.id, "后台构建");
      const result = harness.requests[1]?.messages.at(-1)?.content.find((block) => block.type === "tool_result");
      expect(result?.type === "tool_result" ? result.isError : true).toBeFalsy();
      const parsed = JSON.parse(result?.type === "tool_result" ? (result.content as string) : "{}") as { taskId: string; status: string };
      expect(parsed).toMatchObject({ status: "started" });
      expect(parsed.taskId).toMatch(/^task-/);
      expect(harness.cores).toHaveLength(1);

      harness.cores[0]!.emitExecOutput("building...");
      harness.cores[0]!.release({ exitCode: 0, durationMs: 1, truncated: false });
      // 轮询 REST 等待终态落定
      let list: Array<{ taskId: string; status: string; exitCode?: number }> = [];
      const deadline = Date.now() + 5000;
      for (;;) {
        const response = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks` });
        list = response.json<Array<{ taskId: string; status: string; exitCode?: number }>>();
        if (list[0]?.status !== "running") break;
        if (Date.now() >= deadline) throw new Error("task 未到终态");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(list[0]).toMatchObject({ taskId: parsed.taskId, status: "done", exitCode: 0 });
      const detail = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks/${parsed.taskId}` });
      expect(detail.json<{ output: string }>().output).toBe("building...");
      const missing = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks/task-nope` });
      expect(missing.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  }, 30_000);

  it("WSB 会话后台 bash → tool_result isError 且不起后台 core", async () => {
    const harness = await setupE2E({ sandboxMode: "wsb" as SandboxMode });
    try {
      harness.queue.push([
        { type: "tool_call", id: "bg-1", name: "bash", input: { cmd: "x", run_in_background: true } },
        { type: "done", stopReason: "tool_use" },
      ]);
      harness.queue.push([{ type: "text_delta", text: "了解" }, { type: "done", stopReason: "end_turn" }]);
      await harness.agent.run(harness.session.id, "后台");
      const result = harness.requests[1]?.messages.at(-1)?.content.find((block) => block.type === "tool_result");
      expect(result?.type === "tool_result" && result.isError).toBe(true);
      expect(result?.type === "tool_result" ? (result.content as string) : "").toContain("WSB");
      expect(harness.cores).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  }, 30_000);

  it("未注入 backgroundTasks：后台 bash isError，REST 501", async () => {
    const harness = await setupE2E({ withoutRegistry: true });
    try {
      harness.queue.push([
        { type: "tool_call", id: "bg-1", name: "bash", input: { cmd: "x", run_in_background: true } },
        { type: "done", stopReason: "tool_use" },
      ]);
      harness.queue.push([{ type: "text_delta", text: "了解" }, { type: "done", stopReason: "end_turn" }]);
      await harness.agent.run(harness.session.id, "后台");
      const result = harness.requests[1]?.messages.at(-1)?.content.find((block) => block.type === "tool_result");
      expect(result?.type === "tool_result" && result.isError).toBe(true);
      const list = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks` });
      expect(list.statusCode).toBe(501);
    } finally {
      await harness.app.close();
    }
  }, 30_000);
});
