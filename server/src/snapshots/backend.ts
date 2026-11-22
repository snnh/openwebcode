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
}

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
export function normalizeCheckpoint(value: unknown): Checkpoint | undefined {
  if (!isCheckpoint(value)) return undefined;
  const item = value as Checkpoint;
  if (item.activeLeafId === undefined || (typeof item.activeLeafId === "string" && item.activeLeafId.length > 0)) return item;
  const { activeLeafId: _invalid, ...rest } = item;
  return rest;
}

/** 读取 checkpoints.json：文件缺失或内容损坏都按空列表处理（容错）。 */
export async function readCheckpoints(file: string): Promise<Checkpoint[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return Array.isArray(value) ? value.flatMap((item) => {
      const checkpoint = normalizeCheckpoint(item);
      return checkpoint ? [checkpoint] : [];
    }) : [];
  } catch {
    return [];
  }
}

export async function writeCheckpoints(file: string, checkpoints: Checkpoint[]): Promise<void> {
  await writeUtf8Atomically(file, `${JSON.stringify(checkpoints, null, 2)}\n`);
}

/** 简要 diff 文本统一截断到 maxLines 行。 */
export function truncateLines(text: string, maxLines = 200): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…（截断，共 ${lines.length} 行）`;
}
