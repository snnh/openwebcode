/**
 * dsh-sync 扩展 M3b：dsh ↔ owc 会话映射表（扩展私有 storage 持久化的纯逻辑层）。
 *
 * 职责边界：本模块只管「映射表的形状与增删查」——读写经 {@link DshSyncStorageApi}
 * 注入（生产由 Extension Host 的 callApi storage.* 接线），因此可独立单测。
 *
 * 落盘位置：`<dataDir>/extensions-data/dsh-sync/map.json`（见 `docs/dsh-sync-plan.md` §6.3）。
 * 语义要点：
 * - 一个 dsh 会话**最多一条**映射（键 = dshId）：重复导入只有「覆盖/新建」两种选择，
 *   「新建副本」会再记一条新 owcId（旧的随之被挤掉，因为映射表的作用是「下次同步找谁」）；
 * - 导出方向（M4c）写同一张表，方向记在 `lastSyncDirection` 上；
 * - 条目上限 {@link DSH_SYNC_MAP_LIMIT}，超出按 `lastSyncAt` 从最旧开始裁剪（LRU）；
 * - 任何读取失败（文件缺失、JSON 损坏、字段非法）都降级为空表/丢弃坏条目，绝不阻断同步流程：
 *   映射表只是「省掉一次重选」，丢了最坏是重复导入一次。
 */

import { asRecord } from "./json-utils.js";

/** 映射文件在扩展私有 storage 里的相对路径。 */
export const DSH_SYNC_MAP_PATH = "map.json";

/** 映射条目上限（超出按 lastSyncAt 最旧裁剪）。 */
export const DSH_SYNC_MAP_LIMIT = 1000;

/** 一条会话映射：dsh 侧会话 id ↔ owc 侧会话 id。 */
export interface DshSyncMapEntry {
  /** dsh 会话 id（头行 id / 会话目录名解码值）。 */
  dshId: string;
  /** owc 会话 id（`sessions.import` 返回的 meta.id）。 */
  owcId: string;
  /** 最近一次同步时的 cwd（仅诊断展示用，不参与匹配）。 */
  cwd?: string;
  /** 最近一次同步时的标题（仅诊断展示用）。 */
  title?: string;
  /** 最近一次同步方向。 */
  lastSyncDirection: "import" | "export";
  /** 最近一次同步时间（ISO）。 */
  lastSyncAt: string;
}

/** 映射表文件结构（`version` 供未来迁移用，当前恒为 1）。 */
export interface DshSyncMap {
  version: 1;
  entries: DshSyncMapEntry[];
}

/**
 * 映射表读写所需的扩展私有 storage 能力（`DshSyncServerApi` 的存储子集）。
 * 单独抽出接口是为了让本模块不依赖 dsh-sync-host.ts（否则两侧互相 import 成环）。
 */
export interface DshSyncStorageApi {
  /** 读私有 storage 文件；文件不存在返回 `{content: null}`。 */
  storageRead(path: string): Promise<{ content: string | null }>;
  /** 写私有 storage 文件（覆盖），返回写入字节数。 */
  storageWrite(path: string, content: string): Promise<{ bytes: number }>;
  /** 删除私有 storage 文件（不存在返回 `{deleted: false}`）。 */
  storageDelete(path: string): Promise<{ deleted: boolean }>;
}

/** 空表（每次返回新对象，避免调用方改到共享单例）。 */
export function emptySyncMap(): DshSyncMap {
  return { version: 1, entries: [] };
}

/** 非空字符串判定（去首尾空白后仍非空）。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 单条映射的宽松校验：dshId/owcId/方向/时间缺一不可，其余字段可选。 */
function parseEntry(raw: unknown): DshSyncMapEntry | undefined {
  const entry = asRecord(raw);
  if (entry === undefined) return undefined;
  if (!isNonEmptyString(entry.dshId) || !isNonEmptyString(entry.owcId)) return undefined;
  if (entry.lastSyncDirection !== "import" && entry.lastSyncDirection !== "export") return undefined;
  if (!isNonEmptyString(entry.lastSyncAt)) return undefined;
  return {
    dshId: entry.dshId,
    owcId: entry.owcId,
    ...(isNonEmptyString(entry.cwd) ? { cwd: entry.cwd } : {}),
    ...(isNonEmptyString(entry.title) ? { title: entry.title } : {}),
    lastSyncDirection: entry.lastSyncDirection,
    lastSyncAt: entry.lastSyncAt,
  };
}

