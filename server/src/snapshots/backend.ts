import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeUtf8Atomically } from "../atomic-file.js";

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
  /** 创建检查点时的活动叶子；旧检查点缺失时回滚按物理前缀末条恢复。 */
  activeLeafId?: string;
  ledger?: unknown;
}

export interface SnapshotCapabilityInfo {
  backend: string;
  costHint: "instant" | "linear";
  requiresAdmin: boolean;
  detail?: string;
  /** 是否支持逐个删除检查点；缺省 true（差异链后端为 false）。 */
  supportsDelete?: boolean;
}

/** 对外可见的检查点摘要：不携带账本副本（仅恢复路径在服务端内部使用）。 */
export type CheckpointSummary = Omit<Checkpoint, "ledger">;

export interface SnapshotBackend {
  readonly name: string;
  initialize(): Promise<void>;
  capability(): Promise<SnapshotCapabilityInfo>;
  create(label: string, messageCount: number, ledger?: unknown, activeLeafId?: string): Promise<Checkpoint>;
  list(): Promise<Checkpoint[]>;
  /** 简要的差异文本（stat 摘要）；git-shadow 后端附带完整 unified diff（有界），供 0.5.0 diff 视图 hunk 解析 */
  diff(id: string): Promise<string>;
  /** inplace 恢复文件 */
  restore(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** 快照 id：snap-<毫秒时间戳>-<6 位随机 hex>，统一校验防路径穿越与参数注入。 */
export function newSnapshotId(): string {
  return `snap-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

export function validateSnapshotId(id: string): void {
  if (!/^snap-\d+-[0-9a-f]{6}$/.test(id)) throw new Error("Invalid checkpoint ID");
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Checkpoint>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.createdAt === "string" && Number.isSafeInteger(item.messageCount) && Number(item.messageCount) >= 0;
}

/**
 * 兼容旧/损坏元数据：activeLeafId 不是非空字符串时只丢弃该字段，不丢掉整个
 * 检查点（旧实现会把这类检查点从列表里静默过滤掉，用户看不到也回滚不了）。
 */
function normalizeCheckpoint(value: unknown): Checkpoint | undefined {
  if (!isCheckpoint(value)) return undefined;
  const item = value as Checkpoint;
  if (item.activeLeafId === undefined || (typeof item.activeLeafId === "string" && item.activeLeafId.length > 0)) return item;
  const { activeLeafId: _invalid, ...rest } = item;
  return rest;
}

/**
 * 读取 checkpoints.json：默认对文件缺失/内容损坏容错为空列表；
 * strict 模式只把 ENOENT 当空列表，其余错误（权限、损坏 JSON）向上抛。
 */
export async function readCheckpoints(file: string, options: { strict?: boolean } = {}): Promise<Checkpoint[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return Array.isArray(value) ? value.flatMap((item) => {
      const checkpoint = normalizeCheckpoint(item);
      return checkpoint ? [checkpoint] : [];
    }) : [];
  } catch (error) {
    if (options.strict && !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    return [];
  }
}

export async function writeCheckpoints(file: string, checkpoints: Checkpoint[]): Promise<void> {
  await writeUtf8Atomically(file, `${JSON.stringify(checkpoints, null, 2)}\n`);
}

/** API/WS 只下发摘要：账本随上下文增长，列表/事件不应重复传输整份副本。 */
export function checkpointSummary(checkpoint: Checkpoint): CheckpointSummary {
  if (checkpoint.ledger === undefined) return checkpoint;
  const { ledger: _ledger, ...summary } = checkpoint;
  return summary;
}

/** 简要 diff 文本统一截断到 maxLines 行；流式扫描，避免为超大 diff 建整行数组。 */
export function truncateLines(text: string, maxLines = 200): string {
  if (maxLines <= 0) return text;
  let lineCount = 1;
  let cut = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lineCount += 1;
    if (lineCount === maxLines + 1) {
      cut = index;
      break;
    }
  }
  if (cut === -1) return text;
  let total = lineCount;
  for (let index = cut + 1; index < text.length; index += 1) {
    if (text[index] === "\n") total += 1;
  }
  return `${text.slice(0, cut)}\n…（截断，共 ${total} 行）`;
}
