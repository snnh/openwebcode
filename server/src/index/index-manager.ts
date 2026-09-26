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
  type IndexedFileEntry,
  type IndexMeta,
  type LoadedIndex,
  type SymbolRecord,
} from "./index-store.js";
import { collectJobJsonLines } from "../rpc/job-collect.js";

type IndexStatus = "missing" | "building" | "fresh" | "stale";

interface IndexStatusInfo {
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

interface SymbolSearchHit {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
}

/** 文件清单搜索命中（@ 补全/Quick Open 共用）。 */
interface FileSearchHit {
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
interface IndexScanBudget {
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
/** watch 定向刷新的脏路径上限：超出即降级全量重建（批量检出/构建产物风暴防护）。 */
const MAX_WATCH_DIRTY_PATHS = 2_000;

/** watch 脏路径的排除判定：与 core index.scan 的 DEFAULT_EXCLUDES 同族（任一路径段命中即排除；支持尾部 * 通配）。 */
function isExcludedPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) =>
    DEFAULT_EXCLUDES.some((pattern) =>
      pattern.endsWith("*") ? segment.startsWith(pattern.slice(0, -1)) : segment === pattern));
}

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
  /** 开出该监听的会话 id（core 的 fs.watch.cancel 要求归属会话一致） */
  watchSessionId?: string | undefined;
  watchTimer?: NodeJS.Timeout | undefined;
  refreshTimer?: NodeJS.Timeout | undefined;
  /** watch 事件累积的脏相对路径（undefined = 未累积）；超限/溢出时转 watchOverflow 走全量重建。 */
  watchDirty?: Set<string> | undefined;
  /** watch 事件溢出或脏集超限：下次刷新必须全量扫描（定向刷新不再可信）。 */
  watchOverflow?: boolean;
  batch: number;
  /** 最近一次被访问的时间（epoch ms）：空闲淘汰依据 */
  lastUsed: number;
}

interface IndexManagerOptions {
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

  /**
   * 释放某个工作区的常驻内存（索引表 + 文件监听）：
   * 索引文件留在磁盘（IndexStore），下次访问按磁盘重建，不丢索引内容。
   * 用于归档/删除会话，以及空闲与容量淘汰。
   */
  async release(cwd: string): Promise<boolean> {
    const key = workspaceHash(cwd);
    const ws = this.workspaces.get(key);
    if (!ws) return false;
    this.dropWorkspace(ws);
    this.workspaces.delete(key);
    return true;
  }

  /** 空闲淘汰：超过 idleMs 未被访问的工作区整体释放；返回释放数量。 */
  async releaseIdle(idleMs: number): Promise<number> {
    const cutoff = this.now() - idleMs;
    let released = 0;
    for (const [key, ws] of [...this.workspaces]) {
      if (ws.lastUsed > cutoff) continue;
      this.dropWorkspace(ws);
      this.workspaces.delete(key);
      released += 1;
    }
    return released;
  }

  /** 容量淘汰：最多保留 max 个工作区，超出按最近访问时间释放最旧的；返回释放数量。 */
  async enforceLimit(max: number): Promise<number> {
    if (this.workspaces.size <= max) return 0;
    const victims = [...this.workspaces.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let released = 0;
    for (const [key, ws] of victims) {
      if (this.workspaces.size <= max) break;
      this.dropWorkspace(ws);
      this.workspaces.delete(key);
      released += 1;
    }
    return released;
  }

  /** 释放一个工作区的定时器、监听与进行中的构建（纯内存操作，不动磁盘） */
  private dropWorkspace(ws: WorkspaceState): void {
    if (ws.watchTimer) clearInterval(ws.watchTimer);
    if (ws.refreshTimer) clearTimeout(ws.refreshTimer);
    ws.watchTimer = undefined;
    ws.refreshTimer = undefined;
    ws.building?.abort.abort();
    ws.building = undefined;
    if (ws.watchId !== undefined && ws.watchSessionId !== undefined) {
      const watchId = ws.watchId;
      const sessionId = ws.watchSessionId;
      ws.watchId = undefined;
      ws.watchSessionId = undefined;
      // core 侧监听随释放取消；会话已删除时 core 已在会话清理里移除监听，失败不影响释放
      void this.core.cancelWatch({ sessionId, watchId }).catch(() => undefined);
    }
    ws.watchId = undefined;
    ws.watchSessionId = undefined;
    ws.watchMode = "none";
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
        lastUsed: this.now(),
      };
      this.workspaces.set(key, state);
    }
    state.lastUsed = this.now();
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
      symbols: ws.loaded?.symbolCount ?? 0,
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
          ws.loaded = { files: new Map(), symbols: new Map(), meta: undefined, fileLines: 0, symbolLines: 0, symbolCount: 0 };
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

