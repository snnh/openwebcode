/**
 * 索引存储（0.4.0 Phase 2 §7.1）：<dataDir>/index/<workspace-hash>/ 下的
 * meta.json + files.jsonl + symbols.jsonl。append-only 批次写入 + 定期压实。
 *
 * 定位：加速缓存，不是真相来源——文件系统永远是真相。损坏（JSON 解析失败 /
 * 版本不符）整体作废，由 IndexManager 触发整体重建；索引数据不导出、不同步。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { IndexScanEntry } from "../core-client.js";

// 导出给 scripts/bench/bench-index-100k.mjs（tsx 直引 server/src）构造兼容索引。
const INDEX_FORMAT_VERSION = 1;

/** 符号种类：与 core `index.extract` 输出的 kind 集合对齐；"variable" 是不认识 kind 的兜底桶。 */
type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "struct"
  | "enum"
  | "trait"
  | "impl"
  | "constant"
  | "variable";

const SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "function", "method", "class", "interface", "type",
  "struct", "enum", "trait", "impl", "constant", "variable",
]);

export function isSymbolKind(kind: string): kind is SymbolKind {
  return SYMBOL_KINDS.has(kind);
}

/** kind 驻留表：内存记录复用共享常量实例，避免每个符号各占一份独立字符串。 */
const SYMBOL_KIND_INTERN: ReadonlyMap<string, SymbolKind> = new Map(
  [...SYMBOL_KINDS].map((kind) => [kind, kind as SymbolKind]),
);

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  /** 1 起始，闭区间 */
  startLine: number;
  endLine: number;
  /** 签名摘要：匹配行去首尾空白后截取前 120 字符 */
  signature: string;
}

/**
 * 内存中的文件条目：预存小写路径/基名供模糊搜索复用（100k 文件量级下预存
 * 优于每次搜索临时 toLowerCase 分配）。序列化时剔除（compact 投影回 IndexScanEntry），
 * 不落盘、不改落盘格式。
 */
export interface IndexedFileEntry extends IndexScanEntry {
  pathLower: string;
  baseLower: string;
}

/** 内存中的符号记录：预存小写名供模糊搜索复用（同上，不落盘）。 */
interface IndexedSymbolRecord extends SymbolRecord {
  nameLower: string;
}

/** 清单条目 → 内存条目（补小写索引字段）。 */
export function toIndexedFileEntry(entry: IndexScanEntry): IndexedFileEntry {
  const pathLower = entry.path.toLowerCase();
  return { ...entry, pathLower, baseLower: basenameLowerOf(pathLower) };
}

/** 符号记录 → 内存记录（补小写名；kind 归一到共享常量，10 万+ 符号下省去逐条驻留）。 */
export function toIndexedSymbolRecord(record: SymbolRecord): IndexedSymbolRecord {
  return { ...record, kind: SYMBOL_KIND_INTERN.get(record.kind) ?? record.kind, nameLower: record.name.toLowerCase() };
}

/** 小写基名：入参已是小写路径，分隔符兼容 / 与 \（与 index-manager 原 basenameOf 同族）。 */
function basenameLowerOf(pathLower: string): string {
  return pathLower.slice(Math.max(pathLower.lastIndexOf("/"), pathLower.lastIndexOf("\\")) + 1);
}

/** 参与提取的源文件大小上限（字节）：与 core index.extract 单文件上限一致。 */
export const MAX_EXTRACT_FILE_BYTES = 1_048_576;

/** 按扩展名识别语言；不支持的返回 undefined（只进文件清单，不提符号）。 */
export function languageForPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "ts": case "tsx": case "mts": case "cts": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "py": case "pyi": return "python";
    case "go": return "go";
    case "rs": return "rust";
    case "c": case "h": return "c";
    case "cpp": case "cc": case "cxx": case "hpp": case "hh": case "hxx": return "cpp";
    case "java": return "java";
    case "cs": return "csharp";
    default: return undefined;
  }
}
/** 冗余行超过（存活条目的 2 倍 + 500）或超过 2 万行时压实。 */
const COMPACT_SLACK_LINES = 500;
const COMPACT_HARD_LINES = 20_000;

