import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { BackgroundTaskRegistry } from "../src/agent/background-tasks.js";
import { MessageQueue } from "../src/agent/message-queue.js";
import { CRON_MAX_JOBS_PER_SESSION, CronScheduler, nextCronFire, parseCronExpression } from "../src/cron-scheduler.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { SandboxMode } from "../src/sessions/types.js";
import { toolResultOf } from "./helpers/agent-harness.js";
import { makeControllableCore, type ControllableCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

let root: string;
beforeEach(async () => {
  root = await tempRoot("owc-bg-");
});

/**
 * BackgroundTaskRegistry 装配（configure 默认成功）。未传 factory 时每次 start
 * 新建一个可控 core 并记入 cores——第 i 个任务即 cores[i]。
 */
function makeRegistry(options: {
  factory?: () => CoreClientLike;
  configure?: () => Promise<void>;
  onFinished?: (info: { taskId: string }) => void;
  ttlMs?: number;
  onStarted?: (info: { taskId: string }) => void;
} = {}): { registry: BackgroundTaskRegistry; cores: ControllableCore[] } {
  const cores: ControllableCore[] = [];
  const registry = new BackgroundTaskRegistry(
    options.factory ?? (() => {
      const controllable = makeControllableCore();
      cores.push(controllable);
      return controllable.client;
    }),
    options.configure ?? (async () => undefined),
    options.onFinished,
    options.ttlMs,
    options.onStarted,
  );
  return { registry, cores };
}

describe("BackgroundTaskRegistry", () => {
  it("start 返回 taskId 和 status started", async () => {
    const factory = vi.fn(() => makeControllableCore().client);
    const { registry } = makeRegistry({ factory });

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
    // start 不 await run 完成（fake core 的 run 始终挂起）：entry 仍处于 running
    expect(registry.get("task-001")?.status).toBe("running");
  });

  it("get 返回任务信息与输出", async () => {
    const core = makeControllableCore();
    const { registry } = makeRegistry({ factory: () => core.client });

    await registry.start({
      sessionId: "s1",
      taskId: "task-001",
      cmd: "echo hello",
      cwd: root,
    });

    // release 前先读取——应该是 running
    expect(registry.get("task-001")?.status).toBe("running");

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
    const core = makeControllableCore();
    const { registry } = makeRegistry({ factory: () => core.client });

    await registry.start({ sessionId: "s1", taskId: "task-gbk", cmd: "echo 中文", cwd: root });
    // UTF-8 的“中文”被刻意拆在两个 pipe 通知中。
    core.emitExecOutput(Buffer.from([0xe4, 0xb8]) as unknown as string);
    core.emitExecOutput(Buffer.from([0xad, 0xe6, 0x96, 0x87]) as unknown as string);

    expect(registry.get("task-gbk")?.output).toBe("中文");
    core.release({ exitCode: 0, durationMs: 1, truncated: false });
  });

  it("task_stop 调 client.stop()，status=stopped", async () => {
    const core = makeControllableCore();
    const { registry } = makeRegistry({ factory: () => core.client });

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
    expect(core.stopped()).toBe(true);
  });

  it("任务完成后下一轮 system 含完成提示，再下一轮不含（读后即清）", async () => {
    const core = makeControllableCore();
    const { registry } = makeRegistry({ factory: () => core.client });

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
    const core = makeControllableCore();
    const { registry } = makeRegistry({ factory: () => core.client });

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
    const { registry } = makeRegistry();

    await registry.start({ sessionId: "s1", taskId: "task-001", cmd: "cmd1", cwd: root });
    await registry.start({ sessionId: "s1", taskId: "task-002", cmd: "cmd2", cwd: root });
    await registry.start({ sessionId: "s2", taskId: "task-003", cmd: "cmd3", cwd: root });

    const s1Tasks = registry.listForSession("s1");
    expect(s1Tasks).toHaveLength(2);
    expect(s1Tasks.map((t) => t.taskId).sort()).toEqual(["task-001", "task-002"]);
    expect(registry.hasRunningForSession("s1")).toBe(true);
    expect(registry.hasRunningForSession("missing")).toBe(false);

    const s2Tasks = registry.listForSession("s2");
    expect(s2Tasks).toHaveLength(1);
    expect(s2Tasks[0].taskId).toBe("task-003");
  });

  it("stopForSession 停止并 purge 该会话全部 entry（运行中与已完成）与通知", async () => {
    const { registry, cores } = makeRegistry();
    await registry.start({ sessionId: "s1", taskId: "task-001", cmd: "cmd1", cwd: root });
    await registry.start({ sessionId: "s1", taskId: "task-002", cmd: "cmd2", cwd: root });
    cores[0]!.release({ exitCode: 0, durationMs: 1, truncated: false });
    await vi.waitFor(() => {
      expect(registry.get("task-001")?.status).toBe("done");
    });

    await registry.stopForSession("s1");

    // 运行中 entry 先被 stop，随后与已完成 entry 一起 purge（会话删除后输出缓冲不再驻留），通知清空
    expect(registry.listForSession("s1")).toHaveLength(0);
    expect(registry.get("task-001")).toBeUndefined();
    expect(registry.get("task-002")).toBeUndefined();
    expect(registry.hasRunningForSession("s1")).toBe(false);
    expect(registry.drainNotices("s1")).toEqual([]);
  });

  it("完成态 entry 按 TTL 到期自动驱逐（运行中不受影响）", async () => {
    const { registry, cores } = makeRegistry({ ttlMs: 50 });

    await registry.start({ sessionId: "s1", taskId: "task-done", cmd: "cmd1", cwd: root });
    await registry.start({ sessionId: "s1", taskId: "task-running", cmd: "cmd2", cwd: root });
    cores[0]!.release({ exitCode: 0, durationMs: 1, truncated: false });
    await vi.waitFor(() => {
      expect(registry.get("task-done")?.status).toBe("done");
    });

    // TTL 到期后完成态 entry 被驱逐，仍 running 的 entry 保留
    await vi.waitFor(() => {
      expect(registry.get("task-done")).toBeUndefined();
    }, { timeout: 5000 });
    expect(registry.get("task-running")?.status).toBe("running");
    await registry.shutdown();
  });

  it("shutdown 清理所有任务", async () => {
    const { registry, cores } = makeRegistry();

    await registry.start({ sessionId: "s1", taskId: "task-001", cmd: "cmd1", cwd: root });
    await registry.start({ sessionId: "s2", taskId: "task-002", cmd: "cmd2", cwd: root });

    await registry.shutdown();

    expect(registry.listForSession("s1")).toHaveLength(0);
    expect(registry.listForSession("s2")).toHaveLength(0);
    expect(cores[0]!.stopped()).toBe(true);
    expect(cores[1]!.stopped()).toBe(true);
  });

  it("环形缓冲截断：推送 >256KB 输出，get 返回 truncated", async () => {
    const core = makeControllableCore();
    const { registry } = makeRegistry({ factory: () => core.client });

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
    const core = makeControllableCore();
    const onFinished = vi.fn();
    const { registry } = makeRegistry({ factory: () => core.client, onFinished });

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
    const core = makeControllableCore();
    const { registry } = makeRegistry({ factory: () => core.client });

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
    const { registry } = makeRegistry();

    const result = await registry.stop("nonexistent");
    expect(result).toBe(false);
  });
});

describe("background bash — executeTool 与 REST 路径", () => {
  async function setupE2E(options?: { sandboxMode?: SandboxMode; withoutRegistry?: boolean }) {
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
    const cores: ControllableCore[] = [];
    const registry = new BackgroundTaskRegistry(
      () => {
        const controllable = makeControllableCore();
        cores.push(controllable);
        return controllable.client;
      },
      async () => undefined,
      (info) => events.publish({ source: "agent", type: "task.finished", sessionId: info.sessionId, payload: info }),
    );
    const queue: Array<Array<Record<string, unknown>>> = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        const batch = queue.shift() ?? [{ type: "text_delta", text: "收尾" }, { type: "done", stopReason: "end_turn" }];
        for (const event of batch) yield event as never;
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const mainCore = makeControllableCore().client;
    const agent = new AgentRunner(
      sessions, providers, mainCore, events, pricing,
      undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      options?.withoutRegistry ? undefined : registry,
    );
    const app = await buildServer({ core: mainCore, sessions, agent, events, providers, pricing, ...(options?.withoutRegistry ? {} : { backgroundTasks: registry }) });
    return { agent, session, sessions, cores, queue, app };
  }

  type E2EHarness = Awaited<ReturnType<typeof setupE2E>>;

  /** 推入「后台 bash 工具调用 → 主循环收尾」两轮并跑完 run（后台 core 的 run 保持挂起） */
  async function runBackgroundTurn(harness: E2EHarness, cmd: string): Promise<void> {
    harness.queue.push([
      { type: "tool_call", id: "bg-1", name: "bash", input: { cmd, run_in_background: true } },
      { type: "done", stopReason: "tool_use" },
    ]);
    harness.queue.push([{ type: "text_delta", text: "已启动" }, { type: "done", stopReason: "end_turn" }]);
    await harness.agent.run(harness.session.id, "后台");
  }

  it("后台 bash 立即回执不阻塞主循环；终态后 REST 可查任务与输出", async () => {
    const harness = await setupE2E();
    try {
      await runBackgroundTurn(harness, "npm run build");
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "bg-1");
      expect(result?.isError).toBe(false);
      const parsed = JSON.parse(result?.content ?? "{}") as { taskId: string; status: string };
      expect(parsed).toMatchObject({ status: "started" });
      expect(parsed.taskId).toMatch(/^task-/);
      // 后台 core 的 run 保持挂起，但 run() 在第二轮即结束——证明不阻塞主循环
      expect(harness.cores).toHaveLength(1);

      harness.cores[0]!.emitExecOutput("building...");
      harness.cores[0]!.release({ exitCode: 0, durationMs: 1, truncated: false });
      // 轮询 REST 等待终态落定
      const list = await vi.waitFor(async () => {
        const response = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks` });
        const tasks = response.json<Array<{ taskId: string; status: string; exitCode?: number }>>();
        if (tasks[0]?.status === "running") throw new Error("task 未到终态");
        return tasks;
      }, { timeout: 5_000 });
      expect(list[0]).toMatchObject({ taskId: parsed.taskId, status: "done", exitCode: 0 });
      const detail = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks/${parsed.taskId}` });
      expect(detail.json<{ output: string }>().output).toBe("building...");
      const missing = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks/task-nope` });
      expect(missing.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  }, 30_000);

  it("tasks/:taskId 校验任务归属：跨会话读取任务输出返回 404", async () => {
    const harness = await setupE2E();
    try {
      await runBackgroundTurn(harness, "echo owned");
      const list = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks` });
      const taskId = list.json<Array<{ taskId: string }>>()[0]!.taskId;
      // 所属会话可读
      const own = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks/${taskId}` });
      expect(own.statusCode).toBe(200);
      // 其他会话（会话存在但任务不属于它）一律 404，不泄露任务存在性与输出
      const other = await harness.sessions.create({ cwd: harness.session.cwd, provider: "fake", model: "model" });
      const cross = await harness.app.inject({ method: "GET", url: `/api/sessions/${other.id}/tasks/${taskId}` });
      expect(cross.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  }, 30_000);

  it("WSB 会话后台 bash → tool_result isError 且不起后台 core", async () => {
    const harness = await setupE2E({ sandboxMode: "wsb" as SandboxMode });
    try {
      await runBackgroundTurn(harness, "x");
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "bg-1");
      expect(result?.isError).toBe(true);
      expect(result?.content).toContain("WSB");
      expect(harness.cores).toHaveLength(0);
    } finally {
      await harness.app.close();
    }
  }, 30_000);

  it("未注入 backgroundTasks：后台 bash isError，REST 501", async () => {
    const harness = await setupE2E({ withoutRegistry: true });
    try {
      await runBackgroundTurn(harness, "x");
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "bg-1");
      expect(result?.isError).toBe(true);
      const list = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/tasks` });
      expect(list.statusCode).toBe(501);
    } finally {
      await harness.app.close();
    }
  }, 30_000);
});

