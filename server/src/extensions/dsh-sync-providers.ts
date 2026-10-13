/**
 * dsh-sync 扩展 M2a：模型配置双向映射的纯函数模块（无 IPC / 文件 IO 依赖，可独立单测）。
 *
 * 三个职责：
 * 1. {@link dshProvidersToOwc}：dsh `llm-service-lite` 的 `providers` 字典 → owc profile patch
 *    + 模型目录 manual 层条目，并解析凭据（`apiKeyEnv` 读 host 进程环境变量内联为 `apiKey`）；
 * 2. {@link owcProfilesToDsh}：owc 脱敏 profile 列表 → dsh `providers` 条目（凭据只写
 *    `apiKeyEnv` 引用，绝不写明文）；
 * 3. {@link diffProviderItems}：两侧同步面字段的三态 diff（new/changed/same），供预览勾选。
 *
 * 词汇表来源（`.tmp/dsh-refs/llm_llm-service-lite/src/config.ts`）：dsh 侧 `OwcProviderProfile`
 * 的 `interfaceType/baseURL/enabled/apiKeyEnv/apiKey/promptCaching/includeUsage/extraBody` 与
 * owc `ModelProviderProfile` 同名同义；模型条目 `OwcModelProfile` 的
 * `id/contextWindow/capabilities{modalities,effort,thinking,thinkingStyle,reasoningContent,tools,
 * imageOutput,responsesEncryptedReplay}` 对应 owc `CatalogModel` 的 `provider` + 同名字段。
 *
 * 映射不到的字段不猜、不丢：一律计入 `unmappedFields` 由报告呈现（见 `docs/dsh-sync-plan.md` §四）。
 */
/** 同步方向。 */
export type ProviderDirection = "import" | "export";

/** 凭据解析结论（import 方向）：resolved=apiKeyEnv 读到值；missing=环境变量缺失；inline=dsh 内联明文；none=dsh 未给凭据。 */
export type DshCredentialState = "resolved" | "missing" | "inline" | "none";

/** 凭据写回结论（export 方向）：env=写 apiKeyEnv 引用（值由用户自行设置）；none=owc 侧无 Key，不写引用。 */
export type DshExportCredentialState = "env" | "none";

/** owc 侧 profile patch（`providers.upsertProfiles` 的入参项）。 */
export interface OwcProfilePatch {
  id: string;
  enabled: boolean;
  interfaceType: string;
  baseURL?: string;
  apiKey?: string;
  promptCaching?: boolean;
  includeUsage?: boolean;
  extraBody?: Record<string, unknown>;
}

/** owc 侧模型目录条目（manual 层）。 */
export interface OwcModelEntry {
  id: string;
  provider: string;
  contextWindow?: number;
  capabilities?: Record<string, unknown>;
}

/** import 方向映射结果。 */
export interface DshToOwcResult {
  profiles: OwcProfilePatch[];
  models: OwcModelEntry[];
  /** provider 键 → 凭据解析结论。 */
  credentials: Record<string, DshCredentialState>;
  /** 无 owc 对应的 dsh 字段（形如 `gateway.displayName`、`gateway.models[].maxTokens`）。 */
  unmappedFields: string[];
  /** 坏条目跳过等宽松校验结论（不阻断其它条目）。 */
  warnings: string[];
}

/** export 方向映射结果。 */
export interface OwcToDshResult {
  providers: Record<string, unknown>;
  /** 需在 dsh 环境设置的变量：envName → owc profile id。 */
  envNeeded: Record<string, string>;
  /** owc profile id → 凭据写回结论。 */
  credentials: Record<string, DshExportCredentialState>;
  /** 无 dsh 对应的 owc 字段（形如 `deepseek.contextWindow`）。 */
  unmappedFields: string[];
  warnings: string[];
}

/** 单字段差异明细（`changes` 项）。 */
export interface ProviderFieldChange {
  field: string;
  /** 数据源侧（import 时是 dsh、export 时是 owc）。 */
  source: unknown;
  /** 目标侧（import 时是 owc、export 时是 dsh）；目标不存在时为 undefined。 */
  target: unknown;
}

/** 逐项预览条目。 */
export interface ProviderDiffItem {
  key: string;
  status: "new" | "changed" | "same";
  /** status="changed" 时的逐字段差异（同步面字段）。 */
  changes?: ProviderFieldChange[];
}

