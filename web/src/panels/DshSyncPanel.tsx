import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../components/Icon";
import { useExtensionsQuery } from "../app/queries";
import { ui } from "../app/ui-store";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { formatDateTime, formatTime } from "../lib/format";

/**
 * dsh 同步面板（dsh-sync 扩展，M4d）：底部面板「dsh 同步」页签的内容。
 *
 * 三块结构：环境状态条（GET /status）+ 模型配置同步（预览差异 → 逐项勾选 → 执行）
 * + 会话同步（双向完整：导入=预览 dsh 会话 → 按 cwd 分组勾选 → 执行导入 → 报告；
 * 导出=预览 owc 会话 → 列表勾选 → 执行导出 → 报告）。
 * 所有数据经扩展私有路由 `/api/ext/dsh-sync/*`（api.extRoute），扩展未启用时页签不出现、面板本身再兜一层提示。
 *
 * 勾选语义：
 * - 模型配置：new 默认勾选、changed 默认不勾（冲突不隐式覆盖）、same 不可勾；
 * - 会话导入：可导入且未同步过的会话默认勾选，已同步过的默认不勾（overwrite 需用户显式选择
 *   「覆盖更新已导入的会话」）；不可导入项（旧代际/损坏/缺 zstd）禁用并显示原因；
 * - 会话导出：默认不勾（导出会在 dsh 侧新建目录，批量全选可能一次写出大量会话，故交由用户显式选择）。
 *
 * 两个区块各有独立的方向开关（数据流互不相干）；请求只在用户点击「预览…」后发出。
 * 会话区块的两个方向各有独立的预览缓存与勾选/报告状态：切方向不清空对方结果，切回已预览过的
 * 方向直接复用缓存（不重发请求），执行后只刷新当前方向的预览以更新「已同步/已导出」徽标。
 */

/** 扩展 id（启用判据 + 私有路由前缀共用；与 server 侧 manifest 一致）。 */
export const DSH_SYNC_EXTENSION_ID = "dsh-sync";

export type DshSyncDirection = "import" | "export";
export type DshPreviewStatus = "new" | "changed" | "same";
/** 凭据结论：导入方向 resolved|missing|inline|none，导出方向 env|none（并集收窄，缺省不渲染）。 */
export type DshCredentialState = "resolved" | "missing" | "inline" | "none" | "env";

/** GET /status 应答。 */
export interface DshSyncStatus {
  dshHome: string;
  dshHomeExists: boolean;
  profile: string;
  profileExists: boolean;
  zstdAvailable: boolean;
  dshRunning: boolean;
  nodeVersion: string;
}

/** 单字段差异（source=数据源侧、target=目标侧）。 */
export interface DshProviderChange {
  field: string;
  source?: unknown;
  target?: unknown;
}

/** 预览条目。 */
export interface DshProviderPreviewItem {
  key: string;
  status: DshPreviewStatus;
  changes?: DshProviderChange[];
  credential?: DshCredentialState;
  /** 导出方向：将写入 dsh 的 apiKeyEnv 引用名。 */
  apiKeyEnv?: string;
  /** 导入方向：该 provider 会一并导入的模型目录条目数。 */
  models?: number;
}

/** GET /preview/providers 应答。 */
export interface DshProviderPreview {
  direction: DshSyncDirection;
  items: DshProviderPreviewItem[];
  unmappedFields: string[];
  warnings: string[];
  dshRunning: boolean;
  warning?: string;
  patchFile?: string;
  envNeeded?: Record<string, string>;
}

/** 逐项执行结论（applied/skipped 条目）。 */
export interface DshSyncItemResult {
  key: string;
  kind?: "profile" | "model";
  provider?: string;
  reason?: string;
}

/** POST /sync/providers 应答。 */
export interface DshProviderSyncResult {
  direction?: DshSyncDirection;
  applied: DshSyncItemResult[];
  skipped: DshSyncItemResult[];
  report: {
    unmappedFields: string[];
    warnings: string[];
    notes?: string[];
    patchFile?: string;
    dshRunning?: boolean;
  };
  /** 导出方向：写盘前的备份文件路径。 */
  backupPath?: string;
  /** 导出方向：需在 dsh 环境设置的变量（envName → provider id）。 */
  envNeeded?: Record<string, string>;
}

/** 会话同步方向（与模型配置同词表；M3c 落地 import，M4d 落地 export）。 */
export type DshSessionConflict = "overwrite" | "new";

/** dsh 会话代际里可导入的那一版（v3）；其余代际只能先在 dsh 内升级格式。 */
export const DSH_SYNC_SUPPORTED_GENERATION = 3;

/** 会话清单条目（GET /preview/sessions）。 */
export interface DshSessionPreviewItem {
  /** dsh 会话 id（目录名解码值）。 */
  dshId: string;
  /** 会话 cwd（头行缺失时 undefined：需用户为该行填 cwdOverride）。 */
  cwd?: string;
  /** 头行 createdAt（ISO）。 */
  createdAt?: string;
  /** 代际（0=v0 … 3=v3）。 */
  generation?: number;
  /** 格式是否可用（v3 + 未损坏 + zstd 能力足够）。 */
  supported: boolean;
  /** 子代理会话的 origin（如 `subagent`）。 */
  origin?: string;
  /** 子代理会话的父会话 id。 */
  parentSession?: string;
  /** 映射表 join 结果（该 dsh 会话已同步过才有）。 */
  sync?: { owcId: string; lastSyncAt: string };
  /** 是否可勾选导入（当前 = supported）。 */
  selectable: boolean;
  /** 不可选原因（selectable=false 时给出）。 */
  reason?: string;
}

/** GET /preview/sessions 应答。 */
export interface DshSessionPreview {
  direction: DshSyncDirection;
  items: DshSessionPreviewItem[];
  /** node:zlib 是否具备 zstd 能力（压缩会话需 Node ≥22.15）。 */
  zstdAvailable: boolean;
  dshRunning: boolean;
  /** 整体降级说明（目录缺失、zstd 不可用、映射表读取失败等）。 */
  warning?: string;
}

/** 单次会话转换统计（服务端 ConversionCounts；u/a/t = user/assistant/tool 消息数）。 */
export interface DshSessionCounts {
  user: number;
  assistant: number;
  tool: number;
  images: number;
  imagesMissing: number;
}

/** 单条导入的成功结论。 */
export interface DshSessionAppliedItem {
  dshId: string;
  owcId: string;
  title: string;
  counts: DshSessionCounts;
  warnings: string[];
}

/** 单条导入的跳过结论。 */
export interface DshSessionSkippedItem {
  dshId: string;
  reason: string;
}

/** POST /sync/sessions 应答的报告段。 */
export interface DshSessionReport {
  dshHome: string;
  dshRunning: boolean;
  onConflict: DshSessionConflict;
  appliedCount: number;
  skippedCount: number;
  /** 跨会话求和的丢弃事件类型 → 条数（服务端已按键名排序）。 */
  droppedEvents: Record<string, number>;
  /** 带 dshId 前缀的转换警告 + 映射表写入失败等运行期告警。 */
  warnings: string[];
  /** 语义说明（冲突策略、provider 归属、映射表位置等）。 */
  notes: string[];
  /** 映射表落盘是否成功（失败时导入本身仍成功，只是下次要重选）。 */
  mapSaved: boolean;
  mapPath: string;
}

/** POST /sync/sessions 应答。 */
export interface DshSessionSyncResult {
  direction: DshSyncDirection;
  applied: DshSessionAppliedItem[];
  skipped: DshSessionSkippedItem[];
  report: DshSessionReport;
}

// ── 会话导出（M4d）：owc 会话清单 + 逐项写出 dsh v3 文件 ──────────────────────