describe("BackgroundTaskRegistry — 启动失败与超时", () => {
  it("core 启动/配置失败：移除 entry、stop client 并抛错，不泄漏任务", async () => {
    let stopped = false;
    const failingClient = {
      on() { return failingClient; },
      async start() { throw new Error("spawn failed"); },
      async stop() { stopped = true; },
    } as unknown as CoreClientLike;
    const { registry } = makeRegistry({ factory: () => failingClient });

    await expect(registry.start({ sessionId: "s1", taskId: "task-bad", cmd: "x", cwd: root }))
      .rejects.toThrow("spawn failed");
    expect(registry.get("task-bad")).toBeUndefined();
    expect(registry.listForSession("s1")).toHaveLength(0);
    expect(registry.hasRunningForSession("s1")).toBe(false);
    expect(stopped).toBe(true);
  });

  it("configureSession 失败同样清理 entry 与 client", async () => {
    const core = makeControllableCore();
    const { registry } = makeRegistry({
      factory: () => core.client,
      configure: async () => { throw new Error("configure failed"); },
    });

    await expect(registry.start({ sessionId: "s1", taskId: "task-bad", cmd: "x", cwd: root }))
      .rejects.toThrow("configure failed");
    expect(registry.get("task-bad")).toBeUndefined();
    expect(core.stopped()).toBe(true);
  });

  it("start 的 timeoutMs 透传到 core run（后台任务长超时不被默认 RPC 超时杀连接）", async () => {
    const requests: Array<{ timeoutMs?: number }> = [];
    const core = makeControllableCore();
    const runClient = {
      ...core.client,
      async run(request: { timeoutMs?: number }) {
        requests.push(request);
        return new Promise(() => undefined); // 挂起，测试只关心请求参数
      },
    } as unknown as CoreClientLike;
    const { registry } = makeRegistry({ factory: () => runClient });

    await registry.start({ sessionId: "s1", taskId: "task-long", cmd: "build", cwd: root, timeoutMs: 10 * 60_000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.timeoutMs).toBe(600_000);
    await registry.stop("task-long");
  });
});

describe("onStarted 回调", () => {
  it("run 下发后触发 onStarted（info 为 running 态），启动失败不触发", async () => {
    const started: string[] = [];
    const { registry } = makeRegistry({ onStarted: (info) => started.push(info.taskId) });
    await registry.start({ sessionId: "s1", taskId: "task-ok", cmd: "echo hi", cwd: root });
    expect(started).toEqual(["task-ok"]);

    const failing = makeRegistry({
      configure: async () => { throw new Error("sandbox configure failed"); },
      onStarted: (info) => started.push(info.taskId),
    }).registry;
    await expect(failing.start({ sessionId: "s1", taskId: "task-bad", cmd: "echo hi", cwd: root })).rejects.toThrow("sandbox configure failed");
    expect(started).toEqual(["task-ok"]);
  });
});

/** 本地时区固定基准：2026-07-30 10:00:00（周四）。 */
const T0 = new Date(2026, 6, 30, 10, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface FireRecord {
  sessionId: string;
  prompt: string;
  stale: boolean;
}

/** autoSchedule=false + 注入时钟的测试调度器；fires 记录每次触发。 */
function makeScheduler(file: string, now: () => number, fires: FireRecord[]): CronScheduler {
  return new CronScheduler({
    file,
    now,
    autoSchedule: false,
    fire: (sessionId, prompt, meta) => {
      fires.push({ sessionId, prompt, stale: meta.stale });
    },
    onError: (error) => {
      throw error;
    },
  });
}

describe("parseCronExpression", () => {
  it("parseCronExpression：合法形态/7→0/非法拒绝", () => {
    const every = parseCronExpression("* * * * *");
    expect(every.minute).toHaveLength(60);
    expect(every.domAny).toBe(true);
    expect(every.dowAny).toBe(true);

    expect(parseCronExpression("*/5 * * * *").minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(parseCronExpression("0 9 * * 1-5").dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCronExpression("0 9 1,15 * *").dayOfMonth).toEqual([1, 15]);
    expect(parseCronExpression("30 14 1 6 0").month).toEqual([6]);
    expect(parseCronExpression("0 9-17/2 * * *").hour).toEqual([9, 11, 13, 15, 17]);
    // `a/n` 等价 `a-max/n`（标准语义）
    expect(parseCronExpression("10/20 * * * *").minute).toEqual([10, 30, 50]);

    // day-of-week 的 7 归一为 0（周日）
    expect(parseCronExpression("0 9 * * 7").dayOfWeek).toEqual([0]);
    expect(parseCronExpression("0 9 * * 0,7").dayOfWeek).toEqual([0]);

    expect(() => parseCronExpression("* * * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCronExpression("* * * * * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCronExpression("61 * * * *")).toThrow(/out of range 0-59/);
    expect(() => parseCronExpression("* 25 * * *")).toThrow(/out of range 0-23/);
    expect(() => parseCronExpression("* * 0 * *")).toThrow(/out of range 1-31/);
    expect(() => parseCronExpression("* * * 13 *")).toThrow(/out of range 1-12/);
    expect(() => parseCronExpression("a * * * *")).toThrow(/Invalid cron minute value/);
    expect(() => parseCronExpression("*/0 * * * *")).toThrow(/Invalid cron minute step/);
    expect(() => parseCronExpression("5-1 * * * *")).toThrow(/start > end/);
    expect(() => parseCronExpression("1/2/3 * * * *")).toThrow(/too many "\/"/);
    expect(() => parseCronExpression("1,,2 * * * *")).toThrow(/empty list item/);
  });
});

describe("nextCronFire（本地时区）", () => {
  it("nextCronFire 矩阵（日任务/分钟/或语义/跨年/不可达）", () => {
    // 每天 09:00：当天未到取当天，已过取次日
    const daily = parseCronExpression("0 9 * * *");
    expect(nextCronFire(daily, new Date(2026, 6, 30, 8, 30).getTime())).toBe(new Date(2026, 6, 30, 9, 0).getTime());
    expect(nextCronFire(daily, new Date(2026, 6, 30, 9, 0).getTime())).toBe(new Date(2026, 6, 31, 9, 0).getTime());

    // 每 15 分钟：取下一刻钟点
    const quarterHourly = parseCronExpression("*/15 * * * *");
    expect(nextCronFire(quarterHourly, new Date(2026, 6, 30, 10, 7).getTime())).toBe(new Date(2026, 6, 30, 10, 15).getTime());
    expect(nextCronFire(quarterHourly, new Date(2026, 6, 30, 10, 15).getTime())).toBe(new Date(2026, 6, 30, 10, 30).getTime());

    // 日/周都受限时取或（标准 cron 语义）
    // 每月 13 号 或 每周五 的 00:00；2026-07-30 是周四 → 下一天周五 07-31
    const domOrDow = parseCronExpression("0 0 13 * 5");
    expect(nextCronFire(domOrDow, new Date(2026, 6, 30, 10, 0).getTime())).toBe(new Date(2026, 6, 31, 0, 0).getTime());

    // 跨月/跨年与不可达表达式
    expect(nextCronFire(parseCronExpression("0 0 1 1 *"), new Date(2026, 6, 30).getTime())).toBe(new Date(2027, 0, 1, 0, 0).getTime());
    // 2 月 31 日永不触发
    expect(nextCronFire(parseCronExpression("0 0 31 2 *"), T0)).toBeNull();
  });
});

describe("CronScheduler", () => {
  it("fire 经回调注入 follow-up 队列并标记 source:cron（随 queue.json 持久化）", async () => {
    const dir = await tempRoot("owc-cron-");
    const queue = new MessageQueue(() => dir);
    let nowMs = T0;
    const scheduler = new CronScheduler({
      file: path.join(dir, "cron.json"),
      now: () => nowMs,
      autoSchedule: false,
      fire: (sessionId, prompt) => queue.enqueue(sessionId, "follow_up", `[cron] ${prompt}`, undefined, "cron"),
    });

    await scheduler.create("s1", { cron: "*/30 * * * *", prompt: "检查构建状态" });
    nowMs = T0 + 31 * MINUTE;
    await scheduler.check();

    const items = await queue.list("s1", "follow_up");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ content: "[cron] 检查构建状态", status: "queued", source: "cron" });
    // 新实例读取旧文件：source 字段随持久化保留
    expect((await new MessageQueue(() => dir).list("s1", "follow_up"))[0]).toMatchObject({ source: "cron" });
  });

  it("coalesce：错过多个理想触发点只补一次", async () => {
    const dir = await tempRoot("owc-cron-");
    const fires: FireRecord[] = [];
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, fires);

    await scheduler.create("s1", { cron: "*/30 * * * *", prompt: "心跳" });
    nowMs = T0 + 5 * HOUR; // 错过 10 个触发点
    await scheduler.check();
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ stale: false });
    // 再次 check 不重复触发（lastFiredAt 已推进）
    await scheduler.check();
    expect(fires).toHaveLength(1);
  });

  it("one-shot 触发一次后自动删除", async () => {
    const dir = await tempRoot("owc-cron-");
    const fires: FireRecord[] = [];
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, fires);

    await scheduler.create("s1", { cron: "45 10 * * *", prompt: "一次性提醒", recurring: false });
    nowMs = T0 + 50 * MINUTE;
    await scheduler.check();
    expect(fires).toHaveLength(1);
    expect(await scheduler.list("s1")).toHaveLength(0);

    nowMs = T0 + DAY;
    await scheduler.check();
    expect(fires).toHaveLength(1);
  });

  it("recurring 7 天到期：stale 触发最后一次并自动删除", async () => {
    const dir = await tempRoot("owc-cron-");
    const fires: FireRecord[] = [];
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, fires);

    await scheduler.create("s1", { cron: "0 9 * * *", prompt: "日报" });
    // 保留期内正常触发（次日 09:00）
    nowMs = T0 + DAY;
    await scheduler.check();
    expect(fires).toEqual([{ sessionId: "s1", prompt: "日报", stale: false }]);
    // 跳到 7 天保留期之后
    nowMs = T0 + 8 * DAY;
    await scheduler.check();
    expect(fires).toHaveLength(2);
    expect(fires[1]).toMatchObject({ stale: true });
    expect(await scheduler.list("s1")).toHaveLength(0);
  });

  it("list 视图：nextFireAt 与 stale 标记", async () => {
    const dir = await tempRoot("owc-cron-");
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, []);

    const created = await scheduler.create("s1", { cron: "0 9 * * *", prompt: "日报" });
    expect(created.nextFireAt).toBe(new Date(2026, 6, 31, 9, 0).toISOString());
    expect(created.stale).toBe(false);

    // 到期前最后一次触发点被钳到保留期到期点
    nowMs = T0 + 6 * DAY + 12 * HOUR;
    const [nearExpiry] = await scheduler.list("s1");
    expect(nearExpiry?.stale).toBe(false);
    expect(Date.parse(nearExpiry!.nextFireAt!)).toBeLessThanOrEqual(T0 + 7 * DAY);

    nowMs = T0 + 7 * DAY + MINUTE;
    const [expired] = await scheduler.list("s1");
    expect(expired?.stale).toBe(true);
    expect(expired?.nextFireAt).toBeNull();
  });

  it("每会话上限 50 条", async () => {
    const dir = await tempRoot("owc-cron-");
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => T0, []);
    for (let index = 0; index < CRON_MAX_JOBS_PER_SESSION; index += 1) {
      await scheduler.create("s1", { cron: "0 9 * * *", prompt: `任务 ${index}` });
    }
    await expect(scheduler.create("s1", { cron: "0 9 * * *", prompt: "溢出" })).rejects.toThrow(/limit reached/);
    // 其他会话不受牵连
    await scheduler.create("s2", { cron: "0 9 * * *", prompt: "别的会话" });
    expect(await scheduler.list("s2")).toHaveLength(1);
  });

  it("创建时拒绝非法表达式与空提示词", async () => {
    const dir = await tempRoot("owc-cron-");
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => T0, []);
    await expect(scheduler.create("s1", { cron: "61 * * * *", prompt: "x" })).rejects.toThrow(/out of range/);
    await expect(scheduler.create("s1", { cron: "0 9 * * *", prompt: "  " })).rejects.toThrow(/non-empty prompt/);
    await expect(scheduler.create("s1", { cron: "0 0 31 2 *", prompt: "x" })).rejects.toThrow(/no fire time/);
  });

  it("delete 与 deleteForSession 级联", async () => {
    const dir = await tempRoot("owc-cron-");
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => T0, []);
    const a = await scheduler.create("s1", { cron: "0 9 * * *", prompt: "a" });
    await scheduler.create("s1", { cron: "0 10 * * *", prompt: "b" });
    await scheduler.create("s2", { cron: "0 9 * * *", prompt: "c" });

    expect(await scheduler.delete("s1", a.id)).toBe(true);
    expect(await scheduler.delete("s1", a.id)).toBe(false);
    expect(await scheduler.list("s1")).toHaveLength(1);

    await scheduler.deleteForSession("s1");
    expect(await scheduler.list("s1")).toHaveLength(0);
    expect(await scheduler.list("s2")).toHaveLength(1);
  });

  it("重启恢复：重建调度器读 cron.json，停机期间错过的触发 coalesce 补一次", async () => {
    const dir = await tempRoot("owc-cron-");
    const file = path.join(dir, "cron.json");
    let nowMs = T0;
    const first = makeScheduler(file, () => nowMs, []);
    await first.create("s1", { cron: "*/30 * * * *", prompt: "周期任务" });
    await first.create("s1", { cron: "45 10 * * *", prompt: "一次性", recurring: false });
    first.stop();

    // “重启”：时钟前进 5 小时，新实例 load 立即 check
    nowMs = T0 + 5 * HOUR;
    const fires: FireRecord[] = [];
    const restored = makeScheduler(file, () => nowMs, fires);
    await restored.load();

    // 周期任务错过 10 个点只补一次；一次性任务补发后删除
    expect(fires).toHaveLength(2);
    const remaining = await restored.list("s1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ prompt: "周期任务", recurring: true });
  });
});
