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
  features?: { fsStat: boolean; fsStatMany: boolean; fsWriteBase64: boolean; jobControl: boolean; fsHash: boolean; fsScanPagination: boolean; fsWatch: boolean; indexScan?: boolean; indexExtract?: boolean };
  limits?: { maxFrameBytes: number; maxWriteBase64Bytes: number; maxHashBytes: number; maxStatManyPaths: number; maxStatManyPathBytes: number; maxScanEntries?: number; maxScanDepth?: number; maxScanNodes?: number; maxWatches?: number; maxWatchEvents?: number; maxConcurrentJobs?: number; maxJobOutputBytes?: number; maxIndexScanNodes?: number; maxIndexScanDepth?: number; maxIndexScanBytes?: number; maxIndexScanMs?: number; maxIndexExtractFiles?: number; maxIndexExtractBytes?: number; maxIndexExtractMs?: number; indexExtractDefaultSymbolsPerFile?: number; maxIndexExtractSymbolsPerFile?: number };
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
/** path.normalize：纯词法归一化 + 策略判定（无 IO）。allowed=false 时仍返回
 * canonical path 并带 reason；遍历/UNC/盘符相对等无法归一化的形态由 core 以
 * -32602 拒绝，调用方应回退原始字符串。 */
export interface PathNormalizeRequest extends FsPathRequest { purpose?: "read" | "write" }
export interface PathNormalizeResult { path: string; allowed: boolean; root: string; reason?: string }
export interface FsReadRequest extends FsPathRequest { offset?: number; limit?: number }
export interface FsWriteRequest extends FsPathRequest { content: string; createDirs?: boolean; /** Reject if the current file no longer has this digest. */ expectedSha256?: string }
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
/**
 * index.scan job（0.4.0 Phase 2）：按 glob 规则产出完整文件清单。
 * 输出是 job.output 上的 JSONL 流（stdout 流），每行一个条目：
 *   {"path","size","modifiedMs","sha256"?}   —— 按 path 排序，两次扫描结果确定
 *   {"summary":{"entries","truncated","reason","hashTruncated"}} —— 最后一行
 * sha256 仅在文件可哈希（≤16 MiB 且在 maxBytes 预算内）时出现；增量变化集
 * 由 Node 侧对连续 manifest 做 diff，core 始终输出完整清单。
 * timeoutMs 对 index.scan 无效（扫描时长由 maxMs 预算控制，超时为优雅截断）。
 */
export interface IndexScanStartRequest {
  sessionId: string;
  jobId: string;
  kind: "index.scan";
  cwd: string;
  /** 相对会话根的扫描根目录 */
  path: string;
  /** fs.glob 语义的 * / ? 规则；空/缺省表示全部文件 */
  include?: string[];
  /** 命中的文件与目录既不收录也不遍历 */
  exclude?: string[];
  maxDepth?: number;
  maxNodes?: number;
  /** 哈希字节预算；用尽后文件仍收录但不再带 sha256（summary.hashTruncated） */
  maxBytes?: number;
  /** 时间预算（毫秒）；用尽后扫描优雅截断（summary.truncated, reason:"time"） */
  maxMs?: number;
}
export interface IndexScanEntry { path: string; size: number; modifiedMs: number; sha256?: string }
export interface IndexScanSummary { entries: number; truncated: boolean; reason: "nodes" | "depth" | "time" | "list" | null; hashTruncated: boolean }
/**
 * grep job（0.5.0 Phase 2c）：并行文件内容搜索。
 * 输出是 job.output 上的 JSONL 流（stdout 流），每行一个匹配：
 *   {"path","line","text"}   —— 按 path（再按 line）排序，两次搜索结果确定
 *   {"summary":{"matches","truncated","reason"}} —— 最后一行
 * 文件读取由 N 个工作线程并行完成；遍历预算/取消/策略与 index.scan 一致。
 * timeoutMs 对 grep 无效（搜索时长由 maxMs 预算控制，超时为优雅截断）。
 */
export interface GrepJobStartRequest {
  sessionId: string;
  jobId: string;
  kind: "grep";
  cwd: string;
  path: string;
  pattern: string;
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
  maxNodes?: number;
  maxMs?: number;
}
/**
 * glob job（0.5.0 Phase 2c）：路径模式匹配搜索。
 * 输出是 job.output 上的 JSONL 流（stdout 流），每行一个路径：
 *   {"path"}   —— 按 path 排序，两次搜索结果确定
 *   {"summary":{"entries","truncated","reason"}} —— 最后一行
 */