/**
 * 导出方向清单条目（GET /preview/sessions?direction=export 的 items 元素）。
 *
 * 键是 **owcId**（与导入方向的 dshId 相对），后端已按 updatedAt 倒序返回、面板直用其顺序。
 * export 方向条目**恒可勾选**：重复导出 = 在 dsh 侧再生成一份新会话（不覆盖），
 * `sync` 徽标只提示「上次导出时间」。
 */
export interface DshSessionExportItem {
  /** owc 会话 id。 */
  owcId: string;
  /** 会话标题（后端缺省用「未命名会话」兜底）。 */
  title: string;
  /** 会话工作目录（缺 cwd/非绝对路径时导出会跳过该会话）。 */
  cwd?: string;
  provider?: string;
  model?: string;
  /** 会话最近更新时间（ISO）。 */
  updatedAt?: string;
  /** 映射表 join：该 owc 会话最近一次导出到的 dsh 会话 id 与时间。 */
  sync?: { dshId: string; lastSyncAt: string };
  /** export 方向恒为 true。 */
  selectable: true;
}

/** GET /preview/sessions?direction=export 应答。 */
export interface DshSessionExportPreview {
  direction: "export";
  items: DshSessionExportItem[];
  /** node:zlib 是否具备 zstd 能力（导出写 zstd 帧的前提）。 */
  zstdAvailable: boolean;
  dshRunning: boolean;
  /** 整体降级说明（dshHome 缺失、zstd 不可用、owc 清单/映射表读取失败等）。 */
  warning?: string;
}

/** 单条导出的成功结论。 */
export interface DshSessionExportAppliedItem {
  /** owc 侧会话 id（映射表记录用）。 */
  owcId: string;
  /** 新生成的 dsh 会话 id（= 会话目录名 = 头行 id）。 */
  dshId: string;
  /** 写出的会话文件绝对路径。 */
  file: string;
  /** 写出的事件条数。 */
  eventCount: number;
  /** 落盘的图片附件数。 */
  attachments: number;
  /** 该会话的降级说明（图片占位、缺 provider/model 等）。 */
  warnings: string[];
  /** 一并导出的子代理会话（M5a：owc 转录 taskId → 新 dsh 会话 id；无子代理时缺省）。 */
  subagents?: Array<{ taskId: string; dshId: string }>;
  /** 导出失败的子代理转录（M5a；失败不影响父会话导出）。 */
  subagentsFailed?: Array<{ taskId: string; reason: string }>;
}

/** 单条导出的跳过结论（键 = owcId）。 */
export interface DshSessionExportSkippedItem {
  owcId: string;
  reason: string;
}

/** POST /sync/sessions（direction=export）应答的报告段。 */
export interface DshSessionExportReport {
  dshHome: string;
  dshRunning: boolean;
  appliedCount: number;
  skippedCount: number;
  /** 带 owcId 前缀的导出警告 + 映射表写入失败等运行期告警。 */
  warnings: string[];
  /** 语义说明。 */
  notes: string[];
  /** 映射表落盘是否成功（失败时导出本身仍成功，只是下次面板不再显示「已导出」徽标）。 */
  mapSaved: boolean;
  mapPath: string;
}

/** POST /sync/sessions（direction=export）应答。 */
export interface DshSessionExportResult {
  direction: "export";
  applied: DshSessionExportAppliedItem[];
  skipped: DshSessionExportSkippedItem[];
  report: DshSessionExportReport;
}

/** 按 cwd 聚合的一组会话（cwd 缺失的条目单独成组，排在最后）。 */
export interface DshSessionGroup {
  /** 组头展示的 cwd（undefined = 该组会话都没有 cwd）。 */
  cwd?: string;
  items: DshSessionPreviewItem[];
}

/** 徽标规格：tone 映射到基础样式 .pill 的语义修饰（muted 用无修饰的 .pill）。 */
export interface DshBadge {
  zh: string;
  en: string;
  tone: "ok" | "amber" | "danger" | "muted";
}

/** 差异状态徽标（新增=绿 / 变更=黄 / 相同=灰）。 */
export function statusBadge(status: DshPreviewStatus): DshBadge {
  if (status === "new") return { zh: "新增", en: "New", tone: "ok" };
  if (status === "changed") return { zh: "变更", en: "Changed", tone: "amber" };
  return { zh: "相同", en: "In sync", tone: "muted" };
}

/** 凭据徽标（缺失=红；其余为说明性质，弱化展示）。 */
export function credentialBadge(credential: DshCredentialState | undefined): DshBadge | undefined {
  switch (credential) {
    case "resolved": return { zh: "已解析", en: "Resolved", tone: "ok" };
    case "missing": return { zh: "环境变量缺失", en: "Missing env var", tone: "danger" };
    case "inline": return { zh: "内联凭据", en: "Inline key", tone: "muted" };
    case "env": return { zh: "环境变量引用", en: "Env reference", tone: "muted" };
    case "none": return { zh: "无凭据", en: "No credential", tone: "muted" };
    default: return undefined;
  }
}

/** 条目是否可勾选：两侧已一致的条目无需执行。 */
export function isSelectable(item: DshProviderPreviewItem): boolean {
  return item.status !== "same";
}

/** 预览条目 → 默认勾选集合：仅 new 默认勾选（changed 需用户显式确认覆盖，same 不可勾）。 */
export function defaultSelection(items: readonly DshProviderPreviewItem[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const item of items) if (item.status === "new") selection[item.key] = true;
  return selection;
}

/** 勾选集合 → 执行 keys：跟随预览列表顺序（输出稳定，便于断言与日志复核），跳过不可勾选项。 */
export function selectedKeys(items: readonly DshProviderPreviewItem[], selection: Record<string, boolean>): string[] {
  return items.filter((item) => isSelectable(item) && selection[item.key] === true).map((item) => item.key);
}

/** 差异值展示：字符串直出，其余 JSON 序列化；过长截断（面板窄，明细里另有完整字段名可核对）。 */
export function formatChangeValue(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** 差异行文案：`字段: 目标现值 → 将被写入的源值`（导入=owc 现值 → dsh 新值，导出反之）。 */
export function changeLine(change: DshProviderChange): string {
  return `${change.field}: ${formatChangeValue(change.target)} → ${formatChangeValue(change.source)}`;
}

/** dsh 会话 id 展示片段：前 8 位（完整 id 在 checkbox 的 aria-label 上，便于测试与复核）。 */
export function shortDshId(dshId: string): string {
  return dshId.slice(0, 8);
}

/** 代际是否非 v3（非 v3 一律不可导入，行内给出「需先在 dsh 中升级」提示）。 */
export function isLegacyGeneration(generation: number | undefined): boolean {
  return generation !== undefined && generation !== DSH_SYNC_SUPPORTED_GENERATION;
}

/** 丢弃事件汇总行：`type×n；type×n`（无丢弃返回 undefined，面板不渲染空块）。 */
export function droppedEventsLine(dropped: Record<string, number>): string | undefined {
  const entries = Object.entries(dropped);
  if (entries.length === 0) return undefined;
  return entries.map(([type, count]) => `${type}×${count}`).join("；");
}

/**
 * 会话按 cwd 分组：有 cwd 的组按 cwd 升序（输出稳定），缺 cwd 的归到最后一组。
 * 缺 cwd 的会话需要用户逐行填 cwdOverride，放最后便于集中处理。
 */
export function groupSessions(items: readonly DshSessionPreviewItem[]): DshSessionGroup[] {
  const groups = new Map<string, DshSessionGroup>();
  for (const item of items) {
    const key = item.cwd ?? "";
    const group = groups.get(key) ?? { ...(item.cwd === undefined ? {} : { cwd: item.cwd }), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.cwd === undefined) return right.cwd === undefined ? 0 : 1;
    if (right.cwd === undefined) return -1;
    return left.cwd < right.cwd ? -1 : left.cwd > right.cwd ? 1 : 0;
  });
}

