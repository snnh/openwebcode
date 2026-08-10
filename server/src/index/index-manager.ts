/**
 * 索引管理器（0.4.0 Phase 2 §4.1）：workspace 级符号索引的编排。
 *
 * 流程：core `index.scan` job 产出完整 manifest（JSONL 流）→ Node 对连续
 * manifest 做 diff（新增/修改/删除，sha256 优先）→ 变化文件交给 core
 * `index.extract` job 提取符号 → append 批次写 files.jsonl/symbols.jsonl（定期压实）。
 *
 * 语义约束：
 * - 索引只是加速缓存，文件系统永远是真相；损坏整体作废、显式重建。
 * - 一切文件访问走 core（不直接 fs 读工作区），不绕过权限/沙盒/路径策略。
 * - 重建是显式动作（REST/工具错误提示引导），code_search 失败不自动触发。
 * - 新鲜度：watch 可用时 watch 驱动（事件 → 标滞后 + 去抖增量刷新）；
 *   watch 不可用时降级为 turn 边界 mtime 抽样 + 手动刷新。
 */

import { randomUUID } from "node:crypto";
import type { CoreClientLike, IndexExtractEntry, IndexExtractSummary, IndexExtractSymbol, IndexScanEntry, IndexScanSummary } from "../core-client.js";
import type { EventBus } from "../events/event-bus.js";
import { diffManifest } from "./manifest.js";
import {
  IndexCorruptError,
  IndexStore,
  isSymbolKind,
  languageForPath,
  MAX_EXTRACT_FILE_BYTES,
  toIndexedFileEntry,
  toIndexedSymbolRecord,
  workspaceHash,
  type IndexMeta,
  type LoadedIndex,
  type SymbolRecord,
} from "./index-store.js";

export type IndexStatus = "missing" | "building" | "fresh" | "stale";

export interface IndexStatusInfo {
  status: IndexStatus;
  /** workspace-hash（索引目录名）。 */
  workspace: string;
  files: number;
  symbols: number;
  lastScanAt?: number;
  scanTruncated?: boolean;
  staleReason?: "watch" | "mtime" | "corrupt" | "cancelled" | "error";
  /** watch 驱动模式：active=core watch；fallback=turn 边界 mtime 抽样。 */
  watch: "active" | "fallback" | "none";
  jobId?: string;
  message?: string;
}

export interface SymbolSearchHit {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
}

/** 文件清单搜索命中（@ 补全/Quick Open 共用）。 */
export interface FileSearchHit {
  path: string;
  modifiedMs: number;
}

/** repo map 消费的关键文件符号摘要（按最近修改排序由调用方做）。 */
export interface RepoMapSymbolFile {
  path: string;
  modifiedMs: number;
  symbols: Array<{ name: string; kind: string }>;
}

export class IndexUnavailableError extends Error {
  readonly code = "INDEX_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "IndexUnavailableError";
  }
}

export class IndexBuildingError extends Error {
  readonly code = "INDEX_BUILDING";
  constructor() {
    super("Index rebuild is already running for this workspace");
    this.name = "IndexBuildingError";
  }
}

/** 扫描预算默认值：与 core maxIndexScan* 上限对齐，宁可截断也不做无界扫描。 */
export interface IndexScanBudget {
  maxDepth: number;
  maxNodes: number;
  maxBytes: number;
  maxMs: number;
  /** 单次扫描最多做符号提取的文件数（超出部分留到下次）。 */
  maxExtractFiles: number;
}

const DEFAULT_BUDGET: IndexScanBudget = {
  maxDepth: 32,
  maxNodes: 200_000,
  maxBytes: 512 * 1024 * 1024,
  maxMs: 120_000,
  maxExtractFiles: 5_000,
};

/** 索引扫描的默认排除：与 repo map 默认忽略约定同族。 */
const DEFAULT_EXCLUDES = [
  ".git", ".owc", ".openwebcode", "node_modules",
  "dist", "build", "build-*", "out", "coverage", "target",
  ".next", ".cache", "__pycache__", ".venv", "_CPack_Packages",
];

