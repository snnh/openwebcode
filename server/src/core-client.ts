import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreShellBackend, SandboxPolicy } from "./sessions/types.js";
import { StdioTransport, type RpcTransport } from "./rpc/transport.js";

interface RpcErrorBody {
  code: number;
  message: string;
}

/**
 * Windows 下为 core（及其 pty/exec 派生的 cmd/pwsh 子进程）把 System32 前置到 PATH：
 * server 从 Git Bash/MSYS 环境启动时 PATH 里 usr\bin 先于 System32，find/sort/fc 等会被
 * 解析成 MSYS 版本（语义截然不同，如 `find /c` 变成递归遍历目录）。前置后内置伴随命令
 * 恢复 Windows 语义，其余 PATH 条目保持不变（显式调用 bash 等仍可用）。
 */
export function sanitizedCoreEnv(): NodeJS.ProcessEnv | undefined {
  if (process.platform !== "win32") return undefined;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  const prefixes = [path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "Wbem")];
  const seen = new Set(prefixes.map((entry) => entry.toLowerCase()));
  const rest = (env[pathKey] ?? "").split(";").filter((entry) => entry.length > 0 && !seen.has(entry.toLowerCase()));
  env[pathKey] = [...prefixes, ...rest].join(";");
  return env;
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
  features?: { fsStat: boolean; fsStatMany: boolean; fsWriteBase64: boolean; jobControl: boolean; fsHash: boolean; fsScanPagination: boolean; fsWatch: boolean; indexScan?: boolean; indexExtract?: boolean; grepJob?: boolean; globJob?: boolean; pathNormalize?: boolean; shellBash?: boolean; pty?: boolean; bindLink?: boolean; fsReadBase64?: boolean; overlay?: { supported: boolean; fuseOverlayfs: boolean; kernelMount: boolean }; bwrap?: { available: boolean; reason?: string } };
  limits?: { maxFrameBytes: number; maxWriteBase64Bytes: number; maxHashBytes: number; maxStatManyPaths: number; maxStatManyPathBytes: number; maxScanEntries?: number; maxScanDepth?: number; maxScanNodes?: number; maxWatches?: number; maxWatchEvents?: number; maxConcurrentJobs?: number; maxJobOutputBytes?: number; maxIndexScanNodes?: number; maxIndexScanDepth?: number; maxIndexScanBytes?: number; maxIndexScanMs?: number; maxSearchNodes?: number; maxSearchDepth?: number; maxSearchMs?: number; maxIndexExtractFiles?: number; maxIndexExtractBytes?: number; maxIndexExtractMs?: number; indexExtractDefaultSymbolsPerFile?: number; maxIndexExtractSymbolsPerFile?: number; maxConcurrentPtys?: number; maxPtyOutputChunkBytes?: number; maxPtyInputBytes?: number; maxReadBase64Bytes?: number };
}