  /** 解析 index.scan 的 JSONL 流为 manifest + summary。 */
  private async collectManifest(
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<{ entries: IndexScanEntry[]; summary: IndexScanSummary | undefined }> {
    const entries: IndexScanEntry[] = [];
    let summary: IndexScanSummary | undefined;
    await collectJobJsonLines(this.core, sessionId, jobId, signal, "index.scan", (line) => {
      const record = JSON.parse(line) as IndexScanEntry & { summary?: IndexScanSummary };
      if (record.summary) summary = record.summary;
      else if (typeof record.path === "string") {
        entries.push({ path: record.path, size: record.size, modifiedMs: record.modifiedMs, ...(record.sha256 ? { sha256: record.sha256 } : {}) });
      }
    }, this.pollMs);
    return { entries, summary };
  }

  /** 变化文件经 core index.extract job 提取符号（applyManifest 与 watch 定向刷新共用）。 */
  private async extractSymbols(
    ws: WorkspaceState,
    sessionId: string,
    jobId: string,
    extractable: IndexScanEntry[],
    signal: AbortSignal,
  ): Promise<Map<string, SymbolRecord[]>> {
    const extracted = new Map<string, SymbolRecord[]>();
    const extractJobId = `${jobId}-x`;
    await this.core.startIndexExtract({
      sessionId,
      jobId: extractJobId,
      kind: "index.extract",
      cwd: ws.cwd,
      path: ".",
      files: extractable.map((entry) => entry.path),
    });
    const { summary: extractSummary } = await collectJobJsonLines(this.core, sessionId, extractJobId, signal, "index.extract", (line) => {
      const record = JSON.parse(line) as Partial<IndexExtractEntry> & { summary?: IndexExtractSummary };
      if (record.summary || typeof record.path !== "string" || !Array.isArray(record.symbols)) return;
      extracted.set(record.path, record.symbols.map(toSymbolRecord));
    }, this.pollMs);
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
    return extracted;
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
    const loaded: LoadedIndex = ws.loaded ?? { files: new Map(), symbols: new Map(), meta: undefined, fileLines: 0, symbolLines: 0, symbolCount: 0 };
    ws.loaded = loaded;
    const diff = diffManifest(loaded.files, entries);

    const extractable = [...diff.added, ...diff.changed]
      .filter((entry) => languageForPath(entry.path) !== undefined && entry.size <= MAX_EXTRACT_FILE_BYTES)
      .slice(0, this.budget.maxExtractFiles);
    const extracted = extractable.length > 0
      ? await this.extractSymbols(ws, sessionId, jobId, extractable, signal)
      : new Map<string, SymbolRecord[]>();

    // 应用 manifest 全量态（内存条目预存小写路径/基名供搜索，不落盘）
    // 循环 set 构造：避免 entries.map 产生 10 万对中间数组
    const nextFiles = new Map<string, IndexedFileEntry>();
    for (const entry of entries) nextFiles.set(entry.path, toIndexedFileEntry(entry));
    // symbolCount 与 symbols 同点增量维护（覆盖写按差值、删除按旧值扣减）
    for (const filePath of diff.deleted) {
      loaded.symbolCount -= loaded.symbols.get(filePath)?.length ?? 0;
      loaded.symbols.delete(filePath);
    }
    for (const [filePath, symbols] of extracted) {
      if (symbols.length > 0) {
        const list = symbols.map(toIndexedSymbolRecord);
        loaded.symbolCount += list.length - (loaded.symbols.get(filePath)?.length ?? 0);
        loaded.symbols.set(filePath, list);
      } else {
        loaded.symbolCount -= loaded.symbols.get(filePath)?.length ?? 0;
        loaded.symbols.delete(filePath);
      }
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
      symbols: loaded.symbolCount,
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
      ws.watchSessionId = sessionId;
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
      // 累积脏路径供定向增量刷新；溢出（事件丢失）或脏集超限则降级为全量重建
      if (result.overflow) {
        ws.watchDirty = undefined;
        ws.watchOverflow = true;
      } else if (!ws.watchOverflow) {
        const dirty = (ws.watchDirty ??= new Set());
        for (const event of result.events) {
          dirty.add(event.path.replace(/\\/g, "/"));
          if (dirty.size > MAX_WATCH_DIRTY_PATHS) {
            ws.watchDirty = undefined;
            ws.watchOverflow = true;
            break;
          }
        }
      }
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
      void this.refreshAuto(sessionId, ws).catch(() => undefined);
    }, this.refreshDebounceMs);
    ws.refreshTimer.unref();
  }