const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;

interface WorkspaceState {
  cwd: string;
  store: IndexStore;
  loaded?: LoadedIndex | undefined;
  loading?: Promise<void> | undefined;
  corrupt: boolean;
  stale: boolean;
  staleReason?: IndexStatusInfo["staleReason"];
  building?: { jobId: string; abort: AbortController } | undefined;
  watchMode: "active" | "fallback" | "none";
  watchId?: number | undefined;
  watchTimer?: NodeJS.Timeout | undefined;
  refreshTimer?: NodeJS.Timeout | undefined;
  batch: number;
}

export interface IndexManagerOptions {
  budget?: Partial<IndexScanBudget>;
  /** job 输出轮询间隔（测试可调 0）。 */
  pollMs?: number;
  /** watch 轮询间隔。 */
  watchPollMs?: number;
  /** watch 事件后触发增量刷新的去抖。 */
  refreshDebounceMs?: number;
  /** turn 边界 mtime 抽样的文件数。 */
  mtimeSampleSize?: number;
  /** watch 事件是否自动触发增量刷新（false 则只标滞后）。 */
  autoRefresh?: boolean;
  /** 测试注入的时钟。 */
  now?: () => number;
}

export class IndexManager {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly budget: IndexScanBudget;
  private readonly pollMs: number;
  private readonly watchPollMs: number;
  private readonly refreshDebounceMs: number;
  private readonly mtimeSampleSize: number;
  private readonly autoRefresh: boolean;
  private readonly now: () => number;

  constructor(
    private readonly core: CoreClientLike,
    /** 服务端数据目录下的 index 根（<dataDir>/index）。 */
    private readonly indexRoot: string,
    private readonly events: EventBus,
    options: IndexManagerOptions = {},
  ) {
    this.budget = { ...DEFAULT_BUDGET, ...options.budget };
    this.pollMs = options.pollMs ?? 100;
    this.watchPollMs = options.watchPollMs ?? 2_000;
    this.refreshDebounceMs = options.refreshDebounceMs ?? 3_000;
    this.mtimeSampleSize = options.mtimeSampleSize ?? 32;
    this.autoRefresh = options.autoRefresh ?? true;
    this.now = options.now ?? Date.now;
  }

  /** 测试与优雅停机用：清掉全部定时器。 */
  stop(): void {
    for (const ws of this.workspaces.values()) {
      if (ws.watchTimer) clearInterval(ws.watchTimer);
      if (ws.refreshTimer) clearTimeout(ws.refreshTimer);
      ws.watchTimer = undefined;
      ws.refreshTimer = undefined;
    }
  }

  private ws(cwd: string): WorkspaceState {
    const key = workspaceHash(cwd);
    let state = this.workspaces.get(key);
    if (!state) {
      state = {
        cwd,
        store: new IndexStore(this.indexRoot, cwd),
        corrupt: false,
        stale: false,
        watchMode: "none",
        batch: 0,
      };
      this.workspaces.set(key, state);
    }
    return state;
  }

  async status(sessionId: string, cwd: string): Promise<IndexStatusInfo> {
    const ws = this.ws(cwd);
    await this.ensureLoaded(ws);
    const info = this.statusOf(ws);
    // 已建索引且尚未决定驱动方式时，尝试建立 watch（失败转 fallback）
    if (info.status !== "missing" && info.status !== "building" && ws.watchMode === "none") {
      await this.ensureWatch(ws, sessionId);
    }
    return this.statusOf(ws);
  }

