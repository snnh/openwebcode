/**
 * dsh-sync 扩展：Extension Host 侧的官方扩展实现（status / 模型配置与会话的双向同步私有路由）。
 *
 * 分工：数据发现与 patch 改写读写在 {@link ./dsh-sync-dsh.js}（纯函数层），字段映射与 diff 在
 * {@link ./dsh-sync-providers.js}（纯函数层），会话导入转换在 {@link ./dsh-sync-session.js}、
 * 会话导出写出在 {@link ./dsh-sync-export.js}；本模块只做「配置归一 + 探测聚合 + 路由编排 +
 * server 能力调用」，因此可独立单测（不起 host 进程）。
 *
 * 本模块 **不 import extension-host-process**（该文件静态 import 本模块，反向引用会成环）：
 * server 能力经 {@link DshSyncServerApi} 工厂参数注入，由它调 {@link createDshSyncRoutes} 接线。
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import type { ChatMessage } from "../sessions/types.js";
import {
  backupFile,
  decodeDshSessionFile,
  dshPatchFile,
  probeDshRunning,
  readDshProviders,
  replaceDshProviders,
  resolveDshHome,
  resolveDshProfile,
  scanDshSessions,
  zstdAvailable,
  DSH_SYNC_SUPPORTED_GENERATION,
  type DshSessionEntry,
  type DshSyncConfig,
} from "./dsh-sync-dsh.js";
import {
  DSH_SYNC_MAP_PATH,
  emptySyncMap,
  findByDshId,
  findByOwcId,
  loadSyncMap,
  recordSync,
  saveSyncMap,
  type DshSyncMap,
  type DshSyncStorageApi,
} from "./dsh-sync-map.js";
import { convertDshSession, type ConversionCounts } from "./dsh-sync-session.js";
import {
  attachSubagentTasks,
  nestSubagentSessions,
  transcriptExportInput,
  transcriptTaskIdsOf,
} from "./dsh-sync-subagents.js";
import {
  writeDshSession,
  type DshExportLedgerCompacted,
} from "./dsh-sync-export.js";
import {
  diffProviderItems,
  dshProvidersToOwc,
  owcProfilesToDsh,
  type DshCredentialState,
  type DshExportCredentialState,
  type OwcModelEntry,
  type ProviderDiffItem,
  type ProviderDirection,
} from "./dsh-sync-providers.js";

/** 路由请求载荷（与 Extension Host 的 RouteHandler 入参结构一致，类型本地定义以避免成环）。 */
interface DshSyncRouteRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body?: unknown;
}

/** 路由应答（host 侧按 status/body 归一，status 缺省 200）。 */
interface DshSyncRouteResponse {
  status: number;
  body?: unknown;
}

/** 路由处理器签名（与 Extension Host 的 RouteHandler 兼容）。 */
export type DshSyncRouteHandler = (
  request: DshSyncRouteRequest,
  config: Record<string, unknown>,
) => Promise<DshSyncRouteResponse>;

/**
 * status 路由结果：只暴露探测结论，不含会话/模型内容（私有路由也是弱权限信息面）。
 */
export interface DshSyncStatus {
  /** dsh 数据目录绝对路径（`~` 已展开）。 */
  dshHome: string;
  /** dshHome 是否为已存在目录。 */
  dshHomeExists: boolean;
  /** profile 名。 */
  profile: string;
  /** `<dshHome>/profiles/<profile>/cordis.patch.yml` 是否为已存在文件。 */
  profileExists: boolean;
  /** node:zlib 是否具备 zstd 解压能力（旧版 Node 读不了压缩会话）。 */
  zstdAvailable: boolean;
  /** dsh 是否在监听默认端口（TCP 连通探测）。 */
  dshRunning: boolean;
  /** Extension Host 所在 Node 版本（诊断用）。 */
  nodeVersion: string;
}

/** 扩展配置 → 发现层的可选配置（只接受字符串字段，其余按缺省处理）。 */
function asDshConfig(config: Record<string, unknown>): DshSyncConfig {
  const dshHome = config.dshHome;
  const profile = config.profile;
  return {
    ...(typeof dshHome === "string" ? { dshHome } : {}),
    ...(typeof profile === "string" ? { profile } : {}),
  };
}

/** 目标是否为目录（不存在/无权限一律 false，不抛错）。 */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** 目标是否为文件（不存在/无权限一律 false，不抛错）。 */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * 汇总 dsh-sync 运行环境状态：路径解析（纯计算）+ 存在性探测 + zstd 能力 + dsh 端口探测。
 * 探测全部并行且各自吞错，任何一项失败都不影响其它字段（配置错目录只体现为 exists=false）。
 * @param config - 扩展配置（`dshHome` 缺省 `~/.dsh`、`profile` 缺省 `web`）。
 * @returns 状态快照。
 */
export async function getDshSyncStatus(config: Record<string, unknown>): Promise<DshSyncStatus> {
  const dshConfig = asDshConfig(config);
  const dshHome = resolveDshHome(dshConfig);
  const profile = resolveDshProfile(dshConfig);
  const [dshHomeExists, profileExists, dshRunning] = await Promise.all([
    isDirectory(dshHome),
    isFile(dshPatchFile(dshHome, profile)),
    probeDshRunning(),
  ]);
  return {
    dshHome,
    dshHomeExists,
    profile,
    profileExists,
    zstdAvailable: zstdAvailable(),
    dshRunning,
    nodeVersion: process.version,
  };
}

/**
 * server 能力（工厂注入，便于单测用假实现替换；生产由 extension-host-process 经 callApi 接线）。
 *
 * 存储子集（storageRead/storageWrite/storageDelete）形状与 {@link DshSyncStorageApi} 一致
 * （后者声明在 dsh-sync-map.ts，供映射表模块复用，避免两侧互相 import）。
 */
export interface DshSyncServerApi extends DshSyncStorageApi {
  /** 模型服务商配置（脱敏视图，`hasApiKey`）。 */
  listProfiles(): Promise<Array<Record<string, unknown>>>;
  /** 逐项 upsert：profiles 走 ProviderProfilesService，models 走模型目录 manual 层。 */
  upsertProfiles(input: { profiles: unknown[]; models?: unknown[] }): Promise<unknown>;
  /**
   * 会话导入（`sessions.import`）：结构化入参由 server 侧组装 transfer 文本（M3b），
   * 缺 provider/model 时 server 按当前默认补全；`replaceId` 存在即覆盖目标会话历史。
   */
  importSession(input: {
    meta: Record<string, unknown>;
    messages: unknown[];
    replaceId?: string;
    ledger?: Record<string, unknown>;
    /** 子代理转录（M5a）：逐项落 `<sessionDir>/subagents/<taskId>.json`，服务端逐项 try。 */
    subagents?: Array<{ taskId: string; data: Record<string, unknown> }>;
  }): Promise<Record<string, unknown>>;
  /** 会话清单（`sessions.list`，meta 白名单含 id/title/cwd/provider/model/createdAt/updatedAt）。 */
  listSessions(): Promise<Array<Record<string, unknown>>>;
  /** 单个会话（`sessions.get`：meta 白名单 + `messages`）。 */
  getSession(id: string): Promise<Record<string, unknown>>;
  /** 单个会话的上下文账本（`sessions.getLedger`，全量账本，含 `compacted`/`compactionHistory`）。 */
  getLedger(id: string): Promise<Record<string, unknown>>;
  /**
   * 子代理转录（`sessions.getSubagent`，M5a）：读 `<sessionDir>/subagents/<taskId>.json`；
   * 转录不存在返回 null（导出方向据此报「缺失」而不是整体失败）。
   */
  getSubagent(sessionId: string, taskId: string): Promise<Record<string, unknown> | null>;
  /**
   * 默认模型解析（`models.defaultSelection`）：导出方向补全会话缺失的 provider/model 用。
   *
   * 给了 `provider` → 只解析该 provider 的目录默认模型（`provider` 原样回传，`model` 可能为空串）；
   * 未给 → 返回 owc 当前默认选择（settings 默认模型 → 首个已配置服务商/目录首模型），解析不出来时
   * 两个字段都缺省。**只回元信息**（不含凭据/接口地址），故与 `models.getCapabilities` 同档私有。
   */
  defaultSelection(provider?: string): Promise<{ provider?: string; model?: string }>;
}