/** dsh 侧 `interfaceType` 词汇表（与 owc 同表，逐字取自上游 `INTERFACE_TYPES`）。 */
const INTERFACE_TYPES: readonly string[] = ["openai-chat-completions", "anthropic-messages", "openai-responses"];

/** owc 模型能力字段（owc `ModelCapabilities` 的键；仅这些字段直通）。 */
const MODEL_CAPABILITY_FIELDS: readonly string[] = [
  "modalities",
  "effort",
  "thinking",
  "thinkingStyle",
  "reasoningContent",
  "tools",
  "imageOutput",
  "responsesEncryptedReplay",
];

/** provider 级「有对应」的字段（同步面；其余进 unmappedFields）。 */
const PROVIDER_MAPPED_FIELDS: readonly string[] = [
  "enabled",
  "interfaceType",
  "baseURL",
  "promptCaching",
  "includeUsage",
  "extraBody",
  "apiKey",
  "apiKeyEnv",
  "models",
];

/** provider 级同步面字段（两侧比较用；credentials 不参与，owc 视图也没有明文）。 */
const PROVIDER_SYNC_FIELDS: readonly string[] = ["enabled", "interfaceType", "baseURL", "promptCaching", "includeUsage", "extraBody"];

/** owc 脱敏视图里的派生字段（不是配置字段，导出时既不同步也不算未映射）。 */
const OWC_VIEW_ONLY_FIELDS: readonly string[] = ["hasApiKey", "maskedApiKey"];

/** export 方向需在 dsh 环境设置的变量名模板（id 大写 snake 化后填入）。 */
const DSH_ENV_PREFIX = "OWC_SYNC_";
const DSH_ENV_SUFFIX = "_API_KEY";

/** 是否为普通对象（非 null / 非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串（去首尾空白）或 undefined。 */
function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/** owc 配置名合法性（与 provider-profiles.ts 的 requireId 同口径：1–64 个字母/数字/空格/点/下划线/连字符）。 */
function isOwcProfileId(value: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,63}$/u.test(value);
}

/** 记录未映射字段（带路径前缀，去重由 Set 负责）。 */
function noteUnmapped(set: Set<string>, path: string): void {
  set.add(path);
}

/** 数组值是否全为字符串（能力词表类字段的形状校验）。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 收窄 extraBody：非空普通对象；空对象/非法类型返回 undefined。 */
function asExtraBody(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * 渲染用于比较的规范形式：对象按键排序后 JSON 序列化（key 顺序不影响相等判定），
 * 标量原样返回；undefined 表示「未声明」。
 */
function canonical(value: unknown): unknown {
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return JSON.stringify(sorted);
  }
  return value;
}

/**
 * 归一单个 provider 条目的同步面字段（两侧比较用）。
 * `enabled` 两侧都按「缺省 true」materialize（dsh 与 owc 的默认语义一致）；
 * 其余字段未声明即 undefined，交由 {@link diffProviderItems} 按方向决定是否参与比较。
 */
function syncFace(entry: unknown): Record<string, unknown> {
  const raw = isRecord(entry) ? entry : {};
  return {
    enabled: raw.enabled !== false,
    interfaceType: asText(raw.interfaceType),
    baseURL: asText(raw.baseURL),
    promptCaching: typeof raw.promptCaching === "boolean" ? raw.promptCaching : undefined,
    includeUsage: typeof raw.includeUsage === "boolean" ? raw.includeUsage : undefined,
    extraBody: canonical(asExtraBody(raw.extraBody)),
  };
}

/**
 * 逐字段比较两侧同步面字段，产出三态 diff。
 *
 * 键集合取**数据源侧**（import=dsh、export=owc）：目标侧多出的键属于「保留的既有配置」，
 * 不是本次同步项，因此不成条目（export 的合并语义由调用方负责）。
 *
 * 比较口径（同样是方向决定的）：
 * - `import`：owc 侧 upsert 是**部分更新**，数据源未声明的字段不会被写入，故只比较 dsh 显式声明的字段；
 * - `export`：写回 dsh 是按 route key **整条目替换**，owc 未声明即「写回后消失」，故所有同步面字段都参与比较。
 * @param dshSide - dsh 侧条目字典（键=route key，值=条目对象）。
 * @param owcSide - owc 侧条目字典（键=profile id，值=条目对象）。
 * @param direction - 同步方向。
 * @returns 按 key 排序的预览条目。
 */