  private statusOf(ws: WorkspaceState): IndexStatusInfo {
    const meta = ws.loaded?.meta;
    const base: IndexStatusInfo = {
      status: "missing",
      workspace: workspaceHash(ws.cwd),
      files: ws.loaded?.files.size ?? 0,
      symbols: ws.loaded ? [...ws.loaded.symbols.values()].reduce((sum, list) => sum + list.length, 0) : 0,
      watch: ws.watchMode,
      ...(meta?.lastScan ? { lastScanAt: meta.lastScan.at, scanTruncated: meta.lastScan.truncated } : {}),
    };
    if (ws.building) return { ...base, status: "building", jobId: ws.building.jobId };
    if (!ws.loaded?.meta) return { ...base, status: "missing", ...(ws.staleReason ? { staleReason: ws.staleReason } : {}) };
    if (ws.stale) return { ...base, status: "stale", ...(ws.staleReason ? { staleReason: ws.staleReason } : {}) };
    return { ...base, status: "fresh" };
  }

  private publish(sessionId: string, ws: WorkspaceState, message?: string): void {
    const info = { ...this.statusOf(ws), ...(message ? { message } : {}) };
    this.events.publish({ source: "server", type: "index.status", sessionId, payload: info });
  }

  /** 加载索引进内存；损坏则整体作废（缓存可丢，下次显式重建）。并发调用共用同一次加载。 */
  private async ensureLoaded(ws: WorkspaceState): Promise<void> {
    if (ws.loaded) return;
    ws.loading ??= this.doLoad(ws).finally(() => {
      ws.loading = undefined;
    });
    return ws.loading;
  }

  private async doLoad(ws: WorkspaceState): Promise<void> {
    if (ws.loaded) return;
    try {
      ws.loaded = await ws.store.load();
      ws.corrupt = false;
    } catch (error) {
      if (error instanceof IndexCorruptError) {
        // meta.json 与 jsonl 都不存在 = 从未建过索引（正常态），不是损坏
        const hasMeta = await ws.store.exists();
        const hasData = await ws.store.hasDataFiles();
        if (!hasMeta && !hasData) {
          // 从未建过索引（正常空态）。corrupt 标志保持粘性：reset 之后
          // 查询仍如实报告"损坏已作废"，直到一次成功重建翻转它。
          ws.loaded = { files: new Map(), symbols: new Map(), meta: undefined, fileLines: 0, symbolLines: 0 };
          return;
        }
        ws.loaded = undefined;
        ws.corrupt = true;
        ws.staleReason = "corrupt";
        await ws.store.reset().catch(() => undefined);
        return;
      }
      throw error;
    }
  }

  /** 显式重建（也是增量刷新入口：core 始终给完整 manifest，diff 决定提取量）。 */
  async rebuild(sessionId: string, cwd: string): Promise<{ jobId: string }> {
    const ws = this.ws(cwd);
    if (ws.building) throw new IndexBuildingError();
    const jobId = `index-${randomUUID()}`;
    ws.building = { jobId, abort: new AbortController() };
    this.publish(sessionId, ws);
    const building = ws.building;
    void this.runScan(ws, sessionId, jobId, building.abort.signal)
      .catch(() => undefined) // runScan 内部已归置状态与事件
      .finally(() => {
        if (ws.building?.jobId === jobId) ws.building = undefined;
      });
    return { jobId };
  }

  async cancel(sessionId: string, cwd: string): Promise<boolean> {
    const ws = this.ws(cwd);
    if (!ws.building) return false;
    ws.building.abort.abort();
    await this.core.cancelJob({ sessionId, jobId: ws.building.jobId }).catch(() => undefined);
    return true;
  }

