import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxPolicy, ShellBackend } from "./sessions/types.js";
import { StdioTransport, type RpcTransport } from "./rpc/transport.js";

interface RpcErrorBody {
  code: number;
  message: string;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: RpcErrorBody;
}

export interface CoreInfo {
  version: string;
  protocolVersion?: string;
  platform: "windows" | "linux";
  sandboxCapability: string;
  features?: { fsStat: boolean; fsStatMany: boolean; fsWriteBase64: boolean; jobControl: boolean; fsHash: boolean; fsScanPagination: boolean; fsWatch: boolean };
  limits?: { maxFrameBytes: number; maxWriteBase64Bytes: number; maxHashBytes: number; maxStatManyPaths: number; maxStatManyPathBytes: number; maxScanEntries?: number; maxScanDepth?: number; maxScanNodes?: number; maxWatches?: number; maxWatchEvents?: number; maxConcurrentJobs?: number; maxJobOutputBytes?: number };
}

export interface ExecRequest {
  sessionId: string;
  execId: string;
  cmd: string;
  cwd: string;
  timeoutMs?: number;
  shellBackend?: ShellBackend;
}

export interface ExecResult {
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

export interface FsPathRequest { sessionId: string; path: string }
export interface FsReadRequest extends FsPathRequest { offset?: number; limit?: number }
export interface FsWriteRequest extends FsPathRequest { content: string; createDirs?: boolean }
/** Internal binary ingress only. data must be canonical base64; agent-facing
 * writeFile remains UTF-8 text-only. Optional for compatibility with an older
 * core binary, which the server reports as an unavailable upload capability. */
export interface FsWriteBase64Request extends FsPathRequest { data: string; createDirs?: boolean }
export interface FsEditRequest extends FsPathRequest { oldText: string; newText: string; replaceAll?: boolean }
export interface FsSearchRequest extends FsPathRequest { pattern: string }
export interface FsStatResult { type: "file" | "directory" | "other"; size: number; modifiedMs: number }
export interface FsHashResult { sha256: string; size: number }
export interface FsStatManyRequest { sessionId: string; paths: string[] }
export interface FsStatManyResult { entries: Array<FsStatResult & { path: string }> }
/** Bounded recursive scan. Paths in the result are relative to request.path. */
export interface FsScanRequest extends FsPathRequest { cursor?: number; limit?: number; maxDepth?: number }
export interface FsScanResult { entries: Array<{ path: string; type: "file" | "directory" | "other"; size: number }>; nextCursor?: number; truncated: boolean }
export interface FsWatchRequest extends FsPathRequest { recursive?: boolean }
export interface FsWatchPollRequest { sessionId: string; watchId: number; limit?: number }
export interface FsWatchPollResult { events: Array<{ path: string; kind: "created" | "changed" | "deleted" | "renamed" }>; overflow: boolean }
export interface JobStartRequest { sessionId: string; jobId: string; kind: "exec"; cmd: string; cwd: string; timeoutMs?: number; shellBackend?: ShellBackend }
export interface JobStatus { jobId: string; state: "running" | "completed" | "failed" | "cancelled" | "timed_out"; exitCode?: number; durationMs?: number; truncated?: boolean; error?: string }
export interface JobOutputRequest { sessionId: string; jobId: string; afterSeq: number; limit?: number }
export interface JobOutputResult { chunks: Array<{ seq: number; stream: "stdout" | "stderr"; data: string }>; nextSeq: number; truncated: boolean }
export interface FsReadResult { content: string; totalLines: number; encoding: "utf-8"; truncated: boolean }
export interface FsListResult { entries: Array<{ name: string; type: "file" | "directory" | "other"; size: number }>; truncated: boolean }
export interface FsGlobResult { paths: string[]; truncated: boolean }
export interface FsGrepResult { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }

export interface CoreEvent {
  source: "core";
  type: string;
  payload: unknown;
}

/** 外部建立的 core 连接（如 WSB 内 owc-exec --connect 回连的 TCP socket）。 */
export interface CoreConnection {
  transport: RpcTransport;
  child?: ChildProcessWithoutNullStreams;
}

/**
 * server 内部消费的 core 客户端公共面（CoreRouter 与 CoreClient 同构实现）。
 * release 仅 CoreRouter 提供：释放按会话持有的沙盒 core（如 WSB 虚拟机）。
 */
export interface CoreClientLike {
  start(): Promise<CoreInfo>;
  stop(): Promise<void>;
  ping(): Promise<CoreInfo>;
  run(request: ExecRequest): Promise<ExecResult>;
  configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string }>;
  cleanupSession(sessionId: string): Promise<{ ok: true }>;
  readFile(request: FsReadRequest): Promise<FsReadResult>;
  writeFile(request: FsWriteRequest): Promise<{ ok: true }>;
  writeFileBase64?(request: FsWriteBase64Request): Promise<{ ok: true }>;
  editFile(request: FsEditRequest): Promise<{ matches: number }>;
  statFile(request: FsPathRequest): Promise<FsStatResult>;
  statFiles(request: FsStatManyRequest): Promise<FsStatManyResult>;
  hashFile(request: FsPathRequest): Promise<FsHashResult>;
  scanFiles(request: FsScanRequest): Promise<FsScanResult>;
  watchFiles(request: FsWatchRequest): Promise<{ watchId: number }>;
  pollWatch(request: FsWatchPollRequest): Promise<FsWatchPollResult>;
  cancelWatch(request: { sessionId: string; watchId: number }): Promise<{ ok: true }>;
  startJob(request: JobStartRequest): Promise<JobStatus>;
  cancelJob(request: { sessionId: string; jobId: string }): Promise<{ jobId: string; accepted: true }>;
  jobStatus(request: { sessionId: string; jobId: string }): Promise<JobStatus>;
  jobOutput(request: JobOutputRequest): Promise<JobOutputResult>;
  listFiles(request: FsPathRequest): Promise<FsListResult>;
  globFiles(request: FsSearchRequest): Promise<FsGlobResult>;
  grepFiles(request: FsSearchRequest): Promise<FsGrepResult>;
  setRequestTimeoutMs(timeoutMs: number): void;
  on(eventName: string, listener: (...args: any[]) => void): unknown;
  release?(sessionId: string): Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  generation: number;
}