export function diffProviderItems(
  dshSide: Record<string, unknown>,
  owcSide: Record<string, unknown>,
  direction: ProviderDirection,
): ProviderDiffItem[] {
  const source = direction === "import" ? dshSide : owcSide;
  const target = direction === "import" ? owcSide : dshSide;
  const items: ProviderDiffItem[] = [];
  for (const key of Object.keys(source).sort()) {
    const sourceFace = syncFace(source[key]);
    const targetEntry = target[key];
    if (targetEntry === undefined) {
      items.push({ key, status: "new" });
      continue;
    }
    const targetFace = syncFace(targetEntry);
    const changes: ProviderFieldChange[] = [];
    for (const field of PROVIDER_SYNC_FIELDS) {
      const sourceValue = sourceFace[field];
      // import 是部分更新：数据源没声明的字段不会落地，不产生差异。
      if (direction === "import" && sourceValue === undefined) continue;
      const canonicalSource = canonical(sourceValue);
      const canonicalTarget = canonical(targetFace[field]);
      if (canonicalSource !== canonicalTarget) changes.push({ field, source: sourceValue, target: targetFace[field] });
    }
    items.push(changes.length > 0 ? { key, status: "changed", changes } : { key, status: "same" });
  }
  return items;
}

/** 采集 provider 级未映射字段（dsh 有、owc 无）。 */
function collectProviderUnmapped(provider: string, raw: Record<string, unknown>, set: Set<string>): void {
  for (const field of Object.keys(raw)) {
    if (!PROVIDER_MAPPED_FIELDS.includes(field)) noteUnmapped(set, `${provider}.${field}`);
  }
}

/** 采集模型级未映射字段（dsh 模型条目/capabilities 有、owc 目录无）。 */
function collectModelUnmapped(provider: string, raw: Record<string, unknown>, set: Set<string>): void {
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined;
  for (const field of Object.keys(raw)) {
    if (field === "capabilities" || field === "id" || field === "contextWindow") continue;
    noteUnmapped(set, `${provider}.models[].${field}`);
  }
  if (capabilities) {
    for (const field of Object.keys(capabilities)) {
      if (!MODEL_CAPABILITY_FIELDS.includes(field)) noteUnmapped(set, `${provider}.models[].capabilities.${field}`);
    }
  }
}