/** workspace-hash：规范化 cwd 的 sha256 前 16 位（索引目录名，不含敏感路径明文）。 */
export function workspaceHash(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export interface IndexMeta {
  version: number;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** 最近一次成功扫描的摘要（core summary + 耗时）。 */
  lastScan?: {
    at: number;
    entries: number;
    truncated: boolean;
    reason: string | null;
    hashTruncated: boolean;
    durationMs: number;
  };
  files: number;
  symbols: number;
}

export class IndexCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexCorruptError";
  }
}

type SymbolsLine = { path: string; symbols: SymbolRecord[] } | { path: string; deleted: true };

export interface LoadedIndex {
  files: Map<string, IndexedFileEntry>;
  symbols: Map<string, IndexedSymbolRecord[]>;
  meta: IndexMeta | undefined;
  /** files.jsonl / symbols.jsonl 当前行数（压实判定用）。 */
  fileLines: number;
  symbolLines: number;
  /** symbols 全表符号总数：load 时算一次，applyManifest 增量维护，statusOf 免全表扫描。 */
  symbolCount: number;
}

export class IndexStore {
  readonly dir: string;
  private readonly metaPath: string;
  private readonly filesPath: string;
  private readonly symbolsPath: string;

  constructor(indexRoot: string, cwd: string) {
    this.dir = path.join(indexRoot, workspaceHash(cwd));
    this.metaPath = path.join(this.dir, "meta.json");
    this.filesPath = path.join(this.dir, "files.jsonl");
    this.symbolsPath = path.join(this.dir, "symbols.jsonl");
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.metaPath);
      return true;
    } catch {
      return false;
    }
  }

  /** files.jsonl / symbols.jsonl 任一存在即为"有索引数据"（半写态按损坏处理）。 */
  async hasDataFiles(): Promise<boolean> {
    for (const file of [this.filesPath, this.symbolsPath]) {
      try {
        await fs.access(file);
        return true;
      } catch {
        // 继续检查下一个
      }
    }
    return false;
  }

  /** 作废整个索引目录（损坏或显式重建前调用）。 */
  async reset(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  /**
   * 加载索引。任何解析失败/版本不符抛 IndexCorruptError——调用方整体重建。
   * meta.json 不存在但 jsonl 存在同样视为损坏（半写状态不可信）。
   */
  async load(): Promise<LoadedIndex> {
    let metaRaw: string;
    try {
      metaRaw = await fs.readFile(this.metaPath, "utf-8");
    } catch {
      throw new IndexCorruptError("meta.json missing");
    }
    let meta: IndexMeta;
    try {
      meta = JSON.parse(metaRaw) as IndexMeta;
    } catch {
      throw new IndexCorruptError("meta.json is not valid JSON");
    }
    if (meta.version !== INDEX_FORMAT_VERSION) {
      throw new IndexCorruptError(`index format version ${String(meta.version)} != ${INDEX_FORMAT_VERSION}`);
    }
    const files = new Map<string, IndexedFileEntry>();
    const symbols = new Map<string, IndexedSymbolRecord[]>();
    const fileLines = await this.replay(this.filesPath, (line) => {
      const record = JSON.parse(line) as { type?: string; path?: unknown; deleted?: unknown; size?: unknown; modifiedMs?: unknown; sha256?: unknown };
      if (record.type === "batch" || typeof record.path !== "string") return;
      if (record.deleted === true) files.delete(record.path);
      else if (typeof record.size === "number" && typeof record.modifiedMs === "number") {
        // 热路径内联构造（不走 spread）：小写路径/基名预算在此一次完成，供搜索复用
        const pathLower = record.path.toLowerCase();
        files.set(record.path, {
          path: record.path,
          size: record.size,
          modifiedMs: record.modifiedMs,
          ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
          pathLower,
          baseLower: basenameLowerOf(pathLower),
        });
      }
    });
    let symbolCount = 0;
    const symbolLines = await this.replay(this.symbolsPath, (line) => {
      const record = JSON.parse(line) as SymbolsLine & { type?: string };
      if (record.type === "batch") return;
      if ("deleted" in record && record.deleted) {
        symbolCount -= symbols.get(record.path)?.length ?? 0;
        symbols.delete(record.path);
      } else if ("symbols" in record && Array.isArray(record.symbols)) {
        const list = record.symbols.map(toIndexedSymbolRecord);
        // files replay 在前：键复用 files Map 的同路径字符串引用，JSON.parse 的新副本不常驻
        const key = files.get(record.path)?.path ?? record.path;
        symbolCount += list.length - (symbols.get(key)?.length ?? 0);
        symbols.set(key, list);
      }
    });
    return { files, symbols, meta, fileLines, symbolLines, symbolCount };
  }

  /**
   * 整读 + split + 逐行 parse 即弃：readline 流式逐行在 10 万+ 行量级比 split 慢 2-3 倍
   * （实测回归），行数组是局部临时引用、replay 返回后即可 GC，不构成长驻占用。
   */
  private async replay(filePath: string, apply: (line: string) => void): Promise<number> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch {
      return 0; // 首个批次前文件不存在是正常态
    }
    let count = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      count += 1;
      try {
        apply(trimmed);
      } catch {
        throw new IndexCorruptError(`${path.basename(filePath)} line ${count} is not valid JSON`);
      }
    }
    return count;
  }

  /**
   * 追加一个批次：files 为最终 upsert/delete 集，symbols 为对应符号集。
   * 写失败不破坏既有数据（append 语义，半行只会损坏最后一个批次，
   * 下次 load 报损坏 → 整体重建，符合"缓存可丢"定位）。
   */
  async appendBatch(
    batch: number,
    files: { upsert: IndexScanEntry[]; deleted: string[] },
    symbols: { upsert: Array<{ path: string; symbols: SymbolRecord[] }>; deleted: string[] },
  ): Promise<{ fileLines: number; symbolLines: number }> {
    await fs.mkdir(this.dir, { recursive: true });
    const fileChunk = [
      JSON.stringify({ type: "batch", batch, at: Date.now() }),
      ...files.upsert.map((entry) => JSON.stringify(entry)),
      ...files.deleted.map((filePath) => JSON.stringify({ path: filePath, deleted: true })),
    ].join("\n") + "\n";
    const symbolChunk = [
      JSON.stringify({ type: "batch", batch, at: Date.now() }),
      ...symbols.upsert.map((entry) => JSON.stringify(entry)),
      ...symbols.deleted.map((filePath) => JSON.stringify({ path: filePath, deleted: true })),
    ].join("\n") + "\n";
    await fs.appendFile(this.filesPath, fileChunk);
    await fs.appendFile(this.symbolsPath, symbolChunk);
    return {
      fileLines: files.upsert.length + files.deleted.length + 1,
      symbolLines: symbols.upsert.length + symbols.deleted.length + 1,
    };
  }

  /** 压实：把当前内存态重写为全量快照（单批次），替换 append 历史。 */
  async compact(files: ReadonlyMap<string, IndexedFileEntry>, symbols: ReadonlyMap<string, IndexedSymbolRecord[]>): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // 内存条目带小写索引字段（pathLower/baseLower/nameLower），落盘前投影回原始形状，落盘格式不变
    const filesText = [JSON.stringify({ type: "batch", batch: 0, at: Date.now(), compacted: true }),
      ...[...files.values()].map((entry) => JSON.stringify({ path: entry.path, size: entry.size, modifiedMs: entry.modifiedMs, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) }))].join("\n") + "\n";
    const symbolsText = [JSON.stringify({ type: "batch", batch: 0, at: Date.now(), compacted: true }),
      ...[...symbols.entries()].map(([filePath, list]) => JSON.stringify({ path: filePath, symbols: list.map((record) => ({ name: record.name, kind: record.kind, startLine: record.startLine, endLine: record.endLine, signature: record.signature })) }))].join("\n") + "\n";
    // 先写临时文件再 rename，避免压实中途崩溃留下半截 jsonl
    const tmpFiles = `${this.filesPath}.tmp`;
    const tmpSymbols = `${this.symbolsPath}.tmp`;
    await fs.writeFile(tmpFiles, filesText);
    await fs.writeFile(tmpSymbols, symbolsText);
    await fs.rename(tmpFiles, this.filesPath);
    await fs.rename(tmpSymbols, this.symbolsPath);
  }

  shouldCompact(totalLines: number, liveEntries: number): boolean {
    return totalLines > COMPACT_HARD_LINES || totalLines > liveEntries * 2 + COMPACT_SLACK_LINES;
  }

  async writeMeta(meta: IndexMeta): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.metaPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fs.rename(tmp, this.metaPath);
  }
}