  private async runScan(ws: WorkspaceState, sessionId: string, jobId: string, signal: AbortSignal): Promise<void> {
    const startedAt = this.now();
    try {
      await this.core.startIndexScan({
        sessionId,
        jobId,
        kind: "index.scan",
        cwd: ws.cwd,
        path: ".",
        exclude: [...DEFAULT_EXCLUDES],
        maxDepth: this.budget.maxDepth,
        maxNodes: this.budget.maxNodes,
        maxBytes: this.budget.maxBytes,
        maxMs: this.budget.maxMs,
      });
      const { entries, summary } = await this.collectManifest(sessionId, jobId, signal);
      await this.applyManifest(ws, sessionId, jobId, entries, summary, this.now() - startedAt, signal);
      ws.stale = false;
      ws.staleReason = undefined;
      ws.corrupt = false; // 成功重建后翻转损坏标记
      // 先清 building 再发布，保证事件里的状态是终态而非 building
      if (ws.building?.jobId === jobId) ws.building = undefined;
      this.publish(sessionId, ws);
      if (ws.watchMode === "none") await this.ensureWatch(ws, sessionId);
    } catch (error) {
      if (ws.building?.jobId === jobId) ws.building = undefined;
      if (signal.aborted) {
        // 取消：保留旧索引，如实标滞后
        ws.stale = true;
        ws.staleReason = "cancelled";
        this.publish(sessionId, ws, "Index rebuild cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ws.stale = true;
      ws.staleReason = "error";
      this.publish(sessionId, ws, `Index rebuild failed: ${message}`);
    }
  }

  /**
   * 轮询 job 输出直到终态；stdout 的 JSONL 行按块增量切出（去空白行）经 onLine 即抛，
   * 不攒全量 Buffer/完整字符串/行数组（大 manifest 下三者同驻是峰值内存来源）。
   * 非 completed 或 core 输出环溢出（truncated）抛错；summary 取自末条非空行。
   */
  private async collectJobJsonLines(
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
    jobKind: string,
    onLine: (line: string) => void,
  ): Promise<{ summary: Record<string, unknown> | undefined }> {
    let seq = 0;
    // job.output 的 chunk.data 是 base64（docs/protocol.md §job.output）：按块解码挂到行尾
    // 缓冲上，切出完整行才 UTF-8 解码——换行符是单字节，多字节字符不会跨行被截成 U+FFFD。
    let tail = Buffer.alloc(0);
    let lastLine: string | undefined;
    const emitChunk = (incoming: Buffer): void => {
      const data = tail.length ? Buffer.concat([tail, incoming]) : incoming;
      let lineStart = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        const line = data.subarray(lineStart, index).toString("utf8").trim();
        if (line) {
          lastLine = line;
          onLine(line);
        }
        lineStart = index + 1;
      }
      // 拷贝残余半行，避免 subarray 长期挂住整块 data
      tail = Buffer.from(data.subarray(lineStart));
    };
    for (;;) {
      if (signal.aborted) throw new Error("cancelled");
      const status = await this.core.jobStatus({ sessionId, jobId });
      // 每轮（含终态）循环读取直到 nextSeq 不再前进：单次 limit:128（core 上限）可能读不完残留输出
      let output = await this.core.jobOutput({ sessionId, jobId, afterSeq: seq, limit: 128 });
      for (;;) {
        // core 输出 ring 溢出意味着中间有行丢失：静默损坏不如显式失败（runScan 走 error/stale，可整体重建）
        if (output.truncated) throw new Error(`${jobKind} job output truncated by core ring buffer`);
        for (const chunk of output.chunks) {
          if (chunk.stream === "stdout") emitChunk(Buffer.from(chunk.data, "base64"));
        }
        if (output.nextSeq === seq || output.chunks.length === 0) break;
        seq = output.nextSeq;
        output = await this.core.jobOutput({ sessionId, jobId, afterSeq: seq, limit: 128 });
      }
      if (status.state !== "running") {
        if (status.state !== "completed") {
          throw new Error(`${jobKind} job ${status.state}${status.error ? `: ${status.error}` : ""}`);
        }
        // 终态冲刷残余半行（无终止换行的末行）
        if (tail.length) {
          const line = tail.toString("utf8").trim();
          if (line) {
            lastLine = line;
            onLine(line);
          }
        }
        return { summary: lastLine ? trailingJobSummary(lastLine) : undefined };
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** 解析 index.scan 的 JSONL 流为 manifest + summary。 */
  private async collectManifest(
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<{ entries: IndexScanEntry[]; summary: IndexScanSummary | undefined }> {
    const entries: IndexScanEntry[] = [];
    let summary: IndexScanSummary | undefined;
    await this.collectJobJsonLines(sessionId, jobId, signal, "index.scan", (line) => {
      const record = JSON.parse(line) as IndexScanEntry & { summary?: IndexScanSummary };
      if (record.summary) summary = record.summary;
      else if (typeof record.path === "string") {
        entries.push({ path: record.path, size: record.size, modifiedMs: record.modifiedMs, ...(record.sha256 ? { sha256: record.sha256 } : {}) });
      }
    });
    return { entries, summary };
  }

  /** diff → 变化文件经 core index.extract job 提取符号 → append 批次 → 必要时压实 → 写 meta。 */
  private async applyManifest(
    ws: WorkspaceState,
    sessionId: string,
    jobId: string,
    entries: IndexScanEntry[],
    summary: IndexScanSummary | undefined,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.ensureLoaded(ws);
    const loaded: LoadedIndex = ws.loaded ?? { files: new Map(), symbols: new Map(), meta: undefined, fileLines: 0, symbolLines: 0 };
    ws.loaded = loaded;
    const diff = diffManifest(loaded.files, entries);

    const extractable = [...diff.added, ...diff.changed]
      .filter((entry) => languageForPath(entry.path) !== undefined && entry.size <= MAX_EXTRACT_FILE_BYTES)
      .slice(0, this.budget.maxExtractFiles);
    const extracted = new Map<string, SymbolRecord[]>();
    if (extractable.length > 0) {
      const extractJobId = `${jobId}-x`;
      await this.core.startIndexExtract({
        sessionId,
        jobId: extractJobId,
        kind: "index.extract",
        cwd: ws.cwd,
        path: ".",
        files: extractable.map((entry) => entry.path),
      });
      const { summary: extractSummary } = await this.collectJobJsonLines(sessionId, extractJobId, signal, "index.extract", (line) => {
        const record = JSON.parse(line) as Partial<IndexExtractEntry> & { summary?: IndexExtractSummary };
        if (record.summary || typeof record.path !== "string" || !Array.isArray(record.symbols)) return;
        extracted.set(record.path, record.symbols.map(toSymbolRecord));
      });
      // core 整条跳过的文件（读失败/非 UTF-8/策略拒绝）按 0 符号处理：清掉旧符号但不丢文件清单。
      // 截断（truncated）时未收到输出行更可能是"没来得及处理"而非"跳过"：保留上一轮旧符号，不静默清空。
      const extractTruncated = extractSummary?.truncated === true;
      let preserved = 0;
      for (const entry of extractable) {
        if (extracted.has(entry.path)) continue;
        if (extractTruncated) preserved += 1;
        else extracted.set(entry.path, []);
      }
      if (preserved > 0) {
        process.stderr.write(`[index] index.extract 截断（reason=${String(extractSummary?.reason ?? "unknown")}）：${preserved} 个文件未收到输出，保留旧符号\n`);
      }
    }

    // 应用 manifest 全量态（内存条目预存小写路径/基名供搜索，不落盘）
    const nextFiles = new Map(entries.map((entry) => [entry.path, toIndexedFileEntry(entry)]));
    for (const filePath of diff.deleted) loaded.symbols.delete(filePath);
    for (const [filePath, symbols] of extracted) {
      if (symbols.length > 0) loaded.symbols.set(filePath, symbols.map(toIndexedSymbolRecord));
      else loaded.symbols.delete(filePath);
    }
    loaded.files = nextFiles;

    ws.batch += 1;
    const appended = await ws.store.appendBatch(
      ws.batch,
      { upsert: [...diff.added, ...diff.changed], deleted: diff.deleted },
      {
        upsert: [...extracted.entries()].map(([filePath, symbols]) => ({ path: filePath, symbols })),
        deleted: diff.deleted,
      },
    );
    loaded.fileLines += appended.fileLines;
    loaded.symbolLines += appended.symbolLines;
    if (ws.store.shouldCompact(loaded.fileLines, loaded.files.size) || ws.store.shouldCompact(loaded.symbolLines, loaded.symbols.size)) {
      await ws.store.compact(loaded.files, loaded.symbols);
      loaded.fileLines = loaded.files.size + 1;
      loaded.symbolLines = loaded.symbols.size + 1;
    }

    const now = this.now();
    const meta: IndexMeta = {
      version: 1,
      cwd: ws.cwd,
      createdAt: loaded.meta?.createdAt ?? now,
      updatedAt: now,
      lastScan: {
        at: now,
        entries: summary?.entries ?? entries.length,
        truncated: summary?.truncated ?? false,
        reason: summary?.reason ?? null,
        hashTruncated: summary?.hashTruncated ?? false,
        durationMs,
      },
      files: loaded.files.size,
      symbols: [...loaded.symbols.values()].reduce((sum, list) => sum + list.length, 0),
    };
    await ws.store.writeMeta(meta);
    loaded.meta = meta;
  }

  // ---- 新鲜度：watch 驱动 / mtime 抽样降级 ----

  private async ensureWatch(ws: WorkspaceState, sessionId: string): Promise<void> {
    if (ws.watchMode !== "none") return;
    try {
      const { watchId } = await this.core.watchFiles({ sessionId, path: ws.cwd, recursive: true });
      ws.watchId = watchId;
      ws.watchMode = "active";
      ws.watchTimer = setInterval(() => void this.pollWatch(ws, sessionId), this.watchPollMs);
      ws.watchTimer.unref();
      this.publish(sessionId, ws);
    } catch {
      // watch 不可用：降级为 turn 边界 mtime 抽样（noteTurnBoundary）
      ws.watchMode = "fallback";
      this.publish(sessionId, ws);
    }
  }

  private async pollWatch(ws: WorkspaceState, sessionId: string): Promise<void> {
    if (ws.watchId === undefined) return;
    try {
      const result = await this.core.pollWatch({ sessionId, watchId: ws.watchId, limit: 500 });
      if (result.events.length === 0 && !result.overflow) return;
      this.markStale(ws, "watch", sessionId);
    } catch {
      // watch 中途失败（core 重启等）：转降级模式
      if (ws.watchTimer) clearInterval(ws.watchTimer);
      ws.watchTimer = undefined;
      ws.watchId = undefined;
      ws.watchMode = "fallback";
      this.publish(sessionId, ws);
    }
  }

  private markStale(ws: WorkspaceState, reason: IndexStatusInfo["staleReason"], sessionId: string): void {
    ws.stale = true;
    ws.staleReason = reason;
    this.publish(sessionId, ws);
    if (!this.autoRefresh || ws.building || !ws.loaded?.meta) return;
    if (ws.refreshTimer) clearTimeout(ws.refreshTimer);
    ws.refreshTimer = setTimeout(() => {
      ws.refreshTimer = undefined;
      void this.rebuild(sessionId, ws.cwd).catch(() => undefined);
    }, this.refreshDebounceMs);
    ws.refreshTimer.unref();
  }

  /**
   * turn 边界新鲜度检查（agent 每轮开头调用）：
   * watch 激活时零成本跳过；fallback 模式对索引文件做 mtime 抽样，
   * 样本有变化即标滞后（不自动重建，重建是显式动作）。
   */
  async noteTurnBoundary(sessionId: string, cwd: string): Promise<void> {
    const ws = this.ws(cwd);
    if (ws.building) return;
    await this.ensureLoaded(ws);
    if (!ws.loaded?.meta || ws.stale) return;
    if (ws.watchMode === "none") await this.ensureWatch(ws, sessionId);
    if (ws.watchMode !== "fallback") return;
    const paths = [...ws.loaded.files.keys()];
    if (paths.length === 0) return;
    const step = Math.max(1, Math.floor(paths.length / this.mtimeSampleSize));
    const sample = paths.filter((_, index) => index % step === 0).slice(0, this.mtimeSampleSize);
    try {
      const result = await this.core.statFiles({ sessionId, paths: sample });
      const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));
      for (const filePath of sample) {
        const current = byPath.get(filePath);
        const indexed = ws.loaded.files.get(filePath);
        if (!current || !indexed || current.size !== indexed.size || current.modifiedMs !== indexed.modifiedMs) {
          this.markStale(ws, "mtime", sessionId);
          return;
        }
      }
    } catch {
      // 抽样失败（文件被删等）一律按滞后处理
      this.markStale(ws, "mtime", sessionId);
    }
  }

  // ---- 查询 ----

  private async requireIndex(cwd: string): Promise<LoadedIndex> {
    const ws = this.ws(cwd);
    await this.ensureLoaded(ws);
    if (!ws.loaded?.meta) {
      throw new IndexUnavailableError(
        ws.corrupt
          ? "Symbol index is corrupt and has been discarded; rebuild it explicitly (POST /api/workspaces/index/rebuild)."
          : "Symbol index has not been built for this workspace; rebuild it explicitly (POST /api/workspaces/index/rebuild).",
      );
    }
    return ws.loaded;
  }

  /** code_search 供数：符号名模糊匹配 + kind 过滤 + limit（固定容量 top-K，不全量收集再排序）。 */
  async searchSymbols(cwd: string, query: string, options: { kind?: string; limit?: number } = {}): Promise<SymbolSearchHit[]> {
    const loaded = await this.requireIndex(cwd);
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(options.limit ?? SEARCH_LIMIT_DEFAULT)));
    const queryLower = query.toLowerCase();
    const compare = (a: SymbolCandidate, b: SymbolCandidate): number => b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    const hits: SymbolCandidate[] = [];
    for (const [filePath, symbols] of loaded.symbols) {
      for (const symbol of symbols) {
        if (options.kind && symbol.kind !== options.kind) continue;
        const score = fuzzyScoreLower(symbol.nameLower, queryLower);
        if (score <= 0) continue;
        pushTopK(hits, limit, { score, name: symbol.name, kind: symbol.kind, path: filePath, startLine: symbol.startLine, endLine: symbol.endLine, signature: symbol.signature }, compare);
      }
    }
    return hits.map(({ score: _score, ...hit }) => hit);
  }

  /** 编辑器面包屑供数（0.5.0 Phase 1a）：按文件精确取符号（路径分隔符与前导 ./ 归一后比较），按行号排序。 */
  async symbolsInFile(cwd: string, filePath: string): Promise<SymbolSearchHit[]> {
    const loaded = await this.requireIndex(cwd);
    const wanted = normalizeLookupPath(filePath);
    for (const [path, symbols] of loaded.symbols) {
      if (normalizeLookupPath(path) !== wanted) continue;
      return [...symbols]
        .sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
        .map((symbol) => ({ name: symbol.name, kind: symbol.kind, path, startLine: symbol.startLine, endLine: symbol.endLine, signature: symbol.signature }));
    }
    return [];
  }

  /** @ 文件补全供数：索引文件清单按路径模糊匹配（固定容量 top-K，评分与 searchSymbols 同族）。 */
  async searchFiles(cwd: string, query: string, options: { limit?: number } = {}): Promise<FileSearchHit[]> {
    const loaded = await this.requireIndex(cwd);
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(options.limit ?? SEARCH_LIMIT_DEFAULT)));
    const queryLower = query.toLowerCase();
    const compare = (a: FileCandidate, b: FileCandidate): number => b.score - a.score || a.path.localeCompare(b.path);
    const hits: FileCandidate[] = [];
    for (const [filePath, entry] of loaded.files) {
      // 全路径与基名各评一次取高分：用户常只记文件名
      const score = Math.max(fuzzyScoreLower(entry.pathLower, queryLower), fuzzyScoreLower(entry.baseLower, queryLower));
      if (score <= 0) continue;
      pushTopK(hits, limit, { score, path: filePath, modifiedMs: entry.modifiedMs }, compare);
    }
    return hits.map(({ score: _score, ...hit }) => hit);
  }

  /** repo map 供数：索引可用时返回带符号的文件清单；不可用返回 undefined（调用方降级静态树）。 */
  async symbolSummary(cwd: string): Promise<RepoMapSymbolFile[] | undefined> {
    const ws = this.ws(cwd);
    try {
      await this.ensureLoaded(ws);
    } catch {
      return undefined;
    }
    if (!ws.loaded?.meta) return undefined;
    const result: RepoMapSymbolFile[] = [];
    for (const [filePath, symbols] of ws.loaded.symbols) {
      if (symbols.length === 0) continue;
      const file = ws.loaded.files.get(filePath);
      result.push({
        path: filePath,
        modifiedMs: file?.modifiedMs ?? 0,
        symbols: symbols.map((symbol) => ({ name: symbol.name, kind: symbol.kind })),
      });
    }
    result.sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path));
    return result;
  }
}

