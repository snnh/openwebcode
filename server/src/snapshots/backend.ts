import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
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
  create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint>;
  list(): Promise<Checkpoint[]>;
  /** 简要的 stat 文本 */
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

export function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Checkpoint>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.createdAt === "string" && Number.isSafeInteger(item.messageCount) && Number(item.messageCount) >= 0;
}

/** 读取 checkpoints.json：文件缺失或内容损坏都按空列表处理（容错）。 */
export async function readCheckpoints(file: string): Promise<Checkpoint[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return Array.isArray(value) ? value.filter(isCheckpoint) : [];
  } catch {
    return [];
  }
}

export async function writeCheckpoints(file: string, checkpoints: Checkpoint[]): Promise<void> {
  await writeFile(file, `${JSON.stringify(checkpoints, null, 2)}\n`, "utf8");
}

/** 简要 diff 文本统一截断到 maxLines 行。 */
export function truncateLines(text: string, maxLines = 200): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…（截断，共 ${lines.length} 行）`;
}