/** 把 dsh 模型条目的 capabilities 收窄为 owc 词表内的字段（非法类型整字段丢弃）。 */
function modelCapabilities(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const field of MODEL_CAPABILITY_FIELDS) {
    const raw = value[field];
    if (raw === undefined || raw === null) continue;
    if (field === "modalities" || field === "effort" || field === "thinking") {
      if (!isStringArray(raw)) continue;
      result[field] = [...raw];
    } else if (field === "thinkingStyle") {
      const text = asText(raw);
      if (text) result[field] = text;
    } else if (typeof raw === "boolean") {
      result[field] = raw;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 把 dsh provider 条目的 `models[]` 映射为 owc 目录条目（manual 层）。
 * 只映射词表内字段：`id`/`contextWindow`/`capabilities`；其余（`maxTokens`、`imagePixelBudget`、
 * `imageMaxBytes`、`imageTokens`、`defaults`、`replayReasoning`、`systemPromptUpdate`、`toolUpdate`、
 * `name`）计入未映射报告。既无 `contextWindow` 又无 `capabilities` 的条目没有可落地信息，跳过。
 */
function modelsOf(
  provider: string,
  rawModels: unknown,
  unmapped: Set<string>,
  warnings: string[],
): OwcModelEntry[] {
  if (rawModels === undefined) return [];
  if (!Array.isArray(rawModels)) {
    warnings.push(`provider「${provider}」的 models 不是数组：跳过该字段`);
    return [];
  }
  const entries: OwcModelEntry[] = [];
  for (const [index, item] of rawModels.entries()) {
    if (!isRecord(item)) {
      warnings.push(`provider「${provider}」第 ${index + 1} 个模型条目不是对象：跳过`);
      continue;
    }
    const id = asText(item.id);
    if (id === undefined) {
      warnings.push(`provider「${provider}」第 ${index + 1} 个模型条目缺少 id：跳过`);
      continue;
    }
    const contextWindow = Number.isSafeInteger(item.contextWindow) && (item.contextWindow as number) > 0
      ? item.contextWindow as number
      : undefined;
    const capabilities = modelCapabilities(item.capabilities);
    collectModelUnmapped(provider, item, unmapped);
    if (contextWindow === undefined && capabilities === undefined) {
      warnings.push(`provider「${provider}」的模型「${id}」既无 contextWindow 也无 capabilities：跳过`);
      continue;
    }
    entries.push({
      id,
      provider,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    });
  }
  return entries;
}

/**
 * dsh `providers` 字典 → owc profile patch + 模型目录条目 + 凭据解析结论。
 *
 * 凭据：dsh 内联 `apiKey` 直通（inline）；`apiKeyEnv` 读**当前进程**环境变量内联为 `apiKey`
 * （resolved），读不到则留空并标记 missing（不写入 apiKey 键，交由用户补填）；两者都没有为 none。
 *
 * 宽松校验：条目非对象、route key 不是合法 owc 配置名、`interfaceType` 不在词表内 → 跳过并记 warning，
 * 不阻断其它条目。
 * @param dshProviders - `cordis.patch.yml` 中 `llm-service-lite` 的 `config.providers` 解包值。
 * @param env - 凭据解析用的环境变量表（生产传 `process.env`，测试可注入）。
 * @returns 映射结果（含 credentials / unmappedFields / warnings）。
 */
export function dshProvidersToOwc(dshProviders: Record<string, unknown>, env: NodeJS.ProcessEnv): DshToOwcResult {
  const profiles: OwcProfilePatch[] = [];
  const models: OwcModelEntry[] = [];
  const credentials: Record<string, DshCredentialState> = {};
  const unmapped = new Set<string>();
  const warnings: string[] = [];

  for (const [key, raw] of Object.entries(dshProviders)) {
    if (!isRecord(raw)) {
      warnings.push(`跳过 dsh provider「${key}」：配置不是对象`);
      continue;
    }
    if (!isOwcProfileId(key)) {
      warnings.push(`跳过 dsh provider「${key}」：不是合法的 owc 配置名（1–64 个字母/数字/空格/点/下划线/连字符）`);
      continue;
    }
    const interfaceType = asText(raw.interfaceType);
    if (interfaceType === undefined || !INTERFACE_TYPES.includes(interfaceType)) {
      warnings.push(`跳过 dsh provider「${key}」：interfaceType ${interfaceType ?? "缺失"} 不在词汇表内`);
      continue;
    }

    const patch: OwcProfilePatch = { id: key, enabled: raw.enabled !== false, interfaceType };
    const baseURL = asText(raw.baseURL);
    if (baseURL !== undefined) patch.baseURL = baseURL;
    if (typeof raw.promptCaching === "boolean") patch.promptCaching = raw.promptCaching;
    if (typeof raw.includeUsage === "boolean") patch.includeUsage = raw.includeUsage;
    const extraBody = asExtraBody(raw.extraBody);
    if (extraBody !== undefined) patch.extraBody = extraBody;

    const inlineKey = asText(raw.apiKey);
    const envName = asText(raw.apiKeyEnv);
    if (inlineKey !== undefined) {
      patch.apiKey = inlineKey;
      credentials[key] = "inline";
    } else if (envName !== undefined) {
      const resolved = asText(env[envName]);
      if (resolved !== undefined) {
        patch.apiKey = resolved;
        credentials[key] = "resolved";
      } else {
        // 环境变量缺失：不写 apiKey（留空），由用户在 owc 设置页补填。
        credentials[key] = "missing";
        warnings.push(`dsh provider「${key}」的 apiKeyEnv ${envName} 在当前环境未设置：导入后需在 owc 中补填 API Key`);
      }
    } else {
      credentials[key] = "none";
    }

    profiles.push(patch);
    collectProviderUnmapped(key, raw, unmapped);
    models.push(...modelsOf(key, raw.models, unmapped, warnings));
  }

  return { profiles, models, credentials, unmappedFields: [...unmapped].sort(), warnings };
}

/**
 * 生成写回 dsh 的凭据引用名：`OWC_SYNC_<ID大写snake>_API_KEY`（id 的非字母数字字符转 `_`）；
 * 名字冲突时在末尾追加 `_2`/`_3`…（保持前缀与 `_API_KEY` 后缀约定不变）。
 */
function envNameFor(id: string, used: Set<string>): string {
  const snake = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PROVIDER";
  const base = `${DSH_ENV_PREFIX}${snake}${DSH_ENV_SUFFIX}`;
  let name = base;
  for (let index = 2; used.has(name); index += 1) name = `${base}_${index}`;
  used.add(name);
  return name;
}

/** 采集 export 方向 owc 侧未映射字段（owc 有、dsh 无）。 */
function collectOwcUnmapped(id: string, raw: Record<string, unknown>, set: Set<string>): void {
  for (const field of Object.keys(raw)) {
    if (PROVIDER_MAPPED_FIELDS.includes(field) || OWC_VIEW_ONLY_FIELDS.includes(field) || field === "id") continue;
    noteUnmapped(set, `${id}.${field}`);
  }
}

/**
 * owc 脱敏 profile 列表 → dsh `providers` 条目。
 *
 * 凭据只写引用不写明文：有 Key（`hasApiKey`，或防御性地给了 `apiKey`）的 profile 写
 * `apiKeyEnv: OWC_SYNC_<ID大写snake>_API_KEY` 并登记进 `envNeeded`（值由用户自行在 dsh 环境设置）；
 * 无 Key 的 profile 不写 `apiKeyEnv`，改为写 `credential: "none"` 标记（dsh 侧 schema 非 strict，
 * 未知键透传保留，作为「这条 route 还缺凭据」的同步标记）。
 *
 * 只管 provider 端点，不做模型目录导出：owc 的模型目录是独立 catalog，不挂在 profile 上，
 * 也无法从脱敏视图还原 dsh `models[]` 所需的完整字段集，故留给后续里程碑并计入报告。
 * @param owcProfiles - `providers.listProfiles` 返回的脱敏视图数组。
 * @returns 映射结果（含 envNeeded / credentials / unmappedFields / warnings）。
 */
export function owcProfilesToDsh(owcProfiles: Array<Record<string, unknown>>): OwcToDshResult {
  const providers: Record<string, unknown> = {};
  const envNeeded: Record<string, string> = {};
  const credentials: Record<string, DshExportCredentialState> = {};
  const unmapped = new Set<string>();
  const warnings: string[] = [];
  const usedEnvNames = new Set<string>();

  for (const raw of owcProfiles) {
    if (!isRecord(raw)) {
      warnings.push("跳过 owc profile：条目不是对象");
      continue;
    }
    const id = asText(raw.id);
    if (id === undefined) {
      warnings.push("跳过 owc profile：缺少 id");
      continue;
    }
    if (providers[id] !== undefined) {
      warnings.push(`跳过 owc profile「${id}」：id 重复`);
      continue;
    }
    const interfaceType = asText(raw.interfaceType);
    if (interfaceType === undefined || !INTERFACE_TYPES.includes(interfaceType)) {
      warnings.push(`跳过 owc profile「${id}」：interfaceType ${interfaceType ?? "缺失"} 不在词汇表内`);
      continue;
    }

    const entry: Record<string, unknown> = { interfaceType, enabled: raw.enabled !== false };
    const baseURL = asText(raw.baseURL);
    if (baseURL !== undefined) entry.baseURL = baseURL;
    if (typeof raw.promptCaching === "boolean") entry.promptCaching = raw.promptCaching;
    if (typeof raw.includeUsage === "boolean") entry.includeUsage = raw.includeUsage;
    const extraBody = asExtraBody(raw.extraBody);
    if (extraBody !== undefined) entry.extraBody = extraBody;

    const hasApiKey = raw.hasApiKey === true || asText(raw.apiKey) !== undefined;
    if (hasApiKey) {
      const envName = envNameFor(id, usedEnvNames);
      entry.apiKeyEnv = envName;
      envNeeded[envName] = id;
      credentials[id] = "env";
    } else {
      entry.credential = "none";
      credentials[id] = "none";
    }

    providers[id] = entry;
    collectOwcUnmapped(id, raw, unmapped);
  }

  return { providers, envNeeded, credentials, unmappedFields: [...unmapped].sort(), warnings };
}