/** 未接线的 server API 兜底：只服务 manifest↔路由键集合一致性断言，真正调用时立即报错。 */
function unavailableApi(): DshSyncServerApi {
  const fail = (): never => {
    throw new Error("DshSyncServerApi is not wired in this process");
  };
  return {
    listProfiles: fail,
    upsertProfiles: fail,
    importSession: fail,
    listSessions: fail,
    getSession: fail,
    getLedger: fail,
    getSubagent: fail,
    defaultSelection: fail,
    storageRead: fail,
    storageWrite: fail,
    storageDelete: fail,
  };
}

/** 逐项执行结论（applied/skipped 的条目形状）。 */
interface DshSyncItemResult {
  key: string;
  /** profile=服务商配置；model=模型目录条目。 */
  kind: "profile" | "model";
  provider?: string;
  /** 未执行原因（skipped 项）。 */
  reason?: string;
}

/** 预览路由应答体（GET /preview/providers）。 */
export interface DshSyncProviderPreview {
  direction: ProviderDirection;
  items: Array<ProviderDiffItem & { credential?: DshCredentialState | DshExportCredentialState; apiKeyEnv?: string; models?: number }>;
  dshRunning: boolean;
  patchFile: string;
  unmappedFields: string[];
  warnings: string[];
  /** 模型目录条目（import 方向）；export 方向不做模型目录导出，恒为空数组。 */
  models: OwcModelEntry[];
  /** dsh 侧配置文件缺失等导致的降级说明（有值时 items 可能为空，不视为错误）。 */
  warning?: string;
  /** export 方向：需在 dsh 环境设置的变量（envName → profile id）。 */
  envNeeded?: Record<string, string>;
}

/** 执行路由应答体（POST /sync/providers）。 */
export interface DshSyncProviderResult {
  direction: ProviderDirection;
  applied: DshSyncItemResult[];
  skipped: DshSyncItemResult[];
  report: {
    patchFile: string;
    dshRunning: boolean;
    unmappedFields: string[];
    warnings: string[];
    notes: string[];
    credentials?: Record<string, string>;
  };
  /** export 方向：写盘前的备份文件路径（配置文件不存在时无）。 */
  backupPath?: string;
  /** export 方向：需在 dsh 环境设置的变量（envName → profile id）。 */
  envNeeded?: Record<string, string>;
}

/** 解析方向参数（缺省 import）。 */
function resolveDirection(value: unknown): ProviderDirection {
  return value === "export" ? "export" : "import";
}

/** 请求体收窄为普通对象（非法/缺失返回空对象）。 */
function asBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 按 id 建索引（非对象/缺 id 的条目跳过）。 */
function byId(entries: Array<Record<string, unknown>>): Record<string, unknown> {
  const indexed: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id) indexed[entry.id] = entry;
  }
  return indexed;
}

/** 索引已归一形状的 patch/条目列表（供 diff 使用）。 */
function byKey(entries: Array<{ id: string }>): Record<string, unknown> {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry]));
}

/** 取 export 映射结果中某 provider 的 apiKeyEnv 引用名（无凭据引用时为 undefined）。 */
function exportEnvName(entry: unknown): string | undefined {
  const raw = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
  return typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : undefined;
}

/** 调 server 能力并吞错：失败时返回错误文本（预览降级用，不阻断另一侧信息）。 */
async function tryServerCall<T>(call: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await call() };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `GET /preview/providers`：模型配置差异预览。
 *
 * import：读 dsh patch.yml 的 providers → 映射为 owc patch → 与 owc 侧现有 profile 逐字段比较；
 * export：owc 脱敏 profile → 映射为 dsh 条目 → 与 dsh 侧现有 route 逐字段比较。
 * dshHome/patch 缺失时返回 `{items: [], warning}` 而非抛错（面板据此提示「先设置 dsh 目录」）。
 */
async function previewProviders(
  request: DshSyncRouteRequest,
  config: Record<string, unknown>,
  api: DshSyncServerApi,
): Promise<DshSyncProviderPreview> {
  const direction = resolveDirection(request.query.direction);
  const dshHome = resolveDshHome(asDshConfig(config));
  const profile = resolveDshProfile(asDshConfig(config));
  const patchFile = dshPatchFile(dshHome, profile);
  const [dshRunning, existingDsh] = await Promise.all([probeDshRunning(), readDshProviders(patchFile)]);
  const base: Omit<DshSyncProviderPreview, "items" | "unmappedFields" | "warnings" | "models"> = {
    direction,
    dshRunning,
    patchFile,
  };

  if (direction === "import") {
    if (existingDsh === undefined) {
      return {
        ...base,
        items: [],
        models: [],
        unmappedFields: [],
        warnings: [],
        warning: `未在 ${patchFile} 找到 llm-service-lite 的 providers 配置：请确认 dsh 数据目录与 profile`,
      };
    }
    const mapped = dshProvidersToOwc(existingDsh, process.env);
    const owcSide = await tryServerCall(api.listProfiles);
    const warnings = [...mapped.warnings];
    if (owcSide.error !== undefined) warnings.push(`读取 owc 模型服务商配置失败：${owcSide.error}`);
    const items = diffProviderItems(byKey(mapped.profiles), byId(owcSide.value ?? []), "import").map((item) => {
      const credential = mapped.credentials[item.key];
      return {
        ...item,
        ...(credential !== undefined ? { credential } : {}),
        // 该 provider 会一并导入多少条模型目录条目（勾选粒度是 provider）。
        models: mapped.models.filter((model) => model.provider === item.key).length,
      };
    });
    return { ...base, items, models: mapped.models, unmappedFields: mapped.unmappedFields, warnings };
  }

  const owcSide = await tryServerCall(api.listProfiles);
  if (owcSide.value === undefined) {
    return {
      ...base,
      items: [],
      models: [],
      unmappedFields: [],
      warnings: [],
      envNeeded: {},
      warning: `读取 owc 模型服务商配置失败：${owcSide.error ?? "未知错误"}`,
    };
  }
  const mapped = owcProfilesToDsh(owcSide.value);
  const items = diffProviderItems(existingDsh ?? {}, mapped.providers, "export").map((item) => {
    const credential = mapped.credentials[item.key];
    const apiKeyEnv = exportEnvName(mapped.providers[item.key]);
    return {
      ...item,
      ...(credential !== undefined ? { credential } : {}),
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    };
  });
  return { ...base, items, models: [], unmappedFields: mapped.unmappedFields, warnings: mapped.warnings, envNeeded: mapped.envNeeded };
}

/** 依 server 逐项结论拆出 applied/skipped（结果形状宽松解析，缺项按未执行处理）。 */
function splitResults(value: unknown, kind: "profile" | "model"): { applied: DshSyncItemResult[]; skipped: DshSyncItemResult[] } {
  const applied: DshSyncItemResult[] = [];
  const skipped: DshSyncItemResult[] = [];
  const container = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = Array.isArray(container[kind === "profile" ? "profiles" : "models"])
    ? container[kind === "profile" ? "profiles" : "models"] as unknown[]
    : [];
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const key = typeof entry.id === "string" ? entry.id : "";
    if (!key) continue;
    const provider = typeof entry.provider === "string" ? entry.provider : undefined;
    if (entry.ok === true) applied.push({ key, kind, ...(provider ? { provider } : {}) });
    else skipped.push({ key, kind, ...(provider ? { provider } : {}), reason: typeof entry.error === "string" ? entry.error : "服务端未接受该项" });
  }
  return { applied, skipped };
}