export interface GlobJobStartRequest {
  sessionId: string;
  jobId: string;
  kind: "glob";
  cwd: string;
  path: string;
  pattern: string;
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
  maxNodes?: number;
  maxMs?: number;
}
/**
 * index.extract job：对 Node 侧 manifest diff 算出的变化文件集做符号提取。
 * 提取规则是原 server 侧 symbols.ts（已删除）的 C 移植（core/src/symbol_extract.c），
 * 输出是 job.output 上的 JSONL 流（stdout 流）：
 *   {"path","symbols":[{"name","kind","startLine","endLine","signature"}]} —— 每个处理文件一行（0 符号也输出）
 *   {"summary":{"files","symbols","truncated","reason"}} —— 最后一行
 * 不支持的扩展名、>1 MiB、非 UTF-8、读取失败、策略拒绝的文件整条跳过（不出现在输出）。
 * timeoutMs 对 index.extract 无效（时长由 maxMs 预算控制，超时为优雅截断）。
 */
export interface IndexExtractStartRequest {
  sessionId: string;
  jobId: string;
  kind: "index.extract";
  cwd: string;
  /** 相对会话根的根目录；files 相对该目录 */
  path: string;
  /** 相对 path 的文件清单（最多 4096 条，单条最长 1024 字节），按给定顺序处理 */
  files: string[];
  /** 总读取字节预算（默认 64 MiB，上限 1 GiB）；用尽后截断（reason:"bytes"） */
  maxBytes?: number;
  /** 时间预算毫秒（默认 30000，上限 300000）；用尽后截断（reason:"time"） */
  maxMs?: number;
  /** 单文件符号数上限（默认 200，上限 10000） */
  maxSymbolsPerFile?: number;
}
export interface IndexExtractSymbol { name: string; kind: string; startLine: number; endLine: number; signature: string }
export interface IndexExtractEntry { path: string; symbols: IndexExtractSymbol[] }
export interface IndexExtractSummary { files: number; symbols: number; truncated: boolean; reason: "bytes" | "time" | null }
export interface JobStatus { jobId: string; state: "running" | "completed" | "failed" | "cancelled" | "timed_out"; exitCode?: number; durationMs?: number; truncated?: boolean; error?: string }
export interface JobOutputRequest { sessionId: string; jobId: string; afterSeq: number; limit?: number }
export interface JobOutputResult { chunks: Array<{ seq: number; stream: "stdout" | "stderr"; data: string }>; nextSeq: number; truncated: boolean }
/** pty.open：session 为已配置会话 id，cwd 必须等于会话根；sandbox 由调用方决定
 * （人类终端通道强制 false；sandbox=true 供后续 agent 持久 shell 复用会话策略）。 */