/** JSONL 末行若是 {"summary":{...}} 则取出（index.scan/index.extract 约定的终止行）；解析失败按无 summary。 */
function trailingJobSummary(line: string): Record<string, unknown> | undefined {
  try {
    const record = JSON.parse(line) as { summary?: unknown };
    return record.summary && typeof record.summary === "object" ? record.summary as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** core index.extract 符号 → 存储记录；不认识的 kind 兜底 "variable"（丢精度不丢符号）。 */
function toSymbolRecord(symbol: IndexExtractSymbol): SymbolRecord {
  return {
    name: symbol.name,
    kind: isSymbolKind(symbol.kind) ? symbol.kind : "variable",
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    signature: symbol.signature,
  };
}

/** top-K 候选项：分数 + 命中字段平铺，选中才分配（拒绝的候选零分配）。 */
interface SymbolCandidate extends SymbolSearchHit {
  score: number;
}

interface FileCandidate extends FileSearchHit {
  score: number;
}

/**
 * 固定容量 top-K 有序插入：候选劣于当前第 K 名直接拒绝（无分配），
 * 否则二分插入保持最优在前；与旧"全量收集 + 稳定排序 + slice" 结果一致
 * （comparator 相等时迭代顺序靠前者优先）。
 */
function pushTopK<T>(hits: T[], limit: number, candidate: T, compare: (a: T, b: T) => number): void {
  if (hits.length === limit && compare(candidate, hits[limit - 1]!) >= 0) return;
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(candidate, hits[mid]!) < 0) hi = mid;
    else lo = mid + 1;
  }
  hits.splice(lo, 0, candidate);
  if (hits.length > limit) hits.length = limit;
}

/** 按文件查符号的路径归一：统一分隔符、去前导 ./（索引键与编辑器相对路径对齐）。 */
function normalizeLookupPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 模糊匹配评分：完全相等(忽略大小写)=100，前缀=75，子串=50，子序列=25，不匹配=0。
 * 简单可解释，够 code_search 排序用。
 */
export function fuzzyScore(name: string, query: string): number {
  return fuzzyScoreLower(name.toLowerCase(), query.toLowerCase());
}

/** 小写已预算的评分内环：搜索热路径不重复 toLowerCase 分配（小写串预存在索引条目上）。 */
function fuzzyScoreLower(n: string, q: string): number {
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 75;
  if (n.includes(q)) return 50;
  let i = 0;
  for (const ch of n) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return 25;
  }
  return 0;
}