/** 会话默认勾选：可导入且未同步过的默认勾（已同步的需用户显式选择冲突策略）。 */
export function defaultSessionSelection(items: readonly DshSessionPreviewItem[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const item of items) if (item.selectable && item.sync === undefined) selection[item.dshId] = true;
  return selection;
}

/** 全选：只勾可导入项（不可导入项即使被勾选也会被 selectedSessionIds 过滤，视图层双重保险）。 */
export function selectableSessionSelection(items: readonly DshSessionPreviewItem[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const item of items) if (item.selectable) selection[item.dshId] = true;
  return selection;
}

/** 勾选集合 → dshId 列表：跟随清单顺序（输出稳定，便于断言与日志复核），跳过不可导入项。 */
export function selectedSessionIds(items: readonly DshSessionPreviewItem[], selection: Record<string, boolean>): string[] {
  return items.filter((item) => item.selectable && selection[item.dshId] === true).map((item) => item.dshId);
}

/** 勾选集中是否含「已同步过」的会话（决定是否显示冲突处理单选）。 */
export function hasSyncedSelection(items: readonly DshSessionPreviewItem[], selection: Record<string, boolean>): boolean {
  return items.some((item) => item.selectable && item.sync !== undefined && selection[item.dshId] === true);
}

/**
 * 勾选集合 → POST /sync/sessions 请求体。
 *
 * cwdOverride 只随「清单里缺 cwd」的勾选项发送：已有 cwd 的会话覆盖现值会误改导入目标目录，
 * 因此即便界面上残留了输入值也不发（缺 cwd 但没填的行照常发送，由服务端给出可读的 skipped 原因）。
 */
export function sessionSyncPayload(
  items: readonly DshSessionPreviewItem[],
  selection: Record<string, boolean>,
  cwdOverrides: Record<string, string>,
  onConflict: DshSessionConflict,
): { direction: "import"; items: Array<{ dshId: string; cwdOverride?: string }>; onConflict: DshSessionConflict } {
  const payloadItems: Array<{ dshId: string; cwdOverride?: string }> = [];
  for (const item of items) {
    if (!item.selectable || selection[item.dshId] !== true) continue;
    const override = (cwdOverrides[item.dshId] ?? "").trim();
    const withOverride = item.cwd === undefined && override.length > 0;
    payloadItems.push(withOverride ? { dshId: item.dshId, cwdOverride: override } : { dshId: item.dshId });
  }
  return { direction: "import", items: payloadItems, onConflict };
}

/**
 * 导出条目 → 展示用 `provider/model` 文案：两者都缺返回 undefined（不渲染）。
 * 只有一侧时只显示该侧，避免出现「undefined/xxx」这类噪声。
 */
export function providerModelLabel(item: Pick<DshSessionExportItem, "provider" | "model">): string | undefined {
  const parts = [item.provider, item.model].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length === 0 ? undefined : parts.join("/");
}

/**
 * 导出方向默认勾选：默认**不勾**任何会话（空集合）。
 *
 * 理由：导出是写操作——会在 dsh 数据目录里新建会话目录并把会话文件落盘，且清单可能很长。
 * 与导入方向「可导入且未同步的默认勾」不同，导出没有「未导出过」这种自然的安全过滤（重复导出
 * 只是再生成一份新副本），一次性全勾可能瞬间写出大量文件，因此这里取保守默认，由用户显式勾选
 * 或点「全选」。`items` 形参保留（与 `defaultSessionSelection` 对称），当前实现不依赖其内容。
 */
export function defaultExportSelection(_items: readonly DshSessionExportItem[]): Record<string, boolean> {
  return {};
}

/** 导出方向全选：勾上所有可勾选项（export 方向恒可勾，仍按 selectable 过滤以保持一致语义）。 */
export function selectableExportSelection(items: readonly DshSessionExportItem[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const item of items) if (item.selectable) selection[item.owcId] = true;
  return selection;
}

/** 勾选集合 → owcId 列表：跟随清单顺序（后端已按 updatedAt 倒序，输出稳定），跳过不可勾选项。 */
export function selectedExportIds(items: readonly DshSessionExportItem[], selection: Record<string, boolean>): string[] {
  return items.filter((item) => item.selectable && selection[item.owcId] === true).map((item) => item.owcId);
}

/** 勾选集合 → POST /sync/sessions（direction=export）请求体（只发 owcId，后端按会话现值读取）。 */
export function sessionExportPayload(
  items: readonly DshSessionExportItem[],
  selection: Record<string, boolean>,
): { direction: "export"; items: Array<{ owcId: string }> } {
  return { direction: "export", items: selectedExportIds(items, selection).map((owcId) => ({ owcId })) };
}

/**
 * 导出报告行的事件/附件统计文案（`12 事件 · 2 附件`；附件为 0 时省略附件段）。
 * 与 `statusBadge`/`credentialBadge` 同模式返回双语串，由组件用 `t(zh, en)` 落地。
 */
export function exportCountsBadge(item: Pick<DshSessionExportAppliedItem, "eventCount" | "attachments">): { zh: string; en: string } {
  const zh = [`${item.eventCount} 事件`];
  const en = [`${item.eventCount} event(s)`];
  if (item.attachments > 0) {
    zh.push(`${item.attachments} 附件`);
    en.push(`${item.attachments} attachment(s)`);
  }
  return { zh: zh.join(" · "), en: en.join(" · ") };
}

/**
 * 导出报告行的子会话徽标（M5a）：父会话一并导出的子代理会话数。
 * 无子会话时返回 undefined（面板不渲染空徽标）；有子会话显示「子会话 n 个」。
 */
export function exportSubagentsBadge(item: Pick<DshSessionExportAppliedItem, "subagents">): { zh: string; en: string } | undefined {
  const count = item.subagents?.length ?? 0;
  if (count === 0) return undefined;
  return { zh: `子会话 ${count} 个`, en: `${count} subagent session(s)` };
}

/**
 * 导出报告行的子会话失败警示（M5a）：逐条列出失败转录的 taskId 与原因（`taskId：reason；…`）。
 * 无失败时返回 undefined（面板不渲染黄色警告行）；失败不影响父会话本身导出成功。
 */
export function exportSubagentsFailedLine(item: Pick<DshSessionExportAppliedItem, "subagentsFailed">): string | undefined {
  const failed = item.subagentsFailed ?? [];
  if (failed.length === 0) return undefined;
  return failed.map((entry) => `${entry.taskId}：${entry.reason}`).join("；");
}

/** 错误对象 → 展示文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 徽标 → className（pill 基类 + tone 修饰）。 */
function badgeClass(tone: DshBadge["tone"]): string {
  return tone === "muted" ? "pill small" : `pill small ${tone}`;
}