/** import 方向执行：把勾选的 dsh provider（含其模型条目）upsert 进 owc。 */
async function syncProvidersImport(
  api: DshSyncServerApi,
  patchFile: string,
  dshProviders: Record<string, unknown>,
  keys: string[],
  modelIds: string[] | undefined,
  dshRunning: boolean,
): Promise<{ applied: DshSyncItemResult[]; skipped: DshSyncItemResult[]; report: DshSyncProviderResult["report"] }> {
  const mapped = dshProvidersToOwc(dshProviders, process.env);
  const selected = new Set(keys.filter((key) => mapped.profiles.some((profile) => profile.id === key)));
  const profiles = mapped.profiles.filter((profile) => selected.has(profile.id));
  const models = mapped.models.filter((model) => selected.has(model.provider) && (modelIds === undefined || modelIds.includes(model.id)));
  const skipped: DshSyncItemResult[] = [];
  for (const profile of mapped.profiles) {
    if (!selected.has(profile.id)) skipped.push({ key: profile.id, kind: "profile", reason: "未勾选" });
  }
  for (const model of mapped.models) {
    if (!selected.has(model.provider)) continue;      // 所属 provider 未勾选：连同条目一起不导入
    if (models.includes(model)) continue;
    skipped.push({ key: model.id, kind: "model", provider: model.provider, reason: "未勾选" });
  }

  const result = profiles.length === 0 && models.length === 0
    ? undefined
    : await api.upsertProfiles({ profiles, models });
  const profileResults = splitResults(result, "profile");
  const modelResults = splitResults(result, "model");
  return {
    applied: [...profileResults.applied, ...modelResults.applied],
    skipped: [...profileResults.skipped, ...modelResults.skipped, ...skipped],
    report: {
      patchFile,
      dshRunning,
      unmappedFields: mapped.unmappedFields,
      warnings: mapped.warnings,
      notes: [
        "import 方向：dsh 侧 apiKeyEnv 在当前环境已解析的条目内联为 owc apiKey，未解析的留空待补填。",
        "模型目录写入 owc manual 层（models.manual.json）；同 (provider, 模型 id) 会被覆盖。",
      ],
      credentials: mapped.credentials,
    },
  };
}

/** export 方向执行：把勾选的 owc profile 合并写回 patch.yml（整字典替换前先备份）。 */
async function syncProvidersExport(
  api: DshSyncServerApi,
  patchFile: string,
  dshProviders: Record<string, unknown> | undefined,
  keys: string[],
  dshRunning: boolean,
): Promise<{ applied: DshSyncItemResult[]; skipped: DshSyncItemResult[]; report: DshSyncProviderResult["report"]; backupPath?: string; envNeeded: Record<string, string> }> {
  const owcSide = await api.listProfiles();
  const mapped = owcProfilesToDsh(owcSide);
  const selected = keys.filter((key) => mapped.providers[key] !== undefined);
  const skipped: DshSyncItemResult[] = keys
    .filter((key) => mapped.providers[key] === undefined)
    .map((key) => ({ key, kind: "profile" as const, reason: "owc 侧不存在该配置" }));
  // 合并语义：replaceDshProviders 是整字典替换，因此先把 dsh 现有字典读进来，
  // 勾选项覆盖同 key，未勾选的既有 key 原样保留（不隐式删除用户配置）。
  for (const key of Object.keys(dshProviders ?? {})) {
    if (!selected.includes(key)) skipped.push({ key, kind: "profile", reason: "未勾选（保留 dsh 既有配置）" });
  }
  const merged: Record<string, unknown> = { ...(dshProviders ?? {}) };
  for (const key of selected) merged[key] = mapped.providers[key];

  const exists = await isFile(patchFile);
  const backupPath = exists ? await backupFile(patchFile) : undefined;
  const current = exists ? await readFile(patchFile, "utf8") : "";
  await mkdir(path.dirname(patchFile), { recursive: true });
  await writeUtf8Atomically(patchFile, replaceDshProviders(current, merged));

  const notes = [
    "export 方向：凭据只写 apiKeyEnv 引用（不写明文），需在 dsh 环境按 envNeeded 设置对应变量。",
    "owc 模型目录不导出：owc 的目录是独立 catalog，不挂在 profile 上，脱敏视图也无法还原 dsh models[] 全字段。",
  ];
  if (dshRunning) notes.push("检测到 dsh 正在运行：patch.yml 改动需重启 dsh 生效；请避免在 dsh 设置页保存同一区块以免被覆盖。");
  return {
    applied: selected.map((key) => ({ key, kind: "profile" as const })),
    skipped,
    report: {
      patchFile,
      dshRunning,
      unmappedFields: mapped.unmappedFields,
      warnings: mapped.warnings,
      notes,
      credentials: mapped.credentials,
    },
    ...(backupPath !== undefined ? { backupPath } : {}),
    envNeeded: mapped.envNeeded,
  };
}

/**
 * `POST /sync/providers`：执行勾选集合，返回 `{applied, skipped, report, backupPath?, envNeeded?}`。
 * body：`{direction: "import"|"export", keys: string[], models?: string[]}`（models 仅在 import 有效，缺省=勾选 provider 的全部模型）。
 */
async function syncProviders(
  request: DshSyncRouteRequest,
  config: Record<string, unknown>,
  api: DshSyncServerApi,
): Promise<DshSyncProviderResult> {
  const body = asBody(request.body);
  const direction = resolveDirection(body.direction);
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === "string" && key.length > 0) : [];
  const modelIds = Array.isArray(body.models) ? body.models.filter((id): id is string => typeof id === "string" && id.length > 0) : undefined;
  const dshHome = resolveDshHome(asDshConfig(config));
  const profile = resolveDshProfile(asDshConfig(config));
  const patchFile = dshPatchFile(dshHome, profile);
  const [dshRunning, dshProviders] = await Promise.all([probeDshRunning(), readDshProviders(patchFile)]);

  if (direction === "import") {
    if (dshProviders === undefined) {
      return {
        direction,
        applied: [],
        skipped: keys.map((key) => ({ key, kind: "profile" as const, reason: "dsh 侧未找到 providers 配置" })),
        report: {
          patchFile,
          dshRunning,
          unmappedFields: [],
          warnings: [`未在 ${patchFile} 找到 llm-service-lite 的 providers 配置`],
          notes: [],
        },
      };
    }
    const outcome = await syncProvidersImport(api, patchFile, dshProviders, keys, modelIds, dshRunning);
    return { direction, applied: outcome.applied, skipped: outcome.skipped, report: outcome.report };
  }

  const outcome = await syncProvidersExport(api, patchFile, dshProviders, keys, dshRunning);
  return {
    direction,
    applied: outcome.applied,
    skipped: outcome.skipped,
    report: outcome.report,
    ...(outcome.backupPath !== undefined ? { backupPath: outcome.backupPath } : {}),
    envNeeded: outcome.envNeeded,
  };
}

// ── 会话导入（M3b）：清单预览 + 逐项执行 ──────────────────────────────────────

/** 非 v3 会话的不可选原因（与 docs/dsh-sync-plan.md §三 的口径一致）。 */
const NOT_V3_REASON = "请先在 dsh 中打开一次升级格式";

/** zstd 能力缺失（旧版 Node）时压缩会话的不可选原因。 */
const ZSTD_REASON = "需要 Node ≥22.15";