export class CoreRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "CoreRpcError";
  }
}

export class CoreClient extends EventEmitter {
  private transport: RpcTransport | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<CoreInfo> | undefined;
  private generation = 0;
  private failedGeneration = 0;

  constructor(
    private readonly corePath: string,
    private requestTimeoutMs = 130_000,
    /** 注入外部连接（WSB 回连 TCP）时跳过 spawn 与失败自动重启 */
    private readonly connectionFactory?: () => Promise<CoreConnection>,
  ) {
    super();
  }

  setRequestTimeoutMs(timeoutMs: number): void {
    this.requestTimeoutMs = timeoutMs;
  }

  start(): Promise<CoreInfo> {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    const generation = ++this.generation;
    this.startPromise = this.spawnAndHandshake(generation).catch((error: unknown) => {
      this.failConnection(generation, error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const generation = this.generation;
    const transport = this.transport;
    if (transport) {
      try {
        await this.call("core.shutdown", {}, 5_000);
      } catch {
        this.child?.kill();
      }
      try {
        await transport.close();
      } catch {
        this.child?.kill();
      }
    }
    this.failConnection(generation, new Error("Core client stopped"), false);
    this.startPromise = undefined;
  }

  ping(): Promise<CoreInfo> {
    return this.call<CoreInfo>("core.ping", {});
  }

  run(request: ExecRequest): Promise<ExecResult> {
    return this.call<ExecResult>("exec.run", request, (request.timeoutMs ?? 120_000) + 10_000);
  }

  configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string }> { return this.call("session.configure", request); }
  cleanupSession(sessionId: string): Promise<{ ok: true }> { return this.call("session.cleanup", { sessionId }); }
  readFile(request: FsReadRequest): Promise<FsReadResult> { return this.call("fs.read", request); }
  writeFile(request: FsWriteRequest): Promise<{ ok: true }> { return this.call("fs.write", request); }
  writeFileBase64(request: FsWriteBase64Request): Promise<{ ok: true }> { return this.call("fs.writeBase64", request); }
  editFile(request: FsEditRequest): Promise<{ matches: number }> { return this.call("fs.edit", request); }
  statFile(request: FsPathRequest): Promise<FsStatResult> { return this.call("fs.stat", request); }
  statFiles(request: FsStatManyRequest): Promise<FsStatManyResult> { return this.call("fs.statMany", request); }
  hashFile(request: FsPathRequest): Promise<FsHashResult> { return this.call("fs.hash", request); }
  scanFiles(request: FsScanRequest): Promise<FsScanResult> { return this.call("fs.scan", request); }
  watchFiles(request: FsWatchRequest): Promise<{ watchId: number }> { return this.call("fs.watch", request); }
  pollWatch(request: FsWatchPollRequest): Promise<FsWatchPollResult> { return this.call("fs.watch.poll", request); }
  cancelWatch(request: { sessionId: string; watchId: number }): Promise<{ ok: true }> { return this.call("fs.watch.cancel", request); }
  startJob(request: JobStartRequest): Promise<JobStatus> { return this.call("job.start", request); }
  cancelJob(request: { sessionId: string; jobId: string }): Promise<{ jobId: string; accepted: true }> { return this.call("job.cancel", request); }
  jobStatus(request: { sessionId: string; jobId: string }): Promise<JobStatus> { return this.call("job.status", request); }
  jobOutput(request: JobOutputRequest): Promise<JobOutputResult> { return this.call("job.output", request); }
  listFiles(request: FsPathRequest): Promise<FsListResult> { return this.call("fs.list", request); }
  globFiles(request: FsSearchRequest): Promise<FsGlobResult> { return this.call("fs.glob", request); }
  grepFiles(request: FsSearchRequest): Promise<FsGrepResult> { return this.call("fs.grep", request); }

  private async spawnAndHandshake(generation: number): Promise<CoreInfo> {
    const connection = this.connectionFactory ? await this.connectionFactory() : this.spawnStdio();
    const transport = connection.transport;
    this.child = connection.child;
    this.transport = transport;
    transport.on("message", (message) => this.onMessage(generation, message));
    transport.on("diagnostic", (text) => this.emit("diagnostic", text));
    transport.on("error", (error) => this.failConnection(generation, normalizeError(error)));
    transport.on("close", (details) => this.failConnection(generation, new Error("Core process exited"), true, details));
    const info = await this.ping();
    if (generation !== this.generation || this.failedGeneration === generation) throw new Error("Core process exited during handshake");
    this.restartCount = 0;
    this.emitEvent("core.ready", info);
    return info;
  }

  private spawnStdio(): CoreConnection {
    const executable = this.resolveCorePath();
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    return { transport: new StdioTransport(child), child };
  }

  private resolveCorePath(): string {
    if (path.isAbsolute(this.corePath)) return this.corePath;
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(moduleDirectory, "..", this.corePath);
  }

  private call<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const transport = this.transport;
    const generation = this.generation;
    if (!transport || this.failedGeneration === generation) return Promise.reject(new Error("Core is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Core request ${method} timed out`);
        this.failConnection(generation, error);
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, generation });
      try {
        transport.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.failConnection(generation, normalizeError(error));
      }
    });
  }

  private onMessage(generation: number, message: unknown): void {
    if (generation !== this.generation || !message || typeof message !== "object") return;
    if ("method" in message) {
      const notification = message as { jsonrpc?: unknown; method?: unknown; params?: unknown };
      if (notification.jsonrpc !== "2.0" || typeof notification.method !== "string") {
        this.failConnection(generation, new Error("Malformed RPC notification"));
        return;
      }
      this.emitEvent(notification.method, notification.params);
      return;
    }
    const response = message as Partial<RpcResponse>;
    if (response.jsonrpc !== "2.0" || typeof response.id !== "number") {
      this.failConnection(generation, new Error("Malformed RPC response"));
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
    const hasError = Object.prototype.hasOwnProperty.call(response, "error");
    if (hasResult === hasError || (hasError && !isRpcError(response.error))) {
      this.failConnection(generation, new Error("Malformed RPC response"));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending || pending.generation !== generation) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (hasError && response.error) pending.reject(new CoreRpcError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  }

  private failConnection(generation: number, error: Error, restart = true, details?: unknown): void {
    if (generation !== this.generation || this.failedGeneration === generation) return;
    this.failedGeneration = generation;
    const child = this.child;
    this.transport = undefined;
    this.child = undefined;
    this.startPromise = undefined;
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (child && child.exitCode === null) child.kill();
    this.emitEvent("core.exit", details ?? { message: error.message });
    if (this.stopping || !restart || this.restartCount >= 3 || this.connectionFactory) return;
    const delay = 250 * 2 ** this.restartCount++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start().catch((restartError: unknown) => this.emit("error", normalizeError(restartError)));
    }, delay);
  }

  private emitEvent(type: string, payload: unknown): void {
    const event: CoreEvent = { source: "core", type, payload };
    this.emit("event", event);
  }
}

function isRpcError(value: unknown): value is RpcErrorBody {
  return Boolean(value) && typeof value === "object" &&
    typeof (value as RpcErrorBody).code === "number" &&
    typeof (value as RpcErrorBody).message === "string";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
