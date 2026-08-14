import type { CoreClientLike, ExecResult } from "../core-client.js";
import type { ShellBackend } from "../sessions/types.js";
import { decodeProcessOutputChunks, type EncodedProcessOutput } from "./output-decoder.js";
import { coreExecShell } from "./shell-detect.js";

interface BackgroundTaskInfo {
  taskId: string;
  sessionId: string;
  cmd: string;
  cwd: string;
  status: "running" | "done" | "failed" | "stopped";
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
}

interface TaskEntry {
  info: BackgroundTaskInfo;
  output: EncodedProcessOutput[];
  outputBytes: number;
  nextOutputSeq: number;
  truncated: boolean;
  client: CoreClientLike;
  settled: boolean;
  /** 完成态 TTL 驱逐定时器（unref，不拖住进程退出） */
  evictTimer?: NodeJS.Timeout;
}

/**
 * 每个后台任务独占一个 core 进程。registry 通过 coreFactory 为该任务启动独立 CoreClient，
 * 走与主循环相同的 configureSession + sandbox 策略，然后发起 run 但不 await。
 * 主循环的 core 连接完全不受影响。
 *
 * 输出环形缓冲：每任务原始字节总量上限 256KB，超限丢头部（记 truncated 标志）。
 * 保留字节至读取时再解码，避免多字节 UTF-8/GBK 字符恰好被 pipe 分片时变成替换字符。
 * 终态 entry 不永久驻留：stopForSession（会话删除）purge 该会话全部 entry，其余终态
 * entry 按 TTL（默认 1 小时）驱逐。
 * task_stop 即 kill 该任务专属 CoreClient 进程（Windows Job Object KILL_ON_JOB_CLOSE 保证
 *  kill core 进程即杀尽孙进程树）。posix 平台 kill 后孙进程可能孤儿化。
 */
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly notices = new Map<string, string[]>();

  constructor(
    private readonly coreFactory: () => CoreClientLike,
    private readonly configureSession: (client: CoreClientLike, sessionId: string, cwd: string) => Promise<void>,
    private readonly onFinished?: (info: BackgroundTaskInfo) => void,
    /** 完成态 entry 的驻留 TTL（测试可注入小值）；到期驱逐，防输出缓冲无限期占内存 */
    private readonly finishedTtlMs = 60 * 60_000,
    /** 任务成功发起（core 连接与沙盒配置完成、run 已下发）后回调；供 WS 即时通知，替代前端盲轮询 */
    private readonly onStarted?: (info: BackgroundTaskInfo) => void,
  ) {}

  async start(opts: {
    sessionId: string;
    taskId: string;
    cmd: string;
    cwd: string;
    timeoutMs?: number;
    shellBackend?: ShellBackend;
  }): Promise<BackgroundTaskInfo> {
    const { sessionId, taskId, cmd, cwd, timeoutMs, shellBackend } = opts;
    const client = this.coreFactory();
    const info: BackgroundTaskInfo = {
      taskId,
      sessionId,
      cmd,
      cwd,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    const entry: TaskEntry = {
      info,
      output: [],
      outputBytes: 0,
      nextOutputSeq: 0,
      truncated: false,
      client,
      settled: false,
    };
    this.tasks.set(taskId, entry);

    // 收集输出
    client.on("event", (event: { type: string; payload?: { execId?: string; stream?: string; data?: string; seq?: number } }) => {
      if (event.type === "exec.output" && event.payload?.data && typeof event.payload.data === "string") {
        const seq = typeof event.payload.seq === "number" ? event.payload.seq : entry.nextOutputSeq;
        this.appendOutput(entry, {
          stream: event.payload.stream ?? "stdout",
          data: event.payload.data,
          seq,
        });
        entry.nextOutputSeq = Math.max(entry.nextOutputSeq, seq + 1);
      }
    });

    // 启动 core 连接；失败时移除 entry 并停掉 client，避免泄漏未配置完成的任务与进程
    try {
      await client.start();
      await this.configureSession(client, sessionId, cwd);
    } catch (error) {
      this.tasks.delete(taskId);
      try {
        await client.stop();
      } catch {
        // 清理失败的进程不影响原始错误抛出
      }
      throw error;
    }

    // 发起 run（不 await），完成后处理终态
    void client.run({ sessionId, execId: taskId, cmd, cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...coreExecShell(shellBackend ?? "default") })
      .then((result: ExecResult) => this.finish(entry, "done", result.exitCode))
      .catch((error: Error) => {
        if (entry.settled) return; // 已由 stop 标记为 stopped
        this.finish(entry, "failed", undefined, error.message);
      });

    this.onStarted?.(info);
    return info;
  }

  get(taskId: string): (BackgroundTaskInfo & { output: string; truncated?: boolean }) | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    const output = decodeProcessOutputChunks(entry.output).map((chunk) => chunk.data).join("");
    return { ...entry.info, output, ...(entry.truncated ? { truncated: true } : {}) };
  }

  listForSession(sessionId: string): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      if (entry.info.sessionId === sessionId) {
        result.push(entry.info);
      }
    }
    return result;
  }

  /** Snapshot/managed-workspace mutations must not unmount a directory used by a task's dedicated core process. */
  hasRunningForSession(sessionId: string): boolean {
    for (const entry of this.tasks.values()) {
      if (entry.info.sessionId === sessionId && !entry.settled && entry.info.status === "running") return true;
    }
    return false;
  }

  async stop(taskId: string): Promise<boolean> {
    const entry = this.tasks.get(taskId);
    if (!entry) return false;
    if (entry.settled) return true;
    entry.settled = true;
    entry.info.status = "stopped";
    entry.info.finishedAt = new Date().toISOString();
    try {
      await entry.client.stop();
    } catch {
      // 停止进程时的异常不影响状态标记
    }
    this.pushNotice(entry.info.sessionId, `后台任务 ${taskId} 已停止`);
    this.onFinished?.(entry.info);
    this.scheduleEviction(taskId, entry);
    return true;
  }

  async stopForSession(sessionId: string): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [taskId, entry] of this.tasks) {
      if (entry.info.sessionId === sessionId && !entry.settled) {
        promises.push(this.stop(taskId).then(() => undefined));
      }
    }
    await Promise.all(promises);
    // 会话删除后该会话的任务 entry（含至多 256KB 输出缓冲）一并 purge，不再驻留内存
    for (const [taskId, entry] of this.tasks) {
      if (entry.info.sessionId !== sessionId) continue;
      if (entry.evictTimer) clearTimeout(entry.evictTimer);
      this.tasks.delete(taskId);
    }
    this.notices.delete(sessionId);
  }

  drainNotices(sessionId: string): string[] {
    const notices = this.notices.get(sessionId);
    if (!notices) return [];
    this.notices.delete(sessionId);
    return notices;
  }

  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, entry] of this.tasks) {
      if (!entry.settled) {
        entry.settled = true;
        promises.push(
          (async () => {
            try {
              await entry.client.stop();
            } catch {
              // 关停时忽略单个进程异常
            }
          })(),
        );
      }
    }
    await Promise.all(promises);
    for (const [, entry] of this.tasks) {
      if (entry.evictTimer) clearTimeout(entry.evictTimer);
    }
    this.tasks.clear();
    this.notices.clear();
  }

  private finish(entry: TaskEntry, status: "done" | "failed", exitCode?: number, errorMessage?: string): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.info.status = status;
    if (exitCode !== undefined) entry.info.exitCode = exitCode;
    entry.info.finishedAt = new Date().toISOString();

    const cmdPreview = entry.info.cmd.length > 80 ? entry.info.cmd.slice(0, 80) + "..." : entry.info.cmd;
    const notice = status === "failed"
      ? `后台任务 ${entry.info.taskId} 失败：${errorMessage ?? "未知错误"}（${cmdPreview}）`
      : `后台任务 ${entry.info.taskId} 已结束（exit ${exitCode}）：${cmdPreview}`;
    this.pushNotice(entry.info.sessionId, notice);

    // 释放 core 进程
    void entry.client.stop().catch(() => undefined);

    this.onFinished?.(entry.info);
    this.scheduleEviction(entry.info.taskId, entry);
  }

  /** 完成态 entry 的 TTL 驱逐：输出缓冲不能无限期留在 Map 里；unref 防定时器拖住进程退出。 */
  private scheduleEviction(taskId: string, entry: TaskEntry): void {
    entry.evictTimer = setTimeout(() => {
      // 仅驱逐仍处于终态的同一个 entry（防御 entry 被替换时误删）
      if (this.tasks.get(taskId) === entry && entry.settled) this.tasks.delete(taskId);
    }, this.finishedTtlMs);
    entry.evictTimer.unref();
  }

  private pushNotice(sessionId: string, notice: string): void {
    const list = this.notices.get(sessionId) ?? [];
    list.push(notice);
    this.notices.set(sessionId, list);
  }

  private appendOutput(entry: TaskEntry, chunk: EncodedProcessOutput): void {
    const MAX_OUTPUT_BYTES = 256 * 1024;
    const raw = Buffer.from(chunk.data, "base64");
    if (raw.length >= MAX_OUTPUT_BYTES) {
      // Core normally emits 4KB frames, but preserve the tail if an injected or
      // future transport frame is larger than the entire ring buffer.
      const tail = raw.subarray(raw.length - MAX_OUTPUT_BYTES);
      entry.output = [{ ...chunk, data: tail.toString("base64") }];
      entry.outputBytes = tail.length;
      entry.truncated = true;
      return;
    }
    const byteLength = raw.length;
    entry.output.push(chunk);
    entry.outputBytes += byteLength;
    while (entry.outputBytes > MAX_OUTPUT_BYTES && entry.output.length > 0) {
      const oldest = entry.output.shift()!;
      entry.outputBytes -= Buffer.from(oldest.data, "base64").length;
      entry.truncated = true;
    }
  }
}