/** 环境状态条：路径/存在性/zstd/dsh 运行态各自独立成行，异常项加 warn 修饰。 */
function StatusBar({ status, isPending, error }: { status?: DshSyncStatus | undefined; isPending: boolean; error?: string | undefined }): ReactElement {
  const { t } = useI18n();
  if (isPending) return <p className="muted-empty">{t("正在探测 dsh 环境…", "Probing the dsh environment…")}</p>;
  if (error !== undefined) return <p className="panel-error" role="alert">{t("无法读取 dsh 同步状态：", "Unable to read dsh sync status: ")}{error}</p>;
  if (!status) return <p className="muted-empty">{t("暂无状态。", "No status yet.")}</p>;

  return (
    <div className="dsh-sync-status">
      <div className={`dsh-sync-status-item${status.dshHomeExists ? "" : " warn"}`}>
        <Icon name={status.dshHomeExists ? "check" : "alert"} size={12} />
        <span className="dsh-sync-status-label">{t("数据目录", "Data directory")}</span>
        <code className="mono dsh-sync-status-value">{status.dshHome}</code>
        {!status.dshHomeExists && <b className="dsh-sync-warn-text">{t("未检测到 dsh 数据目录", "dsh data directory not found")}</b>}
      </div>
      <div className={`dsh-sync-status-item${status.profileExists ? "" : " warn"}`}>
        <Icon name={status.profileExists ? "check" : "alert"} size={12} />
        <span className="dsh-sync-status-label">{t("profile", "profile")}</span>
        <code className="mono dsh-sync-status-value">{status.profile}</code>
        {!status.profileExists && <b className="dsh-sync-warn-text">{t("未检测到模型配置文件（cordis.patch.yml）", "Model configuration file (cordis.patch.yml) not found")}</b>}
      </div>
      {!status.zstdAvailable && (
        <div className="dsh-sync-status-item warn">
          <Icon name="alert" size={12} />
          <span className="dsh-sync-status-label">{t("zstd 不可用（需要 Node ≥22.15）", "zstd unavailable (Node ≥22.15 required)")}</span>
          <code className="mono dsh-sync-status-value">{status.nodeVersion}</code>
        </div>
      )}
      {status.dshRunning && (
        <div className="dsh-sync-status-item info">
          <Icon name="bell" size={12} />
          <span className="dsh-sync-status-label">{t("dsh 正在运行：配置写回需重启 dsh 生效", "dsh is running: written configuration applies after restarting dsh")}</span>
        </div>
      )}
    </div>
  );
}