export interface ExecRequest {
  sessionId: string;
  execId: string;
  cmd: string;
  cwd: string;
  timeoutMs?: number;
  shellBackend?: CoreShellBackend;
  /** 显式 shell 可执行路径（host 探测的绝对路径，如 Git Bash）；存在时优先于 core 的后端默认搜索。 */
  shellPath?: string;
  /** 单次执行的网络覆盖（server 内部专用；filtered 会话里用于把 sidecar 提升为 allow）。 */
  network?: "allow" | "deny";
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
/** fs.readBase64：size 为本次返回（base64 编码前）的字节数；文件超过 core 上限时只含前缀且 truncated 为 true。 */
export interface FsReadBase64Result { base64: string; size: number; truncated: boolean }
export interface FsStatManyRequest { sessionId: string; paths: string[] }
export interface FsStatManyResult { entries: Array<FsStatResult & { path: string }> }
/** Bounded recursive scan. Paths in the result are relative to request.path. */
export interface FsScanRequest extends FsPathRequest { cursor?: number; limit?: number; maxDepth?: number }
export interface FsScanResult { entries: Array<{ path: string; type: "file" | "directory" | "other"; size: number }>; nextCursor?: number; truncated: boolean }
export interface FsWatchRequest extends FsPathRequest { recursive?: boolean }
export interface FsWatchPollRequest { sessionId: string; watchId: number; limit?: number }
export interface FsWatchPollResult { events: Array<{ path: string; kind: "created" | "changed" | "deleted" | "renamed" }>; overflow: boolean }
export interface JobStartRequest { sessionId: string; jobId: string; kind: "exec"; cmd: string; cwd: string; timeoutMs?: number; shellBackend?: CoreShellBackend; shellPath?: string; /** 单次 job 的网络覆盖（server 内部专用；filtered 会话的 sidecar 代理以 allow 启动）。 */ network?: "allow" | "deny" }
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
 * searchJob：agent glob/grep 工具的搜索请求。core 上报 features.grepJob/globJob 时
 * 实现方走 kind "grep"/"glob" 并行 job（不阻塞 core 主循环的单线程 RPC），否则回退
 * 同步 fs.glob/fs.grep；两种路径的返回形状完全一致（FsGlobResult/FsGrepResult）。
 * cwd 为会话根（job.start 要求与 session.configure 的 cwd 一致）；signal 中止时
 * 尽力 job.cancel 后以错误结束。
 */
export interface SearchJobRequest { sessionId: string; cwd: string; path: string; pattern: string; signal?: AbortSignal }
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
/**
 * overlay.*：Linux overlayfs 快照原语（信任边界同 pty.*，core 本身非沙盒进程）。
 * stateRoot 为 core 侧根界：upper/work/merged/dest/sourceUpper 必须严格位于其下
 * （绝对路径、无点分量，core 再做 realpath 符号链接逃逸复核）；lower 只要求存在且是目录。
 * 仅在 core.ping 的 features.overlay.supported 为 true 时可用；restore 在有 running
 * job 时返回稳定冲突错误码 -32005。
 */
export interface OverlayMountRequest { stateRoot: string; lower: string; upper: string; work: string; merged: string }
export interface OverlayMountResult { ok: true; method: "kernel" | "fuse" }
export interface OverlayCheckpointRequest { stateRoot: string; upper: string; dest: string }
export interface OverlayCopyResult { ok: true; files: number; bytes: number; skipped: number }
export interface OverlayRestoreRequest { stateRoot: string; lower: string; upper: string; work: string; merged: string; sourceUpper: string }
export interface OverlayRestoreResult extends OverlayCopyResult { method: "kernel" | "fuse" }
export interface OverlayUnmountRequest { stateRoot: string; merged: string }
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
interface CoreConnection {
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
  configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string; sandboxReason?: string }>;
  /** 最近一次 configureSession 记录的会话执行级别（仅 CoreRouter 提供）；无记录返回 undefined。 */
  sandboxStatusFor?(sessionId: string): { capability: string; reason?: string; at: number } | undefined;
  cleanupSession(sessionId: string): Promise<{ ok: true }>;
  readFile(request: FsReadRequest): Promise<FsReadResult>;
  writeFile(request: FsWriteRequest): Promise<{ ok: true }>;
  writeFileBase64?(request: FsWriteBase64Request): Promise<{ ok: true }>;
  /** fs.readBase64（可选）：旧 core 二进制无 features.fsReadBase64 时缺省，图片预览等调用方应报不可用。 */
  readFileBase64?(request: FsPathRequest): Promise<FsReadBase64Result>;
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
  /** searchJob（可选实现）：并行 grep/glob job + features 缺失时的同步回退，返回形状同 globFiles/grepFiles。 */
  searchJob?(request: SearchJobRequest & { kind: "glob" }): Promise<FsGlobResult>;
  searchJob?(request: SearchJobRequest & { kind: "grep" }): Promise<FsGrepResult>;
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
  /** overlay.*（可选）：旧 core 二进制无 features.overlay 时缺省，快照后端应报不可用。 */
  overlayMount?(request: OverlayMountRequest): Promise<OverlayMountResult>;
  overlayCheckpoint?(request: OverlayCheckpointRequest): Promise<OverlayCopyResult>;
  overlayRestore?(request: OverlayRestoreRequest): Promise<OverlayRestoreResult>;
  overlayUnmount?(request: OverlayUnmountRequest): Promise<{ ok: true }>;
  setRequestTimeoutMs(timeoutMs: number): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 对齐 Node EventEmitter 的 on() 签名，any[] 才能让具体事件类型的 listener 可赋值
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
  /** 最近一次握手/ping 的能力记录（features 判定，如 grepJob/globJob 回退）；断连即失效。 */
  private info: CoreInfo | undefined;

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
    // stop() 进行中/已完成后不再武装（含自动重启）：与 stop 竞态时不得把 stopping 复位
    if (this.stopping) return Promise.reject(new Error("Core client is stopping"));
    if (this.startPromise) return this.startPromise;
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