/**
 * 读取映射表：文件缺失 / 内容非法 / 顶层结构不符 → 空表；条目级坏数据逐条丢弃（保留可用条目）。
 *
 * 只有「文件不存在/内容不可用」被当成空表；**storage 本身调用失败会抛出**（IPC 超时、配额报错等
 * 是环境问题，不是「没同步过」），由调用方决定降级口径（host 侧包一层 warning 后按空表继续）。
 * @param api - 扩展私有 storage 能力。
 * @returns 映射表（恒为合法结构）。
 * @throws storage 调用失败时抛出（内容损坏不抛）。
 */
export async function loadSyncMap(api: DshSyncStorageApi): Promise<DshSyncMap> {
  let raw: { content: string | null };
  try {
    raw = await api.storageRead(DSH_SYNC_MAP_PATH);
  } catch (error: unknown) {
    throw new Error(`读取会话映射表失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (raw.content === null) return emptySyncMap();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.content);
  } catch {
    return emptySyncMap();
  }
  const record = asRecord(parsed);
  if (record === undefined || !Array.isArray(record.entries)) return emptySyncMap();
  const entries: DshSyncMapEntry[] = [];
  for (const item of record.entries) {
    const entry = parseEntry(item);
    if (entry !== undefined) entries.push(entry);
  }
  return { version: 1, entries };
}

/**
 * 写映射表（缩进 2 空格的 JSON，便于人工排查；覆盖写）。
 * @param api - 扩展私有 storage 能力。
 * @param map - 待写入的表（结构由调用方保证合法）。
 */
export async function saveSyncMap(api: DshSyncStorageApi, map: DshSyncMap): Promise<void> {
  await api.storageWrite(DSH_SYNC_MAP_PATH, `${JSON.stringify(map, null, 2)}\n`);
}

/**
 * 按 dsh 会话 id 查映射（表内一个 dshId 最多一条）。
 * @param map - 映射表。
 * @param dshId - dsh 会话 id。
 * @returns 命中的条目，未命中 undefined。
 */
export function findByDshId(map: DshSyncMap, dshId: string): DshSyncMapEntry | undefined {
  return map.entries.find((entry) => entry.dshId === dshId);
}

/**
 * 按 owc 会话 id 查映射（一个 owcId 理论上也只对应一条；命中多条时取最新同步的一条）。
 * @param map - 映射表。
 * @param owcId - owc 会话 id。
 * @returns 命中的条目，未命中 undefined。
 */
export function findByOwcId(map: DshSyncMap, owcId: string): DshSyncMapEntry | undefined {
  let found: DshSyncMapEntry | undefined;
  for (const entry of map.entries) {
    if (entry.owcId !== owcId) continue;
    if (found === undefined || entry.lastSyncAt > found.lastSyncAt) found = entry;
  }
  return found;
}

/** lastSyncAt 降序（最新在前）；非法时间串排到最后，保证裁剪口径可复现。 */
function byLastSyncAtDesc(left: DshSyncMapEntry, right: DshSyncMapEntry): number {
  const leftMs = Date.parse(left.lastSyncAt);
  const rightMs = Date.parse(right.lastSyncAt);
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);
  if (leftValid && rightValid && leftMs !== rightMs) return rightMs - leftMs;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  // 时间相同/都非法：按 dshId 稳定排序，避免同一输入出现两种条目顺序
  return left.dshId < right.dshId ? -1 : left.dshId > right.dshId ? 1 : 0;
}

/**
 * 记录一次同步（upsert，纯函数：返回新表，不改入参）。
 *
 * 键为 `dshId`（同一 dsh 会话在表里只留最新的一条），`lastSyncDirection` 覆盖为新方向；
 * 新条目未给的 cwd/title 沿用旧条目的值（面板清单里不显示空白）。
 * 写入后按 `lastSyncAt` 降序排列，超出 {@link DSH_SYNC_MAP_LIMIT} 的尾部（最旧）裁掉。
 * @param map - 原映射表。
 * @param entry - 本次同步结论。
 * @returns 新映射表。
 */
export function recordSync(map: DshSyncMap, entry: DshSyncMapEntry): DshSyncMap {
  const existing = findByDshId(map, entry.dshId);
  const merged: DshSyncMapEntry = {
    dshId: entry.dshId,
    owcId: entry.owcId,
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : existing?.cwd !== undefined ? { cwd: existing.cwd } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : existing?.title !== undefined ? { title: existing.title } : {}),
    lastSyncDirection: entry.lastSyncDirection,
    lastSyncAt: entry.lastSyncAt,
  };
  const entries = [...map.entries.filter((item) => item.dshId !== entry.dshId), merged]
    .sort(byLastSyncAtDesc)
    .slice(0, DSH_SYNC_MAP_LIMIT);
  return { version: 1, entries };
}