  /** 去抖刷新入口：watch 已给出明确脏路径且未溢出 → 定向增量刷新；否则全量重建。 */
  private async refreshAuto(sessionId: string, ws: WorkspaceState): Promise<void> {
    const dirty = ws.watchDirty;
    const overflow = ws.watchOverflow === true;
    ws.watchDirty = undefined;
    ws.watchOverflow = false;
    if (!overflow && dirty && dirty.size > 0) {
      await this.refreshPaths(ws, sessionId, [...dirty]);
      return;
    }
    await this.rebuild(sessionId, ws.cwd);
  }

  /**
   * watch 定向增量刷新：只对事件涉及的路径 stat + 符号重提取，不再全盘 walk。
   * 文件系统仍是真相：stat 缺失/非文件视为删除；size+modifiedMs 任一变化视为修改
   * （无 hash 时与 manifest diff 的回退判定同口径）；失败一律回落标滞后，不静默丢新鲜度。
   */
  private async refreshPaths(ws: WorkspaceState, sessionId: string, paths: string[]): Promise<void> {
    if (ws.building) {
      // 全量重建进行中：路径重新累积，重建结束后下一轮再增量
      const pending = (ws.watchDirty ??= new Set());
      for (const p of paths) pending.add(p);
      return;
    }
    await this.ensureLoaded(ws);
    const loaded = ws.loaded;
    if (!loaded?.meta) return; // 尚无索引：重建是显式动作，不自动触发
    const relevant = paths.filter((p) => !isExcludedPath(p));
    if (relevant.length === 0) {
      ws.stale = false;
      ws.staleReason = undefined;
      this.publish(sessionId, ws);
      return;
    }
    try {
      const stat = await this.core.statFiles({ sessionId, paths: relevant });
      const byPath = new Map(stat.entries.map((entry) => [entry.path, entry]));
      const deleted: string[] = [];
      const upsert: IndexScanEntry[] = [];
      for (const p of relevant) {
        const current = byPath.get(p);
        const indexed = loaded.files.get(p);
        if (!current || current.type !== "file") {
          if (indexed) deleted.push(p);
          continue;
        }
        if (!indexed || indexed.size !== current.size || indexed.modifiedMs !== current.modifiedMs) {
          upsert.push({ path: p, size: current.size, modifiedMs: current.modifiedMs });
        }
      }
      if (deleted.length === 0 && upsert.length === 0) {
        // 事件路径内容未变（如仅元数据触碰）：直接回到 fresh
        ws.stale = false;
        ws.staleReason = undefined;
        this.publish(sessionId, ws);
        return;
      }
      const extractable = upsert
        .filter((entry) => languageForPath(entry.path) !== undefined && entry.size <= MAX_EXTRACT_FILE_BYTES)
        .slice(0, this.budget.maxExtractFiles);
      const extracted = extractable.length > 0
        ? await this.extractSymbols(ws, sessionId, `index-${randomUUID()}`, extractable, new AbortController().signal)
        : new Map<string, SymbolRecord[]>();

      // 内存态就地增删（区别于全量重建的整表替换）
      for (const filePath of deleted) {
        loaded.files.delete(filePath);
        loaded.symbolCount -= loaded.symbols.get(filePath)?.length ?? 0;
        loaded.symbols.delete(filePath);
      }
      for (const entry of upsert) loaded.files.set(entry.path, toIndexedFileEntry(entry));
      for (const [filePath, symbols] of extracted) {
        if (symbols.length > 0) {
          const list = symbols.map(toIndexedSymbolRecord);
          loaded.symbolCount += list.length - (loaded.symbols.get(filePath)?.length ?? 0);
          loaded.symbols.set(filePath, list);
        } else {
          loaded.symbolCount -= loaded.symbols.get(filePath)?.length ?? 0;
          loaded.symbols.delete(filePath);
        }
      }

      ws.batch += 1;
      const appended = await ws.store.appendBatch(
        ws.batch,
        { upsert, deleted },
        { upsert: [...extracted.entries()].map(([filePath, symbols]) => ({ path: filePath, symbols })), deleted },
      );
      loaded.fileLines += appended.fileLines;
      loaded.symbolLines += appended.symbolLines;
      if (ws.store.shouldCompact(loaded.fileLines, loaded.files.size) || ws.store.shouldCompact(loaded.symbolLines, loaded.symbols.size)) {
        await ws.store.compact(loaded.files, loaded.symbols);
        loaded.fileLines = loaded.files.size + 1;
        loaded.symbolLines = loaded.symbols.size + 1;
      }

      const meta: IndexMeta = {
        ...loaded.meta,
        updatedAt: this.now(),
        files: loaded.files.size,
        symbols: loaded.symbolCount,
      };
      await ws.store.writeMeta(meta);
      loaded.meta = meta;
      ws.stale = false;
      ws.staleReason = undefined;
      this.publish(sessionId, ws);
    } catch (error) {
      // 增量刷新失败：如实标滞后，下次事件/手动 rebuild 再补
      ws.stale = true;
      ws.staleReason = "error";
      const message = error instanceof Error ? error.message : String(error);
      this.publish(sessionId, ws, `Index incremental refresh failed: ${message}`);
    }
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
    const total = ws.loaded.files.size;
    if (total === 0 || this.mtimeSampleSize <= 0) return;
    const step = Math.max(1, Math.floor(total / this.mtimeSampleSize));
    // 手动迭代 keys() 按步长取样，取满即停：不为 32 个样本物化 10 万 key 的数组
    const sample: string[] = [];
    let index = 0;
    for (const filePath of ws.loaded.files.keys()) {
      if (index % step === 0) {
        sample.push(filePath);
        if (sample.length === this.mtimeSampleSize) break;
      }
      index += 1;
    }
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
      // 常见键是规范路径（/ 分隔、无 ./ 前缀），归一化即自身：省去每键两次正则，仅在需要时归一化
      const normalized = path.indexOf("\\") >= 0 || path.startsWith("./") ? normalizeLookupPath(path) : path;
      if (normalized !== wanted) continue;
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
      // 全路径与基名各评一次取高分：用户常只记文件名；满分（100）已是评分上限，跳过基名重复评分
      const pathScore = fuzzyScoreLower(entry.pathLower, queryLower);
      const score = pathScore === 100 ? pathScore : Math.max(pathScore, fuzzyScoreLower(entry.baseLower, queryLower));
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

/** 小写已预算的评分内环：搜索热路径不重复 toLowerCase 分配（小写串预存在索引条目上）。 */
function fuzzyScoreLower(n: string, q: string): number {
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 75;
  if (n.includes(q)) return 50;
  const nLen = n.length;
  const qLen = q.length;
  if (qLen > nLen) return 0; // q 更长时子序列匹配必失败（走到这里已排除全等/前缀/包含）
  // 索引循环 + charCodeAt 替代 for...of（迭代器慢）。逐分等价说明：原 for...of 按码点
  // 迭代，代理对合成 2 码元字符串、永不等于 q[i]（单码元），这里整对跳过；
  // 落单代理在原实现中按单码元产出，这里同样逐码元参与比较。
  let i = 0;
  for (let j = 0; j < nLen; j += 1) {
    const code = n.charCodeAt(j);
    if (code >= 0xd800 && code <= 0xdbff && j + 1 < nLen) {
      const next = n.charCodeAt(j + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        j += 1;
        continue;
      }
    }
    if (code === q.charCodeAt(i)) i += 1;
    if (i === qLen) return 25;
  }
  return 0;
}