/**
 * 会话同步方向：import = dsh → owc（M3b）；export = owc → dsh（M4c）。
 */
export type DshSyncSessionDirection = "import" | "export";

/** 会话清单条目（面板勾选用的最小信息面）。 */
export interface DshSyncSessionPreviewItem {
  /** dsh 会话 id（目录名解码值，= 头行 id）。 */
  dshId: string;
  /** 会话 cwd（头行缺失时 undefined：面板需先让用户选目标目录）。 */
  cwd?: string;
  /** 头行 createdAt（毫秒 → ISO）。 */
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

/** `GET /preview/sessions?direction=import` 应答体（dsh 会话清单 + 映射表 join）。 */
export interface DshSyncSessionPreview {
  direction: "import";
  items: DshSyncSessionPreviewItem[];
  /** node:zlib 是否具备 zstd 能力（面板据此提示升级 Node）。 */
  zstdAvailable: boolean;
  dshRunning: boolean;
  /** 整体降级说明（目录缺失、zstd 不可用、映射表读取失败等）。 */
  warning?: string;
}

/** 单条导入的成功结论。 */
export interface DshSyncSessionAppliedItem {
  dshId: string;
  /** owc 侧会话 id（映射表记录用）。 */
  owcId: string;
  title: string;
  /** 转换统计（user/assistant/tool/images）。 */
  counts: ConversionCounts;
  /** 该会话的转换警告（可复制给用户）。 */
  warnings: string[];
  /** 嵌套进来的子代理转录数（M5a；无子会话时缺省）。 */
  subagents?: number;
}

/** 单条导入的跳过结论。 */
export interface DshSyncSessionSkippedItem {
  dshId: string;
  reason: string;
}

/** `POST /sync/sessions` 应答体的报告段（聚合展示 + 可复制）。 */
export interface DshSyncSessionReport {
  dshHome: string;
  dshRunning: boolean;
  /** 冲突策略（overwrite = 覆盖映射表记录的 owc 会话历史）。 */
  onConflict: "overwrite" | "new";
  appliedCount: number;
  skippedCount: number;
  /** 全部会话丢弃事件的类型 → 条数（跨会话求和）。 */
  droppedEvents: Record<string, number>;
  /** 带 dshId 前缀的转换警告 + 映射表写入失败等运行期告警。 */
  warnings: string[];
  /** 语义说明。 */
  notes: string[];
  /** 映射表落盘是否成功（失败时同步本身仍成功，只是下次要重选）。 */
  mapSaved: boolean;
  mapPath: string;
}

/** `POST /sync/sessions?direction=import` 应答体。 */
export interface DshSyncSessionResult {
  direction: "import";
  applied: DshSyncSessionAppliedItem[];
  skipped: DshSyncSessionSkippedItem[];
  report: DshSyncSessionReport;
}

// ── 会话导出（M4c）：owc 会话清单 + 逐项写出 dsh v3 文件 ──────────────────────

/**
 * 导出方向清单条目（owc 会话 → dsh）。
 *
 * 键是 **owcId**（与导入方向的 dshId 相对）；export 方向条目**恒可勾选**——重复导出 = 在 dsh 侧
 * 再生成一份**新会话**（只新增目录，绝不覆盖），`sync` 徽标只提示「上次导出时间」而非「已同步」。
 */
interface DshSyncExportPreviewItem {
  /** owc 会话 id。 */
  owcId: string;
  /** 会话标题（meta.title；缺省用「未命名会话」占位）。 */
  title: string;
  /** 会话工作目录（缺 cwd/非绝对路径时导出会跳过该会话，面板据此提示）。 */
  cwd?: string;
  provider?: string;
  model?: string;
  /** meta.updatedAt（ISO）。 */
  updatedAt?: string;
  /** 映射表 join（findByOwcId）：该 owc 会话最近一次导出到的 dsh 会话 id 与时间。 */
  sync?: { dshId: string; lastSyncAt: string };
  /** export 方向恒为 true。 */
  selectable: true;
}

/** `GET /preview/sessions?direction=export` 应答体。 */
export interface DshSyncExportPreview {
  direction: "export";
  items: DshSyncExportPreviewItem[];
  /** node:zlib 是否具备 zstd 能力（导出写 zstd 帧的前提；缺能力则导出的会话不可解）。 */
  zstdAvailable: boolean;
  dshRunning: boolean;
  /** 整体降级说明（dshHome 缺失、zstd 不可用、owc 会话清单/映射表读取失败等）。 */
  warning?: string;
}

/** 单条导出的成功结论。 */
export interface DshSyncExportAppliedItem {
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
  /** 该会话的降级/跳过说明（图片占位、缺 provider/model 等）。 */
  warnings: string[];
  /** 一并导出的子代理会话（M5a：转录 taskId → 新 dsh 会话 id；无子代理时缺省）。 */
  subagents?: Array<{ taskId: string; dshId: string }>;
  /** 导出失败的子代理转录（M5a；失败不影响父会话导出）。 */
  subagentsFailed?: Array<{ taskId: string; reason: string }>;
}

/** 单条导出的跳过结论（键 = owcId）。 */
interface DshSyncExportSkippedItem {
  owcId: string;
  reason: string;
}

/** `POST /sync/sessions?direction=export` 应答体的报告段。 */
interface DshSyncExportReport {
  dshHome: string;
  dshRunning: boolean;
  appliedCount: number;
  skippedCount: number;
  /** 带 owcId 前缀的导出警告 + 映射表写入失败等运行期告警。 */
  warnings: string[];
  /** 语义说明。 */
  notes: string[];
  /** 映射表落盘是否成功（失败时导出本身仍成功，只是下次面板不显示 sync 徽标）。 */
  mapSaved: boolean;
  mapPath: string;
}

/** `POST /sync/sessions?direction=export` 应答体。 */
export interface DshSyncExportResult {
  direction: "export";
  applied: DshSyncExportAppliedItem[];
  skipped: DshSyncExportSkippedItem[];
  report: DshSyncExportReport;
}

/** 毫秒时间戳 → ISO（非法/缺失返回 undefined）。 */
function isoOfMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

/**
 * 判断一个扫描条目的可用性（不可用时给出面板文案）。
 *
 * 判定顺序：没有规范会话文件 → 非 v3（引导去 dsh 升级）→ 压缩会话但缺 zstd 能力 →
 * 头行/目录读取报错（文件损坏）。zstd 判定放在 error 之前：旧版 Node 下压缩会话的头行探测
 * 必然失败，`error` 是「缺能力」的后果而非文件问题，报「升级 Node」才可行动。
 */
function sessionSelectability(entry: DshSessionEntry): { supported: boolean; reason?: string } {
  if (entry.file === undefined || entry.generation === undefined) {
    return { supported: false, reason: "会话目录内没有可识别的会话文件（session*.jsonl[.zstd]）" };
  }
  if (entry.generation !== DSH_SYNC_SUPPORTED_GENERATION) return { supported: false, reason: NOT_V3_REASON };
  if (entry.compressed === true && !zstdAvailable()) return { supported: false, reason: ZSTD_REASON };
  if (entry.error !== undefined) return { supported: false, reason: `文件损坏：${entry.error}` };
  return { supported: true };
}

/** 扫描条目 + 映射表 → 清单项（映射表命中时带 `sync` 字段）。 */
function previewItemOf(entry: DshSessionEntry, map: DshSyncMap): DshSyncSessionPreviewItem {
  const { supported, reason } = sessionSelectability(entry);
  const sync = findByDshId(map, entry.sessionId);
  const createdAt = isoOfMs(entry.header?.createdAt);
  return {
    dshId: entry.sessionId,
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(entry.generation === undefined ? {} : { generation: entry.generation }),
    supported,
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
    ...(entry.parentSession === undefined ? {} : { parentSession: entry.parentSession }),
    ...(sync === undefined ? {} : { sync: { owcId: sync.owcId, lastSyncAt: sync.lastSyncAt } }),
    selectable: supported,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * owc 会话清单条目（`sessions.list` 的白名单 meta）→ 导出方向清单项（映射表命中时带 `sync`）。
 * @returns 清单项；缺 id 的坏条目返回 undefined（跳过）。
 */
function exportPreviewItemOf(raw: Record<string, unknown>, map: DshSyncMap): DshSyncExportPreviewItem | undefined {
  const owcId = typeof raw.id === "string" ? raw.id : "";
  if (owcId.length === 0) return undefined;
  const sync = findByOwcId(map, owcId);
  const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
  const provider = typeof raw.provider === "string" ? raw.provider : undefined;
  const model = typeof raw.model === "string" ? raw.model : undefined;
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : undefined;
  return {
    owcId,
    title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : "未命名会话",
    ...(cwd === undefined ? {} : { cwd }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(sync === undefined ? {} : { sync: { dshId: sync.dshId, lastSyncAt: sync.lastSyncAt } }),
    selectable: true,
  };
}

/** 读映射表并吞错（读不到就是「没有映射」，不阻断清单/同步）。 */
async function loadMapLenient(api: DshSyncServerApi): Promise<{ map: DshSyncMap; error?: string }> {
  try {
    return { map: await loadSyncMap(api) };
  } catch (error: unknown) {
    return { map: emptySyncMap(), error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `GET /preview/sessions?direction=export`：owc 会话清单（`sessions.list`）+ 映射表 join。
 *
 * 只读：不做任何写入。export 的前置 = zstd 能力 + dshHome 存在；两者缺失只体现在 `warning` 里
 * （仍返回清单，面板据此禁用执行按钮）。`sync` 徽标只提示「上次导出时间」（重复导出 = 新增）。
 */
async function previewSessionsExport(
  config: Record<string, unknown>,
  api: DshSyncServerApi,
): Promise<DshSyncExportPreview> {
  const dshHome = resolveDshHome(asDshConfig(config));
  const [dshRunning, sessions, mapState, homeExists] = await Promise.all([
    probeDshRunning(),
    tryServerCall(() => api.listSessions()),
    loadMapLenient(api),
    isDirectory(dshHome),
  ]);
  const warnings: string[] = [];
  if (!zstdAvailable()) warnings.push(`当前 Extension Host 的 Node（${process.version}）不支持 zstd：压缩会话需 Node ≥22.15`);
  if (!homeExists) warnings.push(`未检测到 dsh 数据目录 ${dshHome}：导出前请先在扩展设置中指定 dshHome`);
  if (mapState.error !== undefined) warnings.push(`读取会话映射表失败（按未同步处理）：${mapState.error}`);
  if (sessions.error !== undefined) warnings.push(`读取 owc 会话清单失败：${sessions.error}`);
  const items: DshSyncExportPreviewItem[] = [];
  for (const raw of sessions.value ?? []) {
    const item = exportPreviewItemOf(raw, mapState.map);
    if (item !== undefined) items.push(item);
  }
  return {
    direction: "export",
    items,
    zstdAvailable: zstdAvailable(),
    dshRunning,
    ...(warnings.length === 0 ? {} : { warning: warnings.join("；") }),
  };
}

/**
 * `GET /preview/sessions`：会话清单 + 映射表 join（按方向分派）。
 *
 * - import（`direction=import`，缺省）：扫描 dsh 会话目录 + 逐个头行探测；
 * - export（`direction=export`）：读 owc 会话清单（`sessions.list`）。
 * 两侧都不会写入任何东西；目录/清单缺失不算错误（返回空 items + warning）。
 */
async function previewSessions(
  request: DshSyncRouteRequest,
  config: Record<string, unknown>,
  api: DshSyncServerApi,
): Promise<DshSyncSessionPreview | DshSyncExportPreview> {
  const direction: DshSyncSessionDirection = request.query.direction === "export" ? "export" : "import";
  if (direction === "export") return previewSessionsExport(config, api);
  const dshHome = resolveDshHome(asDshConfig(config));
  const [dshRunning, entries, mapState] = await Promise.all([
    probeDshRunning(),
    scanDshSessions(dshHome),
    loadMapLenient(api),
  ]);
  const base = { zstdAvailable: zstdAvailable(), dshRunning };
  const warnings: string[] = [];
  if (!base.zstdAvailable) warnings.push(`当前 Extension Host 的 Node（${process.version}）不支持 zstd：压缩会话需 Node ≥22.15`);
  if (mapState.error !== undefined) warnings.push(`读取会话映射表失败（按未同步处理）：${mapState.error}`);
  if (entries.length === 0) warnings.push(`未在 ${dshHome} 找到 dsh 会话（sessions/ 目录为空或不存在）`);
  const items = entries.map((entry) => previewItemOf(entry, mapState.map));
  return { direction: "import", items, ...base, ...(warnings.length === 0 ? {} : { warning: warnings.join("；") }) };
}

/** 请求体里的同步项收窄（dshId 必填，cwdOverride 选填）。 */
function syncItemOf(raw: unknown): { dshId: string; cwdOverride?: string } | undefined {
  const item = asBody(raw);
  const dshId = typeof item.dshId === "string" ? item.dshId.trim() : "";
  if (dshId.length === 0) return undefined;
  const override = typeof item.cwdOverride === "string" ? item.cwdOverride.trim() : "";
  return { dshId, ...(override.length === 0 ? {} : { cwdOverride: override }) };
}

/** 请求体里的导出项收窄（owcId 必填）。 */
function exportItemOf(raw: unknown): { owcId: string } | undefined {
  const item = asBody(raw);
  const owcId = typeof item.owcId === "string" ? item.owcId.trim() : "";
  return owcId.length === 0 ? undefined : { owcId };
}

/**
 * 从 `sessions.getLedger` 的全量账本里取出导出需要的压缩记录（`compacted` 子集）。
 * @returns 压缩记录；无压缩或字段不合法时 undefined（导出不做压缩，只导出消息本体）。
 */
function exportCompacted(ledger: Record<string, unknown>): DshExportLedgerCompacted | undefined {
  const compacted = asBody(ledger.compacted);
  const uptoIndex = typeof compacted.uptoIndex === "number" ? compacted.uptoIndex : undefined;
  const summary = typeof compacted.summary === "string" ? compacted.summary : undefined;
  if (uptoIndex === undefined || summary === undefined) return undefined;
  const uptoMessageId = typeof compacted.uptoMessageId === "string" && compacted.uptoMessageId.length > 0 ? compacted.uptoMessageId : undefined;
  const createdAt = typeof compacted.createdAt === "string" ? compacted.createdAt : undefined;
  return {
    uptoIndex,
    ...(uptoMessageId === undefined ? {} : { uptoMessageId }),
    summary,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

/**
 * 导出前的模型归属补全（fill-or-skip）。
 *
 * dsh v4 的 core session 校验要求 `assistant/message.data.message.source` 的 provider/model
 * **都非空**（`hasProviderModel`），而 owc 会话的 `meta.model` 可能为空串（用户只选了服务商，
 * 模型还没选）。规则（沿用「不编造归属」的口径，补不出来即让该项 skipped）：
 * 1. provider/model 都非空 → 原样；
 * 2. provider 非空、model 空 → 取该 provider 的目录默认模型；
 * 3. provider 空、model 非空 → 取 owc 当前默认：只有 provider 非空**且默认模型与之一致**才采用
 *    （否则会给这条模型套上别的 provider 的归属）；
 * 4. 两者都空 → 取 owc 当前默认（provider/model 均非空才采用）。
 * @param api - server 能力（`defaultSelection` 现读，settings/目录热更新即刻生效）。
 * @param meta - `sessions.get` 的 meta（provider/model 可能缺省或空串）。
 * @returns 非空 `{provider, model}`，或 `{reason}`（该会话应进 skipped）。
 */
async function resolveExportAttribution(
  api: DshSyncServerApi,
  meta: Record<string, unknown>,
): Promise<{ provider: string; model: string } | { reason: string }> {
  const provider = typeof meta.provider === "string" ? meta.provider.trim() : "";
  const model = typeof meta.model === "string" ? meta.model.trim() : "";
  if (provider.length > 0 && model.length > 0) return { provider, model };

  if (provider.length > 0) {
    const selection = await api.defaultSelection(provider);
    const fallbackModel = typeof selection?.model === "string" ? selection.model.trim() : "";
    if (fallbackModel.length > 0) return { provider, model: fallbackModel };
    return { reason: `会话缺少模型信息（model 为空），且无法解析 ${provider} 的默认模型；请在 owc 中为该会话选择模型后再导出` };
  }

  const selection = await api.defaultSelection();
  const fallbackProvider = typeof selection?.provider === "string" ? selection.provider.trim() : "";
  const fallbackModel = typeof selection?.model === "string" ? selection.model.trim() : "";
  if (model.length > 0) {
    if (fallbackProvider.length > 0 && fallbackModel === model) return { provider: fallbackProvider, model };
    return { reason: "会话缺少模型信息（provider 为空）" };
  }
  if (fallbackProvider.length > 0 && fallbackModel.length > 0) return { provider: fallbackProvider, model: fallbackModel };
  return { reason: "会话缺少模型信息，且 owc 当前没有默认模型可回填；请先在 owc 设置默认模型后再导出" };
}

/**
 * 导出方向：把父会话里的子代理转录逐个写成 dsh 子会话目录（M5a）。
 *
 * 转录 id 来自父会话消息里所有 tool_result 块的 `subagentTaskIds`（去重、保持顺序）；
 * 每个 id 经 `sessions.getSubagent` 读 `<sessionDir>/subagents/<taskId>.json`：
 * 读到就 `writeDshSession` 写一个 `origin:'subagent'` 的子会话（cwd 与父会话相同、
 * createdAt 取转录 startedAt、provider/model 沿用父会话**补全后**的归属），读不到/写失败只记 `failed` + warning，
 * 绝不影响父会话本身的导出。
 * @returns 成功的 `{taskId, dshId}` 列表与失败原因列表（都由调用方写进 applied 项与报告）。
 */
async function exportSubagentSessions(input: {
  api: DshSyncServerApi;
  dshHome: string;
  cwd: string;
  owcId: string;
  parentDshId: string;
  messages: ChatMessage[];
  warnings: string[];
  meta: Record<string, unknown>;
}): Promise<{ subagents: Array<{ taskId: string; dshId: string }>; failed: Array<{ taskId: string; reason: string }> }> {
  const subagents: Array<{ taskId: string; dshId: string }> = [];
  const failed: Array<{ taskId: string; reason: string }> = [];
  for (const taskId of transcriptTaskIdsOf(input.messages)) {
    try {
      const raw = await input.api.getSubagent(input.owcId, taskId);
      if (raw === null) throw new Error("子代理转录不存在（subagents/<taskId>.json 缺失）");
      const transcript = transcriptExportInput(raw);
      const child = await writeDshSession({
        dshHome: input.dshHome,
        cwd: input.cwd,
        meta: {
          ...(typeof input.meta.provider === "string" ? { provider: input.meta.provider } : {}),
          ...(typeof input.meta.model === "string" ? { model: input.meta.model } : {}),
          ...(transcript.startedAt === undefined ? {} : { createdAt: transcript.startedAt }),
        },
        messages: transcript.messages,
        subagent: {
          parentSession: input.parentDshId,
          ...(transcript.agentPreset === undefined ? {} : { agentPreset: transcript.agentPreset }),
        },
      });
      for (const warning of child.warnings) input.warnings.push(`${input.owcId} 的子代理 ${taskId}：${warning}`);
      subagents.push({ taskId, dshId: child.sessionId });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ taskId, reason });
      input.warnings.push(`${input.owcId}：子代理转录 ${taskId} 未导出：${reason}`);
    }
  }
  return { subagents, failed };
}

/**
 * `POST /sync/sessions`（direction=export）：逐项「getSession → getLedger → 写出 dsh v3 文件 → 记录映射」。
 *
 * 逐项 try/catch：单项失败只进 `skipped`（带原因），不影响同批其它项。前置只有两条：
 * zstd 能力（缺能力时 `writeDshSession` 抛错 → 逐项 skipped）与 dshHome 存在（不存在则**整批** skipped）。
 * 写盘只**新增**目录（`writeDshSession` 拒绝已存在目录），因此重复导出 = dsh 侧再生成一份新会话。
 * 会话的 provider/model 在写盘前经 {@link resolveExportAttribution} 补全（dsh v4 的 core session
 * 校验要求 assistant 消息的模型归属非空）：补不出来即该项 skipped，绝不写出空归属的坏会话。
 * body：`{direction:"export", items:[{owcId}]}`。
 */
async function syncSessionsExport(
  api: DshSyncServerApi,
  dshHome: string,
  dshRunning: boolean,
  rawItems: unknown[],
): Promise<DshSyncExportResult> {
  const applied: DshSyncExportAppliedItem[] = [];
  const skipped: DshSyncExportSkippedItem[] = [];
  const warnings: string[] = [];
  const notes = [
    "export 方向只新增 dsh 会话目录，永不覆盖已有会话；重复导出会在 dsh 侧再生成一份新会话（sync 徽标只提示上次导出时间）。",
    "会话标题导出为 session/title 事件、压缩记录导出为 compaction 生命周期；owc 账本不记 token 数，shadowedTokenCount 如实填 0。",
    `映射表写在扩展私有 storage 的 ${DSH_SYNC_MAP_PATH}（上限 1000 条，按最近同步时间 LRU 裁剪）。`,
    "会话里 tool_result 的 subagentTaskIds 指向的子代理转录会一并导出为 dsh 子会话（origin:'subagent'、parentSession 指回本次导出的父会话）；转录缺失只记警告，不影响父会话。",
    "dsh 当前代际要求 assistant 消息的模型归属非空：导出前按会话 provider/model 补全（缺 model 取该服务商目录默认模型、缺 provider 取 owc 当前默认），补不出来的会话带原因跳过。",
  ];
  if (dshRunning) notes.push("检测到 dsh 正在运行：导出只新增会话目录，dsh 刷新会话列表后即可见。");

  /** 组装报告（放在各处 return 之前，避免漏字段）。 */
  const finish = (mapSaved: boolean): DshSyncExportResult => ({
    direction: "export",
    applied,
    skipped,
    report: {
      dshHome,
      dshRunning,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      warnings,
      notes,
      mapSaved,
      mapPath: DSH_SYNC_MAP_PATH,
    },
  });

  const mapState = await loadMapLenient(api);
  if (mapState.error !== undefined) warnings.push(`读取会话映射表失败（按未同步处理）：${mapState.error}`);
  let map = mapState.map;
  let recorded = false;

  // dshHome 不存在：整批跳过（导出需要一个可写的 dsh 数据目录，逐项报同一个原因便于面板整体提示）。
  if (!(await isDirectory(dshHome))) {
    for (const raw of rawItems) skipped.push({ owcId: exportItemOf(raw)?.owcId ?? "", reason: "未检测到 dsh 数据目录" });
    return finish(false);
  }

  for (const raw of rawItems) {
    const item = exportItemOf(raw);
    if (item === undefined) {
      skipped.push({ owcId: "", reason: "同步项缺少 owcId" });
      continue;
    }
    const { owcId } = item;
    try {
      const meta = await api.getSession(owcId);
      const cwd = typeof meta.cwd === "string" ? meta.cwd.trim() : "";
      if (cwd.length === 0) {
        skipped.push({ owcId, reason: "会话没有 cwd：无法定位 dsh 会话目录，请先为该会话设置工作目录" });
        continue;
      }
      if (!path.isAbsolute(cwd)) {
        skipped.push({ owcId, reason: `会话 cwd 不是绝对路径（${cwd}），无法导出到 dsh` });
        continue;
      }
      // 模型归属补全（fill-or-skip）：dsh v4 要求 assistant 消息的 source.provider/model 均非空，
      // 补不出来就直接跳过该项（写出去也是一份 dsh 加载会拒绝的坏会话）。
      const attribution = await resolveExportAttribution(api, meta);
      if ("reason" in attribution) {
        skipped.push({ owcId, reason: attribution.reason });
        continue;
      }
      // 补全后的归属同时用于父会话与子会话（子代理会话沿用父会话的 provider/model）。
      const exportMeta: Record<string, unknown> = { ...meta, provider: attribution.provider, model: attribution.model };
      const ledger = await api.getLedger(owcId);
      const compacted = exportCompacted(ledger);
      const messages = Array.isArray(meta.messages) ? meta.messages as ChatMessage[] : [];
      const result = await writeDshSession({
        dshHome,
        cwd,
        meta: {
          ...(typeof exportMeta.title === "string" ? { title: exportMeta.title } : {}),
          ...(typeof exportMeta.createdAt === "string" ? { createdAt: exportMeta.createdAt } : {}),
          provider: attribution.provider,
          model: attribution.model,
        },
        messages,
        ...(compacted === undefined ? {} : { ledger: { compacted } }),
      });
      for (const warning of result.warnings) warnings.push(`${owcId}：${warning}`);
      const title = typeof meta.title === "string" && meta.title.length > 0 ? meta.title : "导出的会话";
      // M5a：父会话里的每个转录（tool_result 的 subagentTaskIds）写成一个 dsh 子会话目录
      //（origin:'subagent' + parentSession = 本次父会话的新 dsh id + delegationDepth:1）。
      const subagents = await exportSubagentSessions({ api, dshHome, cwd, owcId, parentDshId: result.sessionId, messages, warnings, meta: exportMeta });
      map = recordSync(map, {
        dshId: result.sessionId,
        owcId,
        cwd,
        title,
        lastSyncDirection: "export",
        lastSyncAt: new Date().toISOString(),
      });
      recorded = true;
      applied.push({
        owcId,
        dshId: result.sessionId,
        file: result.file,
        eventCount: result.eventCount,
        attachments: result.attachments,
        warnings: result.warnings,
        ...(subagents.subagents.length === 0 ? {} : { subagents: subagents.subagents }),
        ...(subagents.failed.length === 0 ? {} : { subagentsFailed: subagents.failed }),
      });
    } catch (error: unknown) {
      skipped.push({ owcId, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  let mapSaved = false;
  if (recorded) {
    try {
      await saveSyncMap(api, map);
      mapSaved = true;
    } catch (error: unknown) {
      warnings.push(`写入会话映射表失败（本次导出已生效，下次导出前面板不再显示 sync 徽标）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return finish(mapSaved);
}

/**
 * `POST /sync/sessions`：按方向分派。
 *
 * - import（缺省）：逐项「定位 → 解码 → 转换 → 导入 → 记录映射」；
 * - export：逐项「getSession → getLedger → 写出 dsh v3 文件 → 记录映射」（见 {@link syncSessionsExport}）。
 *
 * import 逐项 try/catch：单项失败只进 `skipped`（带原因），不影响同批其它项——一批里可能既有能导入的
 * v3 会话，也有旧代际/损坏/缺 cwd 的项。执行完统一落一次映射表（单次写盘；写失败只告警，导入本身已成功）。
 * body：import `{direction:"import", items:[{dshId, cwdOverride?}], onConflict?:"overwrite"|"new"}`；
 * export `{direction:"export", items:[{owcId}]}`。
 */
async function syncSessions(
  request: DshSyncRouteRequest,
  config: Record<string, unknown>,
  api: DshSyncServerApi,
): Promise<DshSyncSessionResult | DshSyncExportResult> {
  const body = asBody(request.body);
  const direction: DshSyncSessionDirection = body.direction === "export" ? "export" : "import";
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const dshHome = resolveDshHome(asDshConfig(config));
  const dshRunning = await probeDshRunning();

  if (direction === "export") return syncSessionsExport(api, dshHome, dshRunning, rawItems);

  const onConflict: "overwrite" | "new" = body.onConflict === "overwrite" ? "overwrite" : "new";
  const applied: DshSyncSessionAppliedItem[] = [];
  const skipped: DshSyncSessionSkippedItem[] = [];
  const dropped: Record<string, number> = {};
  const warnings: string[] = [];
  const notes = [
    "onConflict=new（缺省）时重复导入会新建副本；overwrite 且映射表里已有该会话时走 sessions.import.replaceId 覆盖其历史（目标会话的沙盒/权限配置保留）。",
    "导入会话的 provider/model 取自 owc 当前默认（dsh 的模型归属不保证在 owc 有同名配置）；原始 provider/model 只作为预览提示。",
    `映射表写在扩展私有 storage 的 ${DSH_SYNC_MAP_PATH}（上限 1000 条，按最近同步时间 LRU 裁剪）。`,
  ];
  if (dshRunning) notes.push("检测到 dsh 正在运行：导入只读 dsh 文件，不影响 dsh；导出方向在 dsh 运行时写新目录同样安全。");
  // 子代理嵌套映射只在确有子会话时提示（配对启发式的局限必须让用户看见）
  const noteSubagentPairing = (): void => {
    notes.push(
      "子代理嵌套映射用**时序配对启发式**：父会话 `subagent` 工具调用按出现顺序编号、子会话按头行 createdAt 升序编号，第 n 个调用 ↔ 第 n 个子会话。"
      + "dsh 工具结果里的 subagentId 与子会话 id 的关系未证实，调用与子会话顺序不一致时可能错配，请在会话详情里核对转录。",
    );
  };

  /** 组装报告（放在各处 return 之前，避免漏字段）。 */
  const finish = (mapSaved: boolean): DshSyncSessionResult => ({
    direction: "import",
    applied,
    skipped,
    report: {
      dshHome,
      dshRunning,
      onConflict,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      droppedEvents: Object.fromEntries(Object.entries(dropped).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
      warnings,
      notes,
      mapSaved,
      mapPath: DSH_SYNC_MAP_PATH,
    },
  });

  const [entries, mapState] = await Promise.all([scanDshSessions(dshHome), loadMapLenient(api)]);
  if (mapState.error !== undefined) warnings.push(`读取会话映射表失败（按未同步处理）：${mapState.error}`);
  const bySessionId = new Map(entries.map((entry) => [entry.sessionId, entry]));
  // M5a：子代理会话索引（parentSession → 子会话条目），只收 supported 的 v3
  // （旧代际/损坏/缺 zstd 能力的子会话不可解码，进不了嵌套映射，仍可按独立会话清单导入）。
  const childrenByParent = new Map<string, DshSessionEntry[]>();
  for (const entry of entries) {
    if (entry.parentSession === undefined || !sessionSelectability(entry).supported) continue;
    childrenByParent.set(entry.parentSession, [...(childrenByParent.get(entry.parentSession) ?? []), entry]);
  }
  let map = mapState.map;
  let recorded = false;
  let pairedAny = false;

  for (const raw of rawItems) {
    const item = syncItemOf(raw);
    if (item === undefined) {
      skipped.push({ dshId: "", reason: "同步项缺少 dshId" });
      continue;
    }
    const { dshId } = item;
    try {
      const entry = bySessionId.get(dshId);
      if (entry === undefined) {
        skipped.push({ dshId, reason: `未在 ${dshHome} 的 dsh 会话目录里找到该会话` });
        continue;
      }
      const { supported, reason } = sessionSelectability(entry);
      if (!supported || entry.file === undefined || entry.generation === undefined || entry.compressed === undefined) {
        skipped.push({ dshId, reason: reason ?? "会话不可导入" });
        continue;
      }
      // 解码 + 转换：任何格式问题（断档、头行不一致、损坏帧）都当作单项失败，不中断整批。
      const { header, events } = await decodeDshSessionFile({
        file: entry.file,
        generation: entry.generation,
        compressed: entry.compressed,
      });
      const conversion = convertDshSession(header, events);
      const cwd = item.cwdOverride ?? conversion.meta.cwd;
      if (cwd === undefined || cwd.length === 0) {
        skipped.push({ dshId, reason: "会话没有 cwd 且未提供 cwdOverride：请先为该会话选择目标目录" });
        continue;
      }
      // M5a：子代理嵌套映射——先把该父会话的子会话转成转录（逐项 try），
      // 再把配对结果挂到 conversion.messages 的 tool_result 块上，最后连同转录一起交给 server。
      const nesting = await nestSubagentSessions({
        parentEvents: events,
        children: childrenByParent.get(dshId) ?? [],
      });
      const itemWarnings = [...conversion.report.warnings, ...nesting.warnings];
      for (const warning of nesting.warnings) warnings.push(`${dshId}：${warning}`);
      if (nesting.subagents.length > 0) {
        const patched = attachSubagentTasks(conversion.messages, nesting.assignments);
        if (patched === 0) {
          itemWarnings.push("子代理调用在父会话消息里找不到对应的 tool_result（tool_call.id ↔ toolCallId 不配对），转录未挂载到父会话");
        }
        pairedAny = true;
      }
      const childCount = (childrenByParent.get(dshId) ?? []).length;
      if (childCount > 0 && nesting.unpaired.length > 0) {
        // 配对不上的子会话不 nested；它们仍在预览清单里，可单独勾选按独立会话导入。
        itemWarnings.push(`${nesting.unpaired.length} 个子代理会话未配对，可作为独立会话导入（${nesting.unpaired.map((child) => child.sessionId).join("、")}）`);
      }
      if (entry.origin === "subagent" || entry.parentSession !== undefined) {
        // 子代理会话被单独勾选时的口径：按普通会话导入（现状），只在报告里注明父会话
        itemWarnings.push(`这是子代理会话（父会话 ${entry.parentSession ?? "未知"}），已作为独立会话导入；父会话里的对应 tool_result 不会自动挂载本转录`);
      }
      // overwrite 只在映射表确实记录了目标会话时生效（映射丢失时退化为新建，绝不误覆写无关会话）。
      const existing = onConflict === "overwrite" ? findByDshId(map, dshId) : undefined;
      const imported = await api.importSession({
        // title/createdAt 缺省由 server 兜底（title 空则用「导入的会话」），provider/model 不传
        // → server 按当前默认解析（dsh 的 provider 名不保证在 owc 存在）。
        meta: {
          cwd,
          createdAt: conversion.meta.createdAt,
          ...(conversion.meta.title === undefined ? {} : { title: conversion.meta.title }),
        },
        messages: conversion.messages,
        ...(existing === undefined ? {} : { replaceId: existing.owcId }),
        ...(conversion.ledger === undefined ? {} : { ledger: conversion.ledger }),
        ...(nesting.subagents.length === 0 ? {} : { subagents: nesting.subagents }),
      });
      const owcId = typeof imported.id === "string" ? imported.id : "";
      const title = typeof imported.title === "string" && imported.title.length > 0 ? imported.title : conversion.meta.title ?? "导入的会话";
      // 服务端逐项落盘结论：失败项在这里汇总进报告（导入本身已成功）
      const failedList = Array.isArray(imported.subagentsFailed) ? imported.subagentsFailed : [];
      for (const failed of failedList) {
        const failedEntry = asBody(failed);
        itemWarnings.push(`子代理转录 ${typeof failedEntry.taskId === "string" ? failedEntry.taskId : "?"} 落盘失败：${typeof failedEntry.reason === "string" ? failedEntry.reason : "未知原因"}`);
      }
      for (const [type, count] of Object.entries(conversion.report.droppedEvents)) {
        dropped[type] = (dropped[type] ?? 0) + count;
      }
      for (const warning of conversion.report.warnings) warnings.push(`${dshId}：${warning}`);
      if (owcId.length === 0) {
        warnings.push(`${dshId}：服务端未返回会话 id，本次不写映射表`);
      } else {
        map = recordSync(map, {
          dshId,
          owcId,
          cwd,
          title,
          lastSyncDirection: "import",
          lastSyncAt: new Date().toISOString(),
        });
        recorded = true;
      }
      applied.push({
        dshId,
        owcId,
        title,
        counts: conversion.report.counts,
        warnings: itemWarnings,
        ...(nesting.subagents.length === 0 ? {} : { subagents: nesting.subagents.length }),
      });
    } catch (error: unknown) {
      skipped.push({ dshId, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (pairedAny) noteSubagentPairing();

  let mapSaved = false;
  if (recorded) {
    try {
      await saveSyncMap(api, map);
      mapSaved = true;
    } catch (error: unknown) {
      warnings.push(`写入会话映射表失败（本次导入已生效，下次同步需重新选择覆盖目标）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return finish(mapSaved);
}

/**
 * dsh-sync 的私有路由表（键为 `METHOD /path`，与 manifest.routes 一一对应）。
 *
 * - `GET /status`：环境探测，10s 超时（含 750ms 端口探测余量）；
 * - `GET /preview/providers`：模型配置差异预览（direction=import|export，30s）；
 * - `POST /sync/providers`：执行勾选集合（含备份与 patch.yml 改写，60s）；
 * - `GET /preview/sessions`：会话清单 + 映射表 join（import 扫描 dsh 目录 / export 读 owc 清单，60s）；
 * - `POST /sync/sessions`：逐会话导入（import）或导出（export；含大会话解码/编码，60s）。
 * @param api - server 侧能力（生产由 extension-host-process 经 callApi 注入）。
 * @returns 路由表。
 */
export function createDshSyncRoutes(api: DshSyncServerApi): Map<string, DshSyncRouteHandler> {
  return new Map<string, DshSyncRouteHandler>([
    ["GET /status", async (_request, config) => ({ status: 200, body: await getDshSyncStatus(config) })],
    ["GET /preview/providers", async (request, config) => ({ status: 200, body: await previewProviders(request, config, api) })],
    ["POST /sync/providers", async (request, config) => ({ status: 200, body: await syncProviders(request, config, api) })],
    ["GET /preview/sessions", async (request, config) => ({ status: 200, body: await previewSessions(request, config, api) })],
    ["POST /sync/sessions", async (request, config) => ({ status: 200, body: await syncSessions(request, config, api) })],
  ]);
}

/**
 * 无 server API 的兜底路由表：**运行时不使用**（extension-host-process 调
 * {@link createDshSyncRoutes} 注入真实 api），保留给单测做 manifest.routes ↔ 路由键集合一致性断言。
 */
export const dshSyncRoutes: Map<string, DshSyncRouteHandler> = createDshSyncRoutes(unavailableApi());