/** 执行报告：applied/skipped 计数与列表 + warnings/unmappedFields/notes + 导出方向的备份路径与 env 清单。 */
function SyncReport({ result }: { result: DshProviderSyncResult }): ReactElement {
  const { t } = useI18n();
  const envEntries = Object.entries(result.envNeeded ?? {});
  return (
    <div className="dsh-sync-report" aria-label={t("同步结果", "Sync result")}>
      <div className="dsh-sync-report-head">
        <strong>{t("同步结果", "Sync result")}</strong>
        <span className="pill small ok">{result.applied.length} {t("项已应用", "applied")}</span>
        {result.skipped.length > 0 && <span className="pill small amber">{result.skipped.length} {t("项未执行", "skipped")}</span>}
      </div>
      {result.applied.length > 0 && (
        <ul className="dsh-sync-report-list">
          {result.applied.map((item, index) => (
            <li key={`applied-${index}-${item.key}`} className="ok">
              <Icon name="check" size={11} /> {item.key}{item.provider ? ` · ${item.provider}` : ""}{item.kind === "model" ? ` (${t("模型", "model")})` : ""}
            </li>
          ))}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <ul className="dsh-sync-report-list">
          {result.skipped.map((item, index) => (
            <li key={`skipped-${index}-${item.key}`} className="warn">
              <Icon name="alert" size={11} /> {item.key}{item.reason ? ` — ${item.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
      {result.report.warnings.length > 0 && (
        <div className="dsh-sync-note warn" role="alert">
          <strong>{t("警告", "Warnings")}</strong>
          <ul>{result.report.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </div>
      )}
      {result.report.unmappedFields.length > 0 && (
        <div className="dsh-sync-note">
          <strong>{t("未映射字段", "Unmapped fields")}</strong>
          <p className="mono">{result.report.unmappedFields.join(", ")}</p>
        </div>
      )}
      {result.backupPath && (
        <div className="dsh-sync-note">
          <strong>{t("已备份原配置", "Original configuration backed up")}</strong>
          <p className="mono">{result.backupPath}</p>
        </div>
      )}
      {envEntries.length > 0 && (
        <div className="dsh-sync-note warn">
          <strong>{t("请在 dsh 环境设置以下变量", "Set the following variables in the dsh environment")}</strong>
          <ul>
            {envEntries.map(([name, provider]) => (
              <li key={name}><code className="mono">{name}</code> → {provider}</li>
            ))}
          </ul>
        </div>
      )}
      {result.report.notes && result.report.notes.length > 0 && (
        <ul className="dsh-sync-notes">{result.report.notes.map((text, index) => <li key={index}>{text}</li>)}</ul>
      )}
    </div>
  );
}

/** 会话行：勾选框 + 短 id/本地化时间/徽标（子代理、已同步、不可选原因）+ 缺 cwd 时的行内 cwdOverride 输入。 */
function SessionRow({ item, checked, cwdInput, cwdOverride, onToggle, onCwdChange }: {
  item: DshSessionPreviewItem;
  checked: boolean;
  /** 是否显示 cwdOverride 输入（缺 cwd 且已勾选）。 */
  cwdInput: boolean;
  cwdOverride: string;
  onToggle: (dshId: string, next: boolean) => void;
  onCwdChange: (dshId: string, next: string) => void;
}): ReactElement {
  const { t } = useI18n();
  const syncedAt = item.sync === undefined ? undefined : formatTime(item.sync.lastSyncAt);
  return (
    <div className={`dsh-sync-session${item.selectable ? "" : " disabled"}`}>
      <input
        type="checkbox"
        aria-label={item.dshId}
        checked={checked}
        disabled={!item.selectable}
        onChange={(event) => onToggle(item.dshId, event.target.checked)}
      />
      <div className="dsh-sync-session-body">
        <div className="dsh-sync-item-head">
          <code className="mono dsh-sync-session-id">{shortDshId(item.dshId)}</code>
          {item.createdAt !== undefined && <small className="dsh-sync-session-time">{formatDateTime(item.createdAt)}</small>}
          {item.origin === "subagent" && <span className="pill small">{t("子代理", "Subagent")}</span>}
          {syncedAt !== undefined && <span className="pill small ok">{t("已同步", "Synced")} {syncedAt}</span>}
          {!item.selectable && item.reason !== undefined && <small className="dsh-sync-session-reason">{item.reason}</small>}
        </div>
        {isLegacyGeneration(item.generation) && (
          <small className="dsh-sync-session-gen">
            {t(`旧代际 v${item.generation}`, `Legacy generation v${item.generation}`)}
            {t("：需先在 dsh 中打开一次升级格式", ": open it once in dsh to upgrade the format")}
          </small>
        )}
        {cwdInput && (
          <label className="dsh-sync-session-cwd">
            <span>{t("选择本机工作目录", "Choose a local working directory")}</span>
            <input
              type="text"
              value={cwdOverride}
              placeholder={t("绝对路径，如 /home/me/project", "Absolute path, e.g. /home/me/project")}
              onChange={(event) => onCwdChange(item.dshId, event.target.value)}
            />
          </label>
        )}
      </div>
    </div>
  );
}

/**
 * 导出会话行：勾选框 + 标题 + `provider/model` 灰字 + 本地化更新时间 + 「已导出 HH:MM」徽标 + cwd 灰字（截断）。
 * 不分组（后端已按 updatedAt 倒序返回）；export 方向恒可勾选，无冲突单选，重复导出 = dsh 侧新副本。
 */
function ExportSessionRow({ item, checked, onToggle }: {
  item: DshSessionExportItem;
  checked: boolean;
  onToggle: (owcId: string, next: boolean) => void;
}): ReactElement {
  const { t } = useI18n();
  const model = providerModelLabel(item);
  const exportedAt = item.sync === undefined ? undefined : formatTime(item.sync.lastSyncAt);
  const updatedAt = item.updatedAt === undefined ? undefined : formatDateTime(item.updatedAt);
  return (
    <div className="dsh-sync-session">
      <input
        type="checkbox"
        aria-label={item.owcId}
        checked={checked}
        onChange={(event) => onToggle(item.owcId, event.target.checked)}
      />
      <div className="dsh-sync-session-body">
        <div className="dsh-sync-item-head">
          <strong className="dsh-sync-session-title">{item.title}</strong>
          {model !== undefined && <span className="dsh-sync-session-model mono">{model}</span>}
          {updatedAt !== undefined && <small className="dsh-sync-session-time">{updatedAt}</small>}
          {exportedAt !== undefined && <span className="pill small ok">{t("已导出", "Exported")} {exportedAt}</span>}
        </div>
        {item.cwd !== undefined && (
          <small className="mono dsh-sync-session-cwd-text" title={item.cwd}>{item.cwd}</small>
        )}
      </div>
    </div>
  );
}

/** 导入报告：applied（标题 + u/a/t 计数徽标 + 图片缺失警示）+ skipped（原因）+ 丢弃/警告/映射表汇总。 */
function SessionSyncReport({ result }: { result: DshSessionSyncResult }): ReactElement {
  const { t } = useI18n();
  const dropped = droppedEventsLine(result.report.droppedEvents);
  return (
    <div className="dsh-sync-report" aria-label={t("导入结果", "Import result")}>
      <div className="dsh-sync-report-head">
        <strong>{t("导入结果", "Import result")}</strong>
        <span className="pill small ok">{t("已导入", "Imported")} {result.report.appliedCount}</span>
        {result.report.skippedCount > 0 && <span className="pill small amber">{t("已跳过", "Skipped")} {result.report.skippedCount}</span>}
        <span className="pill small">{t("冲突策略", "Conflict policy")}: {result.report.onConflict === "overwrite" ? t("覆盖更新", "overwrite") : t("新建副本", "new copy")}</span>
      </div>
      {result.applied.length > 0 && (
        <ul className="dsh-sync-report-list">
          {result.applied.map((item, index) => (
            <li key={`applied-${index}-${item.dshId}`} className="ok">
              <Icon name="check" size={11} />
              <code className="mono dsh-sync-report-id">{shortDshId(item.dshId)}</code>
              <span className="dsh-sync-report-title">{item.title}</span>
              <span className="pill small">u {item.counts.user}</span>
              <span className="pill small">a {item.counts.assistant}</span>
              <span className="pill small">t {item.counts.tool}</span>
              {item.counts.images > 0 && <span className="pill small">{t("图片", "images")} {item.counts.images}</span>}
              {item.counts.imagesMissing > 0 && (
                <span className="pill small amber">{item.counts.imagesMissing} {t("张图片降级为占位文本", "image(s) downgraded to placeholders")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <ul className="dsh-sync-report-list">
          {result.skipped.map((item, index) => (
            <li key={`skipped-${index}-${item.dshId}`} className="warn">
              <Icon name="alert" size={11} />
              {item.dshId.length > 0 && <code className="mono dsh-sync-report-id">{shortDshId(item.dshId)}</code>}
              {item.reason}
            </li>
          ))}
        </ul>
      )}
      {dropped !== undefined && (
        <div className="dsh-sync-note">
          <strong>{t("丢弃的事件（面板不显示，仅计数）", "Dropped events (not shown in the UI, counted only)")}</strong>
          <p className="mono">{dropped}</p>
        </div>
      )}
      {result.report.warnings.length > 0 && (
        <div className="dsh-sync-note warn" role="alert">
          <strong>{t("警告", "Warnings")}</strong>
          <ul>{result.report.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </div>
      )}
      {result.report.mapSaved ? (
        <div className="dsh-sync-note">
          <strong>{t("映射表已更新（下次同步可自动找回会话）", "Mapping table updated (the next sync finds these sessions automatically)")}</strong>
          <p className="mono">{result.report.mapPath}</p>
        </div>
      ) : (
        <div className="dsh-sync-note warn" role="alert">
          <strong>{t("映射表保存失败，重复导入可能产生副本", "Failed to save the mapping table: re-importing may create duplicates")}</strong>
          <p className="mono">{result.report.mapPath}</p>
        </div>
      )}
      {result.report.notes.length > 0 && (
        <ul className="dsh-sync-notes">{result.report.notes.map((text, index) => <li key={index}>{text}</li>)}</ul>
      )}
    </div>
  );
}

/**
 * 导出报告：applied（标题 + dsh 侧短 id + 事件数/附件数 + 子会话徽标/失败警示 + warnings）
 * + skipped（原因）+ report.warnings/notes + mapSaved=false 警示。
 *
 * 服务端 applied 条目只带 owcId/dshId（无 title），标题由面板用预览清单按 owcId 反查（`titleOf`）；
 * 查不到时退回短 owcId，保证行内仍有可核对的标识。
 */
function ExportSyncReport({ result, titleOf }: {
  result: DshSessionExportResult;
  titleOf: (owcId: string) => string | undefined;
}): ReactElement {
  const { t } = useI18n();
  const label = (owcId: string): string => titleOf(owcId) ?? shortDshId(owcId);
  return (
    <div className="dsh-sync-report" aria-label={t("导出结果", "Export result")}>
      <div className="dsh-sync-report-head">
        <strong>{t("导出结果", "Export result")}</strong>
        <span className="pill small ok">{t("已导出", "Exported")} {result.report.appliedCount}</span>
        {result.report.skippedCount > 0 && <span className="pill small amber">{t("已跳过", "Skipped")} {result.report.skippedCount}</span>}
      </div>
      {result.applied.length > 0 && (
        <ul className="dsh-sync-report-list">
          {result.applied.map((item, index) => {
            const counts = exportCountsBadge(item);
            const subagents = exportSubagentsBadge(item);
            const subagentsFailed = exportSubagentsFailedLine(item);
            return (
              <li key={`applied-${index}-${item.owcId}`} className="ok">
                <Icon name="check" size={11} />
                <span className="dsh-sync-report-title">{label(item.owcId)}</span>
                <code className="mono dsh-sync-report-id">{shortDshId(item.dshId)}</code>
                <span className="pill small">{t(counts.zh, counts.en)}</span>
                {subagents !== undefined && <span className="pill small">{t(subagents.zh, subagents.en)}</span>}
                {item.warnings.length > 0 && <span className="dsh-sync-report-warn">{item.warnings.join("；")}</span>}
                {subagentsFailed !== undefined && (
                  <span className="dsh-sync-report-warn" role="alert">
                    {t(`子会话导出失败：${subagentsFailed}`, `Subagent export failed: ${subagentsFailed}`)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <ul className="dsh-sync-report-list">
          {result.skipped.map((item, index) => (
            <li key={`skipped-${index}-${item.owcId}`} className="warn">
              <Icon name="alert" size={11} />
              {item.owcId.length > 0 && <code className="mono dsh-sync-report-id">{shortDshId(item.owcId)}</code>}
              {item.reason}
            </li>
          ))}
        </ul>
      )}
      {result.report.warnings.length > 0 && (
        <div className="dsh-sync-note warn" role="alert">
          <strong>{t("警告", "Warnings")}</strong>
          <ul>{result.report.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </div>
      )}
      {result.report.mapSaved ? (
        <div className="dsh-sync-note">
          <strong>{t("映射表已更新（下次导出前面板显示已导出徽标）", "Mapping table updated (the exported badge shows on the next export)")}</strong>
          <p className="mono">{result.report.mapPath}</p>
        </div>
      ) : (
        <div className="dsh-sync-note warn" role="alert">
          <strong>{t("映射表保存失败，重复导出可能产生副本且不再显示已导出徽标", "Failed to save the mapping table: re-exporting may create duplicates and the exported badge stops updating")}</strong>
          <p className="mono">{result.report.mapPath}</p>
        </div>
      )}
      {result.report.notes.length > 0 && (
        <ul className="dsh-sync-notes">{result.report.notes.map((text, index) => <li key={index}>{text}</li>)}</ul>
      )}
    </div>
  );
}

/** dsh 同步面板：状态条 + 模型配置同步（预览/勾选/执行）+ 会话同步（导入/导出双向完整）。 */
export function DshSyncPanel(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const extensions = useExtensionsQuery();
  const enabled = extensions.data?.some((item) => item.id === DSH_SYNC_EXTENSION_ID && item.enabled) === true;

  const [direction, setDirection] = useState<DshSyncDirection>("import");
  // 请求只在用户点「预览差异」后发出；已预览过同方向时按钮改为刷新
  const [previewedDirection, setPreviewedDirection] = useState<DshSyncDirection>();
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<DshProviderSyncResult>();
  const [running, setRunning] = useState(false);

  // 会话区块独立状态：方向、预览落地标记（按方向各自记录）、导入勾选/cwdOverride/冲突策略、导出勾选、两个方向的报告
  const [sessionDirection, setSessionDirection] = useState<DshSyncDirection>("import");
  // 预览落地标记按方向独立：预览过的方向其查询一直保持挂载，切回时直接复用缓存（不重发请求）
  const [sessionPreviewed, setSessionPreviewed] = useState<Record<DshSyncDirection, boolean>>({ import: false, export: false });
  const [sessionSelection, setSessionSelection] = useState<Record<string, boolean>>({});
  const [cwdOverrides, setCwdOverrides] = useState<Record<string, string>>({});
  const [sessionConflict, setSessionConflict] = useState<DshSessionConflict>("new");
  const [sessionResult, setSessionResult] = useState<DshSessionSyncResult>();
  const [exportSelection, setExportSelection] = useState<Record<string, boolean>>({});
  const [exportResult, setExportResult] = useState<DshSessionExportResult>();
  const [sessionRunning, setSessionRunning] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["dsh-sync", "status"],
    queryFn: () => api.extRoute<DshSyncStatus>(DSH_SYNC_EXTENSION_ID, "/status"),
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  const previewQuery = useQuery({
    queryKey: ["dsh-sync", "preview", direction],
    queryFn: () => api.extRoute<DshProviderPreview>(DSH_SYNC_EXTENSION_ID, "/preview/providers", { query: { direction } }),
    enabled: enabled && previewedDirection === direction,
    staleTime: 0,
    retry: false,
  });

  // 会话清单：两个方向各自独立的查询与缓存（queryKey 含方向）。预览过即保持挂载（enabled 不再随方向切换），
  // 因此切到别的方向再切回来时直接复用缓存、不重发请求；切方向只切换展示。
  const importSessionsQuery = useQuery({
    queryKey: ["dsh-sync", "preview-sessions", "import"],
    queryFn: () => api.extRoute<DshSessionPreview>(DSH_SYNC_EXTENSION_ID, "/preview/sessions", { query: { direction: "import" } }),
    enabled: enabled && sessionPreviewed.import,
    staleTime: 0,
    retry: false,
  });

  const exportSessionsQuery = useQuery({
    queryKey: ["dsh-sync", "preview-sessions", "export"],
    queryFn: () => api.extRoute<DshSessionExportPreview>(DSH_SYNC_EXTENSION_ID, "/preview/sessions", { query: { direction: "export" } }),
    enabled: enabled && sessionPreviewed.export,
    staleTime: 0,
    retry: false,
  });

  // 切方向后旧方向的结果不显示（缓存仍在，切回后无需重新请求即可复用）
  const preview = previewedDirection === direction ? previewQuery.data : undefined;
  const items = preview?.items;

  // 预览落地（含执行后的失效重拉）即重置勾选：new 默认勾、changed 默认不勾、same 不可勾
  useEffect(() => {
    setSelection(defaultSelection(items ?? []));
  }, [items]);

  const keys = selectedKeys(items ?? [], selection);
  const previewError = previewQuery.isError ? errorText(previewQuery.error) : undefined;
  const previewing = previewedDirection === direction && previewQuery.isFetching;

  const switchDirection = (next: DshSyncDirection): void => {
    if (next === direction) return;
    setDirection(next);
    setResult(undefined);
  };

  const runPreview = (): void => {
    if (previewedDirection === direction) void previewQuery.refetch();
    else setPreviewedDirection(direction);
  };

  const execute = async (): Promise<void> => {
    if (keys.length === 0 || running) return;
    setRunning(true);
    try {
      const next = await api.extRoute<DshProviderSyncResult>(DSH_SYNC_EXTENSION_ID, "/sync/providers", {
        method: "POST",
        body: { direction, keys },
      });
      setResult(next);
      await queryClient.invalidateQueries({ queryKey: ["dsh-sync"] });
      ui.notify(`${t("同步完成", "Sync finished")}: ${next.applied.length} ${t("项已应用", "applied")}`);
    } catch (error) {
      ui.notify(errorText(error), "error");
    } finally {
      setRunning(false);
    }
  };

  // ── 会话同步：导入方向（dsh → owc） ──────────────────────────────────────
  const sessionPreview = sessionPreviewed.import ? importSessionsQuery.data : undefined;
  const sessionItems = sessionPreview?.items;
  const sessionGroups = groupSessions(sessionItems ?? []);
  const sessionIds = selectedSessionIds(sessionItems ?? [], sessionSelection);
  const selectableCount = (sessionItems ?? []).filter((item) => item.selectable).length;
  // 冲突策略只在勾选集含已同步会话时可选；无已同步勾选时一律按「新建副本」发送（避免残留 overwrite 误覆写）
  const sessionConflictVisible = hasSyncedSelection(sessionItems ?? [], sessionSelection);
  const effectiveConflict: DshSessionConflict = sessionConflictVisible ? sessionConflict : "new";
  const sessionError = importSessionsQuery.isError ? errorText(importSessionsQuery.error) : undefined;
  const sessionPreviewing = sessionPreviewed.import && importSessionsQuery.isFetching;

  // 清单落地（含执行后的失效重拉）即重置勾选与 cwdOverride：未同步过的默认勾、已同步的默认不勾
  useEffect(() => {
    setSessionSelection(defaultSessionSelection(sessionItems ?? []));
    const alive = new Set((sessionItems ?? []).map((item) => item.dshId));
    setCwdOverrides((current) => Object.fromEntries(Object.entries(current).filter(([dshId]) => alive.has(dshId))));
  }, [sessionItems]);

  // ── 会话同步：导出方向（owc → dsh） ──────────────────────────────────────
  const exportPreview = sessionPreviewed.export ? exportSessionsQuery.data : undefined;
  const exportItems = exportPreview?.items;
  const exportIds = selectedExportIds(exportItems ?? [], exportSelection);
  const exportSelectableCount = (exportItems ?? []).filter((item) => item.selectable).length;
  const exportError = exportSessionsQuery.isError ? errorText(exportSessionsQuery.error) : undefined;
  const exportPreviewing = sessionPreviewed.export && exportSessionsQuery.isFetching;
  // 报告按 owcId 反查标题：applied/skipped 条目只带 id
  const exportTitleById = new Map((exportItems ?? []).map((item) => [item.owcId, item.title]));

  // 导出清单落地（含执行后的失效重拉）即重置勾选：默认不勾，交由用户显式选择
  useEffect(() => {
    setExportSelection(defaultExportSelection(exportItems ?? []));
  }, [exportItems]);

  /** 当前方向对应的会话查询（预览按钮的加载态与执行后的刷新都取它）。 */
  const currentSessionsQuery = sessionDirection === "import" ? importSessionsQuery : exportSessionsQuery;

  // 切方向只切换展示：两个方向的预览缓存、勾选与报告都保留（不清空对方结果）
  const switchSessionDirection = (next: DshSyncDirection): void => {
    if (next === sessionDirection) return;
    setSessionDirection(next);
  };

  const runSessionPreview = (): void => {
    if (sessionPreviewed[sessionDirection]) void currentSessionsQuery.refetch();
    else setSessionPreviewed((current) => ({ ...current, [sessionDirection]: true }));
  };

  const runSessionImport = async (): Promise<void> => {
    if (sessionIds.length === 0 || sessionRunning) return;
    setSessionRunning(true);
    try {
      const next = await api.extRoute<DshSessionSyncResult>(DSH_SYNC_EXTENSION_ID, "/sync/sessions", {
        method: "POST",
        body: sessionSyncPayload(sessionItems ?? [], sessionSelection, cwdOverrides, effectiveConflict),
      });
      setSessionResult(next);
      // 只刷新导入方向的预览：让「已同步」徽标更新，不影响导出方向的缓存
      await queryClient.invalidateQueries({ queryKey: ["dsh-sync", "preview-sessions", "import"] });
      ui.notify(`${t("导入完成", "Import finished")}: ${next.report.appliedCount} ${t("个会话已导入", "session(s) imported")}`);
    } catch (error) {
      ui.notify(errorText(error), "error");
    } finally {
      setSessionRunning(false);
    }
  };

  const runSessionExport = async (): Promise<void> => {
    if (exportIds.length === 0 || sessionRunning) return;
    setSessionRunning(true);
    try {
      const next = await api.extRoute<DshSessionExportResult>(DSH_SYNC_EXTENSION_ID, "/sync/sessions", {
        method: "POST",
        body: sessionExportPayload(exportItems ?? [], exportSelection),
      });
      setExportResult(next);
      // 只刷新导出方向的预览：让「已导出」徽标更新，不影响导入方向的缓存
      await queryClient.invalidateQueries({ queryKey: ["dsh-sync", "preview-sessions", "export"] });
      ui.notify(`${t("导出完成", "Export finished")}: ${next.report.appliedCount} ${t("个会话已导出", "session(s) exported")}`);
    } catch (error) {
      ui.notify(errorText(error), "error");
    } finally {
      setSessionRunning(false);
    }
  };

  const toggleSession = (dshId: string, next: boolean): void => {
    setSessionSelection((current) => ({ ...current, [dshId]: next }));
  };

  const toggleExport = (owcId: string, next: boolean): void => {
    setExportSelection((current) => ({ ...current, [owcId]: next }));
  };

  const changeCwdOverride = (dshId: string, next: string): void => {
    setCwdOverrides((current) => ({ ...current, [dshId]: next }));
  };

  if (!enabled) {
    return (
      <div className="inspector-body dsh-sync-panel">
        <p className="muted-empty" role="status">{t("请在 设置 → 扩展 启用 dsh 同步。", "Enable dsh Sync in Settings → Extensions.")}</p>
      </div>
    );
  }

  return (
    <div className="inspector-body dsh-sync-panel">
      <div className="panel-head">
        <div>
          <h2>{t("dsh 同步", "dsh Sync")}</h2>
          <p className="muted-empty">{t("与 dsh（DeepSeek Harness）数据目录手动同步：模型配置双向差异预览，会话从 dsh 按工作目录分组导入、或导出为 dsh 新会话。", "Manual sync with the dsh (DeepSeek Harness) data directory: two-way diff for model configuration, batch import of sessions grouped by working directory, or export owc sessions as new dsh sessions.")}</p>
        </div>
        <button className="btn small" disabled={statusQuery.isFetching} onClick={() => void statusQuery.refetch()}>
          {statusQuery.isFetching ? t("探测中…", "Probing…") : t("重新探测", "Re-probe")}
        </button>
      </div>

      <section className="dsh-sync-section" aria-label={t("环境状态", "Environment status")}>
        <h3>{t("环境状态", "Environment status")}</h3>
        <StatusBar status={statusQuery.data} isPending={statusQuery.isPending} error={statusQuery.isError ? errorText(statusQuery.error) : undefined} />
      </section>

      <section className="dsh-sync-section" aria-label={t("模型配置同步", "Model configuration sync")}>
        <div className="dsh-sync-section-head">
          <h3>{t("模型配置同步", "Model configuration sync")}</h3>
          <div className="dsh-sync-actions">
            <div className="dsh-sync-direction" role="group" aria-label={t("同步方向", "Sync direction")}>
              <button className={direction === "import" ? "active" : ""} aria-pressed={direction === "import"} onClick={() => switchDirection("import")}>
                <Icon name="arrow-down" size={12} />{t("从 dsh 导入", "Import from dsh")}
              </button>
              <button className={direction === "export" ? "active" : ""} aria-pressed={direction === "export"} onClick={() => switchDirection("export")}>
                <Icon name="arrow-up" size={12} />{t("导出到 dsh", "Export to dsh")}
              </button>
            </div>
            <button className="btn small" disabled={previewQuery.isFetching} onClick={runPreview}>
              {previewQuery.isFetching ? t("预览中…", "Previewing…") : t("预览差异", "Preview diff")}
            </button>
          </div>
        </div>

        {previewError !== undefined && <p className="panel-error" role="alert">{t("无法预览差异：", "Unable to preview diff: ")}{previewError}</p>}
        {preview?.warning && <p className="dsh-sync-note warn" role="alert">{preview.warning}</p>}
        {preview?.dshRunning && <p className="dsh-sync-note info">{t("dsh 正在运行：写回配置后需重启 dsh 生效。", "dsh is running: restart dsh after writing configuration.")}</p>}

        {items === undefined && previewError === undefined && (
          previewing
            ? <p className="muted-empty">{t("正在读取 dsh 配置…", "Reading the dsh configuration…")}</p>
            : <p className="muted-empty">{t("点击「预览差异」读取 dsh 侧配置并与 owc 比较。", "Click “Preview diff” to read the dsh side and compare it with owc.")}</p>
        )}
        {items?.length === 0 && <p className="muted-empty">{t("没有可同步的服务商配置。", "No provider configuration to sync.")}</p>}

        {items && items.length > 0 && (
          <div className="dsh-sync-list">
            {items.map((item) => {
              const badge = statusBadge(item.status);
              const credential = credentialBadge(item.credential);
              return (
                // 条目为 div 而非 label：差异明细的 <summary> 若嵌在 label 内，点开明细会顺带切换勾选
                <div key={item.key} className={`dsh-sync-item ${item.status}`}>
                  <input
                    type="checkbox"
                    aria-label={item.key}
                    checked={selection[item.key] === true}
                    disabled={!isSelectable(item)}
                    onChange={(event) => setSelection((current) => ({ ...current, [item.key]: event.target.checked }))}
                  />
                  <div className="dsh-sync-item-body">
                    <div className="dsh-sync-item-head">
                      <strong className="mono">{item.key}</strong>
                      <span className={badgeClass(badge.tone)}>{t(badge.zh, badge.en)}</span>
                      {credential && <span className={badgeClass(credential.tone)}>{t(credential.zh, credential.en)}</span>}
                      {item.apiKeyEnv && <code className="mono dsh-sync-item-env">{item.apiKeyEnv}</code>}
                    </div>
                    {item.models !== undefined && item.models > 0 && (
                      <small>{item.models} {t("条模型目录条目", "catalog model(s)")}</small>
                    )}
                    {item.changes && item.changes.length > 0 && (
                      <details className="dsh-sync-changes">
                        <summary>{t("差异明细", "Field changes")} ({item.changes.length})</summary>
                        <ul>{item.changes.map((change) => <li key={change.field} className="mono">{changeLine(change)}</li>)}</ul>
                      </details>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {preview && preview.unmappedFields.length > 0 && (
          <p className="dsh-sync-note">{t("未映射字段（不会同步）", "Unmapped fields (not synced)")}: <span className="mono">{preview.unmappedFields.join(", ")}</span></p>
        )}
        {preview && preview.warnings.length > 0 && (
          <div className="dsh-sync-note warn">
            <strong>{t("警告", "Warnings")}</strong>
            <ul>{preview.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul>
          </div>
        )}

        <div className="dsh-sync-footer">
          <span className="muted-empty">{t("已勾选", "Selected")} {keys.length} / {items?.length ?? 0}</span>
          <button className="btn primary small" disabled={keys.length === 0 || running} onClick={() => void execute()}>
            {running ? t("同步中…", "Syncing…") : t("执行同步", "Run sync")}
          </button>
        </div>

        {result && <SyncReport result={result} />}
      </section>

      <section className="dsh-sync-section" aria-label={t("会话同步", "Session sync")}>
        <div className="dsh-sync-section-head">
          <h3>{t("会话同步", "Session sync")}</h3>
          <div className="dsh-sync-actions">
            <div className="dsh-sync-direction" role="group" aria-label={t("会话同步方向", "Session sync direction")}>
              <button className={sessionDirection === "import" ? "active" : ""} aria-pressed={sessionDirection === "import"} onClick={() => switchSessionDirection("import")}>
                <Icon name="arrow-down" size={12} />{t("从 dsh 导入", "Import from dsh")}
              </button>
              <button className={sessionDirection === "export" ? "active" : ""} aria-pressed={sessionDirection === "export"} onClick={() => switchSessionDirection("export")}>
                <Icon name="arrow-up" size={12} />{t("导出到 dsh", "Export to dsh")}
              </button>
            </div>
            <button className="btn small" disabled={currentSessionsQuery.isFetching} onClick={runSessionPreview}>
              {currentSessionsQuery.isFetching ? t("预览中…", "Previewing…") : t("预览会话", "Preview sessions")}
            </button>
          </div>
        </div>

        {sessionDirection === "import" && (
          <>
            {sessionError !== undefined && <p className="panel-error" role="alert">{t("无法预览会话：", "Unable to preview sessions: ")}{sessionError}</p>}
            {sessionPreview?.warning && <p className="dsh-sync-note warn" role="alert">{sessionPreview.warning}</p>}

            {sessionItems === undefined && sessionError === undefined && (
              sessionPreviewing
                ? <p className="muted-empty">{t("正在读取 dsh 会话…", "Reading dsh sessions…")}</p>
                : <p className="muted-empty">{t("点击「预览会话」列出 dsh 侧的会话。", "Click “Preview sessions” to list dsh-side sessions.")}</p>
            )}
            {sessionItems?.length === 0 && <p className="muted-empty">{t("没有可导入的 dsh 会话。", "No dsh session to import.")}</p>}

            {sessionItems && sessionItems.length > 0 && (
              <>
                <div className="dsh-sync-session-tools">
                  <button className="btn small" onClick={() => setSessionSelection(selectableSessionSelection(sessionItems))}>
                    {t("全选", "Select all")}
                  </button>
                  <button className="btn small" disabled={sessionIds.length === 0} onClick={() => setSessionSelection({})}>
                    {t("清空", "Clear")}
                  </button>
                  <span className="muted-empty">{t("已选", "Selected")} {sessionIds.length} / {selectableCount} {t("个会话", "sessions")}</span>
                </div>

                {sessionGroups.map((group) => (
                  // 组头可折叠（原生 details，默认展开）：cwd 相同的会话一起管理
                  <details key={group.cwd ?? "/no-cwd"} className="dsh-sync-session-group" open>
                    <summary>
                      <Icon name="folder" size={12} />
                      <code className="mono">{group.cwd ?? t("无工作目录", "No working directory")}</code>
                      <span className="pill small">{group.items.length}</span>
                    </summary>
                    <div className="dsh-sync-session-rows">
                      {group.items.map((item) => (
                        <SessionRow
                          key={item.dshId}
                          item={item}
                          checked={sessionSelection[item.dshId] === true}
                          cwdInput={item.cwd === undefined && sessionSelection[item.dshId] === true}
                          cwdOverride={cwdOverrides[item.dshId] ?? ""}
                          onToggle={toggleSession}
                          onCwdChange={changeCwdOverride}
                        />
                      ))}
                    </div>
                  </details>
                ))}

                {sessionConflictVisible && (
                  <div className="dsh-sync-session-conflict" role="radiogroup" aria-label={t("冲突处理", "Conflict handling")}>
                    <label>
                      <input type="radio" name="dsh-sync-session-conflict" checked={sessionConflict === "overwrite"} onChange={() => setSessionConflict("overwrite")} />
                      {t("覆盖更新已导入的会话", "Overwrite the imported session")}
                    </label>
                    <label>
                      <input type="radio" name="dsh-sync-session-conflict" checked={sessionConflict === "new"} onChange={() => setSessionConflict("new")} />
                      {t("新建副本", "Create a copy")}
                    </label>
                  </div>
                )}

                <div className="dsh-sync-footer">
                  <span className="muted-empty">{t("导入会新建 owc 会话（默认勾选未同步过的会话）", "Importing creates owc sessions (unsynced sessions are selected by default)")}</span>
                  <button className="btn primary small" disabled={sessionIds.length === 0 || sessionRunning} onClick={() => void runSessionImport()}>
                    {sessionRunning ? t("导入中…", "Importing…") : t("执行导入", "Run import")}
                  </button>
                </div>
              </>
            )}

            {sessionResult && <SessionSyncReport result={sessionResult} />}
          </>
        )}

        {sessionDirection === "export" && (
          <>
            {exportError !== undefined && <p className="panel-error" role="alert">{t("无法预览会话：", "Unable to preview sessions: ")}{exportError}</p>}
            {exportPreview?.warning && <p className="dsh-sync-note warn" role="alert">{exportPreview.warning}</p>}

            {exportItems === undefined && exportError === undefined && (
              exportPreviewing
                ? <p className="muted-empty">{t("正在读取 owc 会话…", "Reading owc sessions…")}</p>
                : <p className="muted-empty">{t("点击「预览会话」列出 owc 侧的会话。", "Click “Preview sessions” to list owc-side sessions.")}</p>
            )}
            {exportItems?.length === 0 && <p className="muted-empty">{t("没有可导出的 owc 会话。", "No owc session to export.")}</p>}

            {exportItems && exportItems.length > 0 && (
              <>
                <div className="dsh-sync-session-tools">
                  <button className="btn small" onClick={() => setExportSelection(selectableExportSelection(exportItems))}>
                    {t("全选", "Select all")}
                  </button>
                  <button className="btn small" disabled={exportIds.length === 0} onClick={() => setExportSelection({})}>
                    {t("清空", "Clear")}
                  </button>
                  <span className="muted-empty">{t("已选", "Selected")} {exportIds.length} / {exportSelectableCount} {t("个会话", "sessions")}</span>
                </div>

                <div className="dsh-sync-list">
                  {exportItems.map((item) => (
                    <ExportSessionRow
                      key={item.owcId}
                      item={item}
                      checked={exportSelection[item.owcId] === true}
                      onToggle={toggleExport}
                    />
                  ))}
                </div>

                <div className="dsh-sync-footer">
                  <span className="muted-empty">{t("导出会在 dsh 数据目录新建会话（重复导出 = 新副本，不影响已有会话）", "Exporting creates sessions in the dsh data directory (re-exporting makes a copy; existing sessions are untouched)")}</span>
                  <button className="btn primary small" disabled={exportIds.length === 0 || sessionRunning} onClick={() => void runSessionExport()}>
                    {sessionRunning ? t("导出中…", "Exporting…") : t("执行导出", "Run export")}
                  </button>
                </div>
              </>
            )}

            {exportResult && <ExportSyncReport result={exportResult} titleOf={(owcId) => exportTitleById.get(owcId)} />}
          </>
        )}
      </section>
    </div>
  );
}