export interface PtyOpenRequest { session: string; cwd: string; cols: number; rows: number; sandbox: boolean; shell?: string }
export interface PtyOpenResult { ptyId: number; sandboxCapability?: string; sandboxReason?: string }
export interface PtyInputRequest { ptyId: number; data: string }
export interface PtyResizeRequest { ptyId: number; cols: number; rows: number }
/** pty.output 通知载荷（data 为 base64，seq 在单 pty 内从 0 递增） */
export interface PtyOutputEvent { ptyId: number; seq: number; data: string }
/** pty.exit 通知载荷：子进程退出时恰好一次，记录保留到显式 pty.close */
export interface PtyExitEvent { ptyId: number; exitCode?: number }
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
  startIndexScan(request: IndexScanStartRequest): Promise<JobStatus>;
  startGrepJob(request: GrepJobStartRequest): Promise<JobStatus>;
  startGlobJob(request: GlobJobStartRequest): Promise<JobStatus>;
  startIndexExtract(request: IndexExtractStartRequest): Promise<JobStatus>;
  cancelJob(request: { sessionId: string; jobId: string }): Promise<{ jobId: string; accepted: true }>;
  jobStatus(request: { sessionId: string; jobId: string }): Promise<JobStatus>;
  jobOutput(request: JobOutputRequest): Promise<JobOutputResult>;
  listFiles(request: FsPathRequest): Promise<FsListResult>;
  globFiles(request: FsSearchRequest): Promise<FsGlobResult>;
  grepFiles(request: FsSearchRequest): Promise<FsGrepResult>;
  /** path.normalize（可选）：旧 core 二进制无此能力时缺省，调用方回退原始路径。 */
  normalizePath?(request: PathNormalizeRequest): Promise<PathNormalizeResult>;
  /** pty.*（可选）：旧 core 二进制无 features.pty 时缺省，终端通道应报不可用。 */
  openPty?(request: PtyOpenRequest): Promise<PtyOpenResult>;
  inputPty?(request: PtyInputRequest): Promise<{ ok: true }>;
  resizePty?(request: PtyResizeRequest): Promise<{ ok: true }>;
  closePty?(request: { ptyId: number }): Promise<{ ok: true; exitCode?: number }>;
  /** per-pty 事件通道（exec.output 的 emitter 先例按 ptyId 细分）：output/exit */
  ptyEvents?(ptyId: number): EventEmitter;
  removePtyEvents?(ptyId: number): void;
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
  private readonly ptyEmitters = new Map<number, EventEmitter>();
  private readonly pendingPtyEvents = new Map<number, Array<{ type: "output" | "exit"; params: unknown }>>();
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
  startIndexScan(request: IndexScanStartRequest): Promise<JobStatus> { return this.call("job.start", request); }
  startGrepJob(request: GrepJobStartRequest): Promise<JobStatus> { return this.call("job.start", request); }
  startGlobJob(request: GlobJobStartRequest): Promise<JobStatus> { return this.call("job.start", request); }
  startIndexExtract(request: IndexExtractStartRequest): Promise<JobStatus> { return this.call("job.start", request); }
  cancelJob(request: { sessionId: string; jobId: string }): Promise<{ jobId: string; accepted: true }> { return this.call("job.cancel", request); }
  jobStatus(request: { sessionId: string; jobId: string }): Promise<JobStatus> { return this.call("job.status", request); }
  jobOutput(request: JobOutputRequest): Promise<JobOutputResult> { return this.call("job.output", request); }
  listFiles(request: FsPathRequest): Promise<FsListResult> { return this.call("fs.list", request); }
  globFiles(request: FsSearchRequest): Promise<FsGlobResult> { return this.call("fs.glob", request); }
  grepFiles(request: FsSearchRequest): Promise<FsGrepResult> { return this.call("fs.grep", request); }
  normalizePath(request: PathNormalizeRequest): Promise<PathNormalizeResult> { return this.call("path.normalize", request); }
  openPty(request: PtyOpenRequest): Promise<PtyOpenResult> { return this.call("pty.open", request); }
  inputPty(request: PtyInputRequest): Promise<{ ok: true }> { return this.call("pty.input", request); }
  resizePty(request: PtyResizeRequest): Promise<{ ok: true }> { return this.call("pty.resize", request); }
  closePty(request: { ptyId: number }): Promise<{ ok: true; exitCode?: number }> { return this.call("pty.close", request); }

  /** per-pty 事件通道：pty.open 响应到达前 core 可能已经推 output（shell banner），
   * 无订阅者的通知先缓冲（上限 256 条），首个 listener 挂载时回放。 */
  ptyEvents(ptyId: number): EventEmitter {
    let emitter = this.ptyEmitters.get(ptyId);
    if (!emitter) {
      emitter = new EventEmitter();
      const buffered = this.pendingPtyEvents.get(ptyId) ?? [];
      this.pendingPtyEvents.delete(ptyId);
      if (buffered.length > 0) {
        const target = emitter;
        target.once("newListener", () => {
          for (const event of buffered) target.emit(event.type, event.params);
        });
      }
      this.ptyEmitters.set(ptyId, emitter);
    }
    return emitter;
  }

  removePtyEvents(ptyId: number): void {
    this.ptyEmitters.delete(ptyId);
    this.pendingPtyEvents.delete(ptyId);
  }

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
    if (!transport || this.failedGeneration === generation) {
      this.kickRestart();
      return Promise.reject(new Error("Core is not running"));
    }
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
      if (notification.method === "pty.output" || notification.method === "pty.exit") {
        const params = notification.params as { ptyId?: unknown } | undefined;
        const ptyId = params && typeof params.ptyId === "number" ? params.ptyId : undefined;
        if (ptyId !== undefined) {
          const type = notification.method === "pty.output" ? "output" : "exit";
          const emitter = this.ptyEmitters.get(ptyId);
          if (emitter) emitter.emit(type, notification.params);
          else {
            const buffered = this.pendingPtyEvents.get(ptyId) ?? [];
            if (buffered.length < 256) {
              buffered.push({ type, params: notification.params });
              this.pendingPtyEvents.set(ptyId, buffered);
            }
          }
        }
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
    // core 重启/退出意味着全部 pty 已死：通知每个 per-pty 通道退出并清表
    for (const emitter of this.ptyEmitters.values()) emitter.emit("exit", {});
    this.ptyEmitters.clear();
    this.pendingPtyEvents.clear();
    this.emitEvent("core.exit", details ?? { message: error.message });
    // 崩溃恢复：指数退避封顶 30s 后持续慢速重试，不再永久放弃（旧逻辑 3 次即死，
    // 需要整 server 重启才能恢复）；restartCount 在握手成功时清零（spawnAndHandshake）。
    if (this.stopping || !restart || this.connectionFactory) return;
    const delay = Math.min(30_000, 250 * 2 ** this.restartCount++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start().catch((restartError: unknown) => this.emitStartError(restartError));
    }, delay);
  }

  /** 懒重启：core 已死且当前没有启动中时，有请求进来立即拉起（取消排程中的退避等待）。 */
  private kickRestart(): void {
    if (this.stopping || this.connectionFactory || this.startPromise) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.start().catch((error: unknown) => this.emitStartError(error));
  }

  /** EventEmitter 的 "error" 事件无监听时会抛出（测试装配常不监听）；
   * 有监听走 "error"（生产 index.ts 打 stderr），无监听降级为普通 core.error 事件。 */
  private emitStartError(error: unknown): void {
    const normalized = normalizeError(error);
    if (this.listenerCount("error") > 0) this.emit("error", normalized);
    else this.emitEvent("core.error", { message: normalized.message });
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