  async ping(): Promise<CoreInfo> {
    const info = await this.call<CoreInfo>("core.ping", {});
    this.info = info;
    return info;
  }

  run(request: ExecRequest): Promise<ExecResult> {
    return this.call<ExecResult>("exec.run", request, (request.timeoutMs ?? 120_000) + 10_000);
  }

  configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string; sandboxReason?: string }> { return this.call("session.configure", request); }
  cleanupSession(sessionId: string): Promise<{ ok: true }> { return this.call("session.cleanup", { sessionId }); }
  readFile(request: FsReadRequest): Promise<FsReadResult> { return this.call("fs.read", request); }
  writeFile(request: FsWriteRequest): Promise<{ ok: true }> { return this.call("fs.write", request); }
  writeFileBase64(request: FsWriteBase64Request): Promise<{ ok: true }> { return this.call("fs.writeBase64", request); }
  readFileBase64(request: FsPathRequest): Promise<FsReadBase64Result> { return this.call("fs.readBase64", request); }
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

  searchJob(request: SearchJobRequest & { kind: "glob" }): Promise<FsGlobResult>;
  searchJob(request: SearchJobRequest & { kind: "grep" }): Promise<FsGrepResult>;
  async searchJob(request: SearchJobRequest & { kind: "grep" | "glob" }): Promise<FsGlobResult | FsGrepResult> {
    const { sessionId, path, pattern, kind } = request;
    // 能力回退：老 core（或尚未握手）无 grepJob/globJob 时走同步 fs.glob/fs.grep
    const supported = kind === "grep" ? this.info?.features?.grepJob === true : this.info?.features?.globJob === true;
    if (!supported) {
      return kind === "glob" ? this.globFiles({ sessionId, path, pattern }) : this.grepFiles({ sessionId, path, pattern });
    }
    const jobId = `search-${randomUUID()}`;
    if (kind === "grep") await this.startGrepJob({ sessionId, jobId, kind, cwd: request.cwd, path, pattern });
    else await this.startGlobJob({ sessionId, jobId, kind, cwd: request.cwd, path, pattern });
    const text = await this.collectSearchJobText(sessionId, jobId, kind, request.signal);
    let truncated = false;
    if (kind === "glob") {
      const paths: string[] = [];
      for (const record of parseSearchJobLines(text)) {
        if (record.summary) truncated = (record.summary as { truncated?: unknown }).truncated === true;
        else if (typeof record.path === "string") paths.push(record.path);
      }
      return { paths, truncated };
    }
    const matches: FsGrepResult["matches"] = [];
    for (const record of parseSearchJobLines(text)) {
      if (record.summary) truncated = (record.summary as { truncated?: unknown }).truncated === true;
      else if (typeof record.path === "string" && typeof record.line === "number") {
        matches.push({ path: record.path, line: record.line, text: typeof record.text === "string" ? record.text : "" });
      }
    }
    return { matches, truncated };
  }

  /**
   * 轮询 job 输出直到终态，返回 stdout 全量文本（JSONL）。分页 drain 对齐 index-manager
   * 的 collectJobJsonLines：每轮（含终态）循环读到 nextSeq 不再前进；ring 溢出
   * （truncated）与非 completed 终态显式抛错，不静默返回残缺结果。signal 中止时
   * 尽力 job.cancel 后抛错。
   */
  private async collectSearchJobText(sessionId: string, jobId: string, kind: string, signal?: AbortSignal): Promise<string> {
    let seq = 0;
    const stdout: Buffer[] = [];
    for (;;) {
      if (signal?.aborted) {
        await this.cancelJob({ sessionId, jobId }).catch(() => undefined);
        throw new Error(`${kind} job cancelled`);
      }
      const status = await this.jobStatus({ sessionId, jobId });
      let output = await this.jobOutput({ sessionId, jobId, afterSeq: seq, limit: 128 });
      for (;;) {
        if (output.truncated) throw new Error(`${kind} job output truncated by core ring buffer`);
        for (const chunk of output.chunks) {
          if (chunk.stream === "stdout") stdout.push(Buffer.from(chunk.data, "base64"));
        }
        if (output.nextSeq === seq || output.chunks.length === 0) break;
        seq = output.nextSeq;
        output = await this.jobOutput({ sessionId, jobId, afterSeq: seq, limit: 128 });
      }
      if (status.state !== "running") {
        if (status.state === "completed") return Buffer.concat(stdout).toString("utf8");
        throw new Error(`${kind} job ${status.state}${status.error ? `: ${status.error}` : ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, SEARCH_JOB_POLL_MS));
    }
  }
  normalizePath(request: PathNormalizeRequest): Promise<PathNormalizeResult> { return this.call("path.normalize", request); }
  openPty(request: PtyOpenRequest): Promise<PtyOpenResult> { return this.call("pty.open", request); }
  inputPty(request: PtyInputRequest): Promise<{ ok: true }> { return this.call("pty.input", request); }
  resizePty(request: PtyResizeRequest): Promise<{ ok: true }> { return this.call("pty.resize", request); }
  closePty(request: { ptyId: number }): Promise<{ ok: true; exitCode?: number }> { return this.call("pty.close", request); }
  overlayMount(request: OverlayMountRequest): Promise<OverlayMountResult> { return this.call("overlay.mount", request); }
  overlayCheckpoint(request: OverlayCheckpointRequest): Promise<OverlayCopyResult> { return this.call("overlay.checkpoint", request); }
  overlayRestore(request: OverlayRestoreRequest): Promise<OverlayRestoreResult> { return this.call("overlay.restore", request); }
  overlayUnmount(request: OverlayUnmountRequest): Promise<{ ok: true }> { return this.call("overlay.unmount", request); }

  /** per-pty 事件通道：pty.open 响应到达前 core 可能已经推 output（shell banner），
   * 无订阅者的通知先缓冲（上限 256 条），首个 listener 挂载后回放。 */
  ptyEvents(ptyId: number): EventEmitter {
    let emitter = this.ptyEmitters.get(ptyId);
    if (!emitter) {
      emitter = new EventEmitter();
      const buffered = this.pendingPtyEvents.get(ptyId) ?? [];
      this.pendingPtyEvents.delete(ptyId);
      if (buffered.length > 0) {
        const target = emitter;
        target.once("newListener", () => {
          // newListener 触发时回调尚未注册完成：延迟到微任务回放，
          // 保证首个 on("output") 能收到缓冲的早期输出
          queueMicrotask(() => {
            for (const event of buffered) target.emit(event.type, event.params);
          });
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
    const env = sanitizedCoreEnv();
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(env ? { env } : {}) });
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
    this.info = undefined;
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

/** searchJob 的 job.status 轮询间隔（对齐 index-manager 默认 pollMs）。 */
const SEARCH_JOB_POLL_MS = 100;

/** 解析 search job 的 stdout JSONL（去空白行）；末行 summary 也作为记录返回，由调用方分拣。 */
function parseSearchJobLines(text: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) records.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return records;
}

function isRpcError(value: unknown): value is RpcErrorBody {
  return Boolean(value) && typeof value === "object" &&
    typeof (value as RpcErrorBody).code === "number" &&
    typeof (value as RpcErrorBody).message === "string";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
