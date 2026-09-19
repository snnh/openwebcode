/**
 * dsh 兼容层 · 插件发现、兼容探测与配置清单（M2）
 *
 * 目录约定：dsh 插件安装在 `<dataDir>/dsh-plugins/<包目录>/`，每个插件就是一个常规 npm 包
 * （上游经 cordis.yml 的 `name:` 挂载同样的包）：
 * - host 入口 = `main` 或 `exports["."]`（缺省 `index.js`），必须落在包目录内；
 * - client 入口 = `exports["./client"]`，仅当 package.json 声明了 `dsh.client`（上游约定，
 *   供 M4 的 `/plugins` combo 路由使用；本模块只解析不加载）。`dsh.client.platform` 非 `web`
 *   （如 worker 面）时上游不装载 client 半边，本层同样不记录 clientEntry；`inject`/`external`/
 *   `immediately` 修饰字段随声明记录，供 M4 组合 wire 用。
 *
 * 配置文件 `<dataDir>/dsh.json` 保存每插件的 enabled/config；config 的校验与默认值填充由
 * 插件自己的 schemastery `Config` 在宿主激活时完成（垫片在 Extension Host 子进程内）。
 *
 * 兼容探测：翻译层只提供 `@deepseek-ai/*` 中的三个垫片包（cordis / dsh-tools / schemastery），
 * 插件声明的其它 `@deepseek-ai/*` 运行期依赖一律判 `incompatible`（对应服务缝不存在；
 * 宿主侧 import 阶段同样 fail loud）。垫片声明的兼容版本见 {@link DSH_SUPPORTED_PACKAGES}。
 *
 * 本模块只做静态解析，不 import 任何插件代码，因此可跑在 server 主进程与单测里；
 * 真正的加载与激活在 Extension Host 子进程（`host-runtime.ts`）。
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 插件根目录名（`<dataDir>/dsh-plugins`）。 */
const DSH_PLUGINS_DIR = "dsh-plugins";
/** 配置清单文件名（`<dataDir>/dsh.json`）。 */
const DSH_CONFIG_FILE = "dsh.json";
/** 伪扩展 id 前缀：宿主工具表键为 `dsh-<pluginId>`，工具全名 `ext__dsh-<pluginId>__<tool>`。 */
const DSH_TOOL_SOURCE_PREFIX = "dsh-";
/** 单个 id 上限（`dsh-<id>` 必须落在扩展 id 正则 `[a-z0-9][a-z0-9-]{1,63}` 内）。 */
const MAX_PLUGIN_ID_LENGTH = 60;

/**
 * 翻译层声明的 dsh API 兼容面（垫片实现对齐的上游钉版 `ddefc45fbc` = 0.1.6-alpha.2）：
 * cordis 4.0.2（vendor/cordis）、schemastery 3.18.2、dsh-tools 0.1.6-alpha.2。
 * dsh-tools 声明为 `0.1.6`（而非 alpha 串）：使 `^0.1.6`、`^0.1.6-alpha.1`、`^0.1.6-alpha.2`
 * 各类范围都命中（0.1.6 ≥ 任一 0.1.6-alpha.N 预发布）。
 */
const DSH_SUPPORTED_PACKAGES: Readonly<Record<string, string>> = {
  "@deepseek-ai/cordis": "4.0.2",
  "@deepseek-ai/schemastery": "3.18.2",
  "@deepseek-ai/dsh-tools": "0.1.6",
};

/** 插件状态：running 已激活；missing-services 依赖服务缺失（未激活）；incompatible 版本不兼容。 */
export type DshPluginStatus = "running" | "disabled" | "error" | "missing-services" | "incompatible";

/**
 * `dsh.client` 声明（上游 `packages/client/modules/src/client/manifest.ts` 的 parseDshClient 子集）。
 * platform 为 `web` 时 client 半边可被 SPA 装载；其余平台（如 worker 面）本层不装载。
 */
interface DshClientDeclaration {
  platform: string;
  inject?: string[];
  external?: string[];
  immediately?: boolean;
}

/**
 * 解析 `dsh.client`：返回 undefined（未声明）、声明对象，或错误文案（形状非法）。
 * 形状规则与上游 parseDshClient 对齐：platform 必填字符串；inject/external 为字符串数组；
 * immediately 为布尔。
 */
function parseDshClientDeclaration(pluginId: string, value: unknown): DshClientDeclaration | string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${pluginId}: dsh.client 必须是对象`;
  }
  const decl = value as Record<string, unknown>;
  if (typeof decl.platform !== "string") return `${pluginId}: dsh.client.platform 必须是字符串`;
  const strings = (field: unknown, name: string): string[] | string | undefined => {
    if (field === undefined) return undefined;
    if (!Array.isArray(field) || field.some((entry) => typeof entry !== "string")) return `${pluginId}: dsh.client.${name} 必须是字符串数组`;
    return field as string[];
  };
  const inject = strings(decl.inject, "inject");
  if (typeof inject === "string") return inject;
  const external = strings(decl.external, "external");
  if (typeof external === "string") return external;
  if (decl.immediately !== undefined && typeof decl.immediately !== "boolean") return `${pluginId}: dsh.client.immediately 必须是布尔`;
  return {
    platform: decl.platform,
    ...(inject ? { inject } : {}),
    ...(external ? { external } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  };
}

/** 发现结果（清单静态解析）：problem 非空表示不可加载（清单无效或版本不兼容）。 */
interface DshPluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  directory: string;
  /** host 入口（相对包目录）；清单无效时缺省。 */
  entry?: string;
  /** client 入口（相对包目录）；未声明 `dsh.client` 或 platform 非 web 时缺省。 */
  clientEntry?: string;
  /** `dsh.client` 声明（含 platform 修饰字段）；未声明或缺省时无。 */
  client?: DshClientDeclaration;
  enabled: boolean;
  /** 运行期依赖（dependencies + peerDependencies，仅字符串声明）。 */
  dependencies: Record<string, string>;
  problem?: { kind: "invalid" | "incompatible"; message: string };
}

/** 下发给 Extension Host 的加载计划（仅 enabled 且可加载的插件）。 */
export interface DshSyncItem {
  id: string;
  name: string;
  version: string;
  directory: string;
  entry: string;
  config: Record<string, unknown>;
}

export interface DshPluginScan {
  /** 全部已安装插件（含由配置或兼容探测判定为不可用的）。 */
  entries: DshPluginEntry[];
  /** 可加载子集（宿主回报 status 后合并成 {@link DshPluginInfo}）。 */
  plan: DshSyncItem[];
}

/** 宿主回报的单插件状态。 */
export interface DshPluginReport {
  id: string;
  status: Extract<DshPluginStatus, "running" | "error" | "missing-services">;
  error?: string;
  missing?: string[];
  tools?: string[];
}

/** 供 REST/UI 消费的最终状态（发现结果 + 宿主回报）。 */
export interface DshPluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  directory: string;
  entry?: string;
  /** client 入口（仅 `dsh.client.platform === "web"` 时有）。 */
  clientEntry?: string;
  /** `dsh.client` 声明原文（platform/inject/external/immediately）；M4 生成 boot graph 用。 */
  client?: DshClientDeclaration;
  enabled: boolean;
  status: DshPluginStatus;
  /** 状态说明（清单无效 / 版本不兼容 / 激活失败）。 */
  error?: string;
  /** status=missing-services：未满足的 inject 服务名。 */
  missing?: string[];
  /** status=running：已注册的工具名。 */
  tools?: string[];
  dependencies: Record<string, string>;
}

interface DshPluginState {
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface DshPluginConfigFile {
  version: 1;
  plugins: Record<string, DshPluginState>;
}

/** 插件根目录绝对路径。 */
export function dshPluginsRoot(dataDir: string): string {
  return path.join(dataDir, DSH_PLUGINS_DIR);
}

/** 配置清单绝对路径。 */
function dshConfigPath(dataDir: string): string {
  return path.join(dataDir, DSH_CONFIG_FILE);
}

/** 伪扩展 id（宿主工具表键 / agent 侧 `ext__` 命名空间）。 */
export function dshToolSourceId(pluginId: string): string {
  return `${DSH_TOOL_SOURCE_PREFIX}${pluginId}`;
}

/** 包名 → 插件 id：取 scope 之后的名字，规范化为 `[a-z0-9-]`（与扩展 id 正则同域）。 */
export function normalizeDshPluginId(name: string, fallback: string): string {
  const source = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_PLUGIN_ID_LENGTH)
    .replace(/-+$/, "");
  if (normalized !== "") return normalized;
  const fromFallback = fallback.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, MAX_PLUGIN_ID_LENGTH).replace(/-+$/, "");
  return fromFallback === "" ? "plugin" : fromFallback;
}

// ---------------------------------------------------------------------------
// package.json 解析（host/client 入口 + 依赖）
// ---------------------------------------------------------------------------

/** 入口路径校验：必须是包内相对路径（拒绝绝对路径、盘符/UNC、协议前缀与 .. 逃逸）。 */
function safeRelativeEntry(value: string): string | undefined {
  if (value === "") return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return undefined;
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

/** exports 字段取值：字符串直接用；条件对象按 default→import→node→require 顺序展开。 */
function pickExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["default", "import", "node", "require"]) {
    const target = pickExportTarget(record[key]);
    if (target !== undefined) return target;
  }
  return undefined;
}

/** 导出表子路径（`.`/`./client`）→ 目标路径。 */
function exportSubpath(exportsField: unknown, key: string): string | undefined {
  if (exportsField === undefined) return undefined;
  if (typeof exportsField === "string") return key === "." ? pickExportTarget(exportsField) : undefined;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return undefined;
  return pickExportTarget((exportsField as Record<string, unknown>)[key]);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 运行期依赖：dependencies + peerDependencies（optionalDependencies/devDependencies 不参与）。 */
function collectRuntimeDependencies(pkg: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of ["dependencies", "peerDependencies"]) {
    const value = pkg[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
      if (typeof spec === "string") result[name] = spec;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 兼容探测（最小 semver 范围匹配，足够判定 dsh 插件的依赖声明）
// ---------------------------------------------------------------------------

interface DshVersion { major: number; minor: number; patch: number; prerelease: string }
interface DshComparator { op: ">=" | "<=" | ">" | "<"; version: DshVersion }

function parseDshVersion(value: string): DshVersion | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ?? "",
  };
}

/** 版本比较：数字段优先；预发布版小于同号正式版。 */
function compareDshVersions(left: DshVersion, right: DshVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === "") return 1;
  if (right.prerelease === "") return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

function satisfiesComparator(version: DshVersion, comparator: DshComparator): boolean {
  const order = compareDshVersions(version, comparator.version);
  switch (comparator.op) {
    case ">=": return order >= 0;
    case "<=": return order <= 0;
    case ">": return order > 0;
    case "<": return order < 0;
  }
}

/** 单 token → 比较器合取（空数组 = 任意版本）；无法解析返回 undefined。 */
function parseDshToken(token: string): DshComparator[] | undefined {
  const match = /^(>=|<=|>|<|\^|~|=)?\s*(.+)$/.exec(token.trim());
  if (!match) return undefined;
  const op = (match[1] ?? "=") as ">=" | "<=" | ">" | "<" | "^" | "~" | "=";
  const raw = (match[2] ?? "").trim();
  if (raw === "" || raw === "*" || raw === "x" || raw === "X") return [];
  const [core = "", ...rest] = raw.replace(/^v/, "").split("-");
  const prerelease = rest.join("-");
  const segments = core.split(".");
  if (segments.length > 3) return undefined;
  const numeric: number[] = [];
  let wildcardAt = -1;
  for (const [index, segment] of segments.entries()) {
    if (segment === "x" || segment === "X" || segment === "*") {
      wildcardAt = index;
      break;
    }
    if (!/^\d+$/.test(segment)) return undefined;
    numeric.push(Number(segment));
  }
  const major = numeric[0] ?? 0;
  const minor = numeric[1] ?? 0;
  const patch = numeric[2] ?? 0;
  const version: DshVersion = { major, minor, patch, prerelease };
  // 省略段（`1` / `1.2`）与显式通配（`1.x` / `1.2.x`）同义：下界补零，上界在最后一个数字段进位。
  const fuzzy = wildcardAt >= 0 || numeric.length < 3;
  if (fuzzy && (op === "^" || op === "~" || op === "=")) {
    if (numeric.length === 0) return [];
    const carried = numeric.length - 1;
    const upper: DshVersion = { major, minor, patch, prerelease: "" };
    if (carried <= 0) { upper.major += 1; upper.minor = 0; upper.patch = 0; }
    else if (carried === 1) { upper.minor += 1; upper.patch = 0; }
    else { upper.patch += 1; }
    return [{ op: ">=", version: { ...version, prerelease: "" } }, { op: "<", version: upper }];
  }
  if (op === "^" || op === "~") {
    const upper: DshVersion = { major, minor, patch, prerelease: "" };
    if (op === "~") { upper.minor += 1; upper.patch = 0; }
    else if (major > 0) { upper.major += 1; upper.minor = 0; upper.patch = 0; }
    else if (minor > 0) { upper.minor += 1; upper.patch = 0; }
    else { upper.patch += 1; }
    return [{ op: ">=", version }, { op: "<", version: upper }];
  }
  if (op === "=") return [{ op: ">=", version }, { op: "<=", version }];
  return [{ op, version }];
}

/** 单个范围段（空格分隔的合取）；无法解析返回 undefined。 */
function parseDshRangeSegment(segment: string): DshComparator[] | undefined {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(segment.trim());
  if (hyphen) {
    const low = parseDshToken(hyphen[1] ?? "");
    const high = parseDshToken(hyphen[2] ?? "");
    if (!low || !high) return undefined;
    return [...low.map((comparator) => (comparator.op === "<" ? { op: ">=" as const, version: comparator.version } : comparator)), ...high];
  }
  const comparators: DshComparator[] = [];
  for (const token of segment.split(/\s+/)) {
    const parsed = parseDshToken(token);
    if (!parsed) return undefined;
    comparators.push(...parsed);
  }
  return comparators;
}

/**
 * 版本是否落在 semver 范围内（支持 `||`、空格合取、连字符区间、`^`/`~`/比较符/通配）。
 * 返回 undefined 表示范围不可解析（`workspace:^`、`link:`、`latest` 等非 semver 形态）——
 * 调用方按「不阻塞加载」处理，真正的失败在宿主 import 阶段如实上报。
 */
export function matchesDshRange(version: string, range: string): boolean | undefined {
  const parsed = parseDshVersion(version);
  if (!parsed) return undefined;
  const groups = range.split("||").map((group) => group.trim()).filter((group) => group !== "");
  if (groups.length === 0) return undefined;
  let unparsed = false;
  for (const group of groups) {
    const comparators = parseDshRangeSegment(group);
    if (!comparators) {
      unparsed = true;
      continue;
    }
    if (comparators.every((comparator) => satisfiesComparator(parsed, comparator))) return true;
  }
  return unparsed ? undefined : false;
}

/** 依赖声明兼容探测：翻译层未提供的 `@deepseek-ai/*` 包即为不兼容。 */
export function checkDshCompatibility(dependencies: Record<string, string>): { compatible: boolean; reason?: string } {
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!name.startsWith("@deepseek-ai/")) continue;
    const supported = DSH_SUPPORTED_PACKAGES[name];
    if (supported === undefined) {
      return { compatible: false, reason: `依赖 ${name}（${spec}）：翻译层未提供该 dsh 包/服务缝` };
    }
    if (matchesDshRange(supported, spec) === false) {
      return { compatible: false, reason: `依赖 ${name}@${spec} 与翻译层兼容面 ${supported} 不匹配` };
    }
  }
  return { compatible: true };
}

// ---------------------------------------------------------------------------
// 配置清单（<dataDir>/dsh.json）
// ---------------------------------------------------------------------------

/** 读取配置清单；缺省或损坏时返回空表（不抛错——损坏文件不应阻塞插件扫描）。 */
export async function readDshPluginConfig(dataDir: string): Promise<DshPluginConfigFile> {
  try {
    const raw = JSON.parse(await readFile(dshConfigPath(dataDir), "utf8")) as Partial<DshPluginConfigFile>;
    const plugins: Record<string, DshPluginState> = {};
    for (const [id, state] of Object.entries(raw.plugins ?? {})) {
      if (!state || typeof state !== "object") continue;
      const record = state as { enabled?: unknown; config?: unknown };
      const config = record.config && typeof record.config === "object" && !Array.isArray(record.config) ? record.config as Record<string, unknown> : {};
      plugins[id] = { enabled: record.enabled !== false, config };
    }
    return { version: 1, plugins };
  } catch {
    return { version: 1, plugins: {} };
  }
}

/** 写入配置清单（config 必须是 JSON 可序列化的普通对象）。 */
export async function saveDshPluginConfig(dataDir: string, config: DshPluginConfigFile): Promise<void> {
  const plugins: Record<string, DshPluginState> = {};
  for (const [id, state] of Object.entries(config.plugins)) {
    plugins[id] = { enabled: state.enabled !== false, config: normalizeConfig(id, state.config) };
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(dshConfigPath(dataDir), `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`, "utf8");
}

function normalizeConfig(id: string, config: unknown): Record<string, unknown> {
  if (config === undefined) return {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`dsh 插件 ${id} 的 config 必须是对象`);
  try {
    return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  } catch {
    throw new Error(`dsh 插件 ${id} 的 config 必须是 JSON 可序列化对象`);
  }
}

/** 设置启用态（缺省条目按默认启用处理，与 {@link scanDshPlugins} 一致）。 */
export async function setDshPluginEnabled(dataDir: string, id: string, enabled: boolean): Promise<DshPluginConfigFile> {
  const config = await readDshPluginConfig(dataDir);
  const previous = config.plugins[id] ?? { enabled: true, config: {} };
  config.plugins[id] = { enabled, config: previous.config };
  await saveDshPluginConfig(dataDir, config);
  return config;
}

/** 覆盖/合并插件配置（浅合并；校验交给插件自己的 Config）。 */
export async function setDshPluginConfig(dataDir: string, id: string, patch: Record<string, unknown>): Promise<DshPluginConfigFile> {
  const config = await readDshPluginConfig(dataDir);
  const previous = config.plugins[id] ?? { enabled: true, config: {} };
  config.plugins[id] = { enabled: previous.enabled, config: { ...previous.config, ...normalizeConfig(id, patch) } };
  await saveDshPluginConfig(dataDir, config);
  return config;
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** 读取单个插件目录的清单（不抛错：问题进 problem 字段，保证单插件故障不拖垮扫描）。 */
async function readDshPluginEntry(directory: string, directoryName: string, id: string): Promise<DshPluginEntry> {
  const base: Omit<DshPluginEntry, "enabled" | "problem"> = {
    id,
    name: directoryName,
    version: "",
    description: "",
    directory,
    dependencies: {},
  };
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as Record<string, unknown>;
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("package.json 必须是对象");
  } catch (error) {
    return { ...base, enabled: false, problem: { kind: "invalid", message: `读取 package.json 失败：${errorMessage(error)}` } };
  }
  const name = stringField(pkg.name) === "" ? directoryName : stringField(pkg.name);
  const dependencies = collectRuntimeDependencies(pkg);
  // host 入口：exports["."] 优先（Node 的包解析语义），其次 main，缺省 index.js。
  const declared = exportSubpath(pkg.exports, ".") ?? pickExportTarget(pkg.main) ?? "index.js";
  const resolved = safeRelativeEntry(declared);
  const declaration: DshPluginEntry = {
    id,
    name,
    version: stringField(pkg.version),
    description: stringField(pkg.description),
    directory,
    dependencies,
    enabled: false,
    ...(resolved !== undefined ? { entry: resolved } : {}),
  };
  if (resolved === undefined) {
    return { ...declaration, problem: { kind: "invalid", message: `插件入口无效或越出包目录：${declared}` } };
  }
  // client 入口：仅当声明 `dsh.client`（上游双面包约定：exports["./client"] → lib/client.js）
  const clientDecl = parseDshClientDeclaration(id, (pkg.dsh as { client?: unknown } | undefined)?.client);
  if (typeof clientDecl === "string") {
    return { ...declaration, problem: { kind: "invalid", message: clientDecl } };
  }
  if (clientDecl) {
    declaration.client = clientDecl;
    if (clientDecl.platform === "web") {
      const clientEntry = exportSubpath(pkg.exports, "./client");
      const resolvedClient = clientEntry === undefined ? undefined : safeRelativeEntry(clientEntry);
      if (resolvedClient === undefined) {
        return { ...declaration, problem: { kind: "invalid", message: "声明了 dsh.client 但 exports[\"./client\"] 缺失或非法" } };
      }
      declaration.clientEntry = resolvedClient;
    }
  }
  const compatibility = checkDshCompatibility(dependencies);
  if (!compatibility.compatible) {
    return { ...declaration, problem: { kind: "incompatible", message: compatibility.reason ?? "版本不兼容" } };
  }
  return declaration;
}

/** 工具名/包名同类 id 去重（同一 id 的第二个目录追加 `-2`、`-3`…）。 */
function uniqueDshPluginId(id: string, used: Set<string>): string {
  let candidate = id;
  let suffix = 2;
  while (used.has(candidate) && suffix < 100) {
    const tail = `-${suffix++}`;
    candidate = `${id.slice(0, MAX_PLUGIN_ID_LENGTH - tail.length)}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 插件目录发现：`dsh-plugins/` 下一层目录；`@scope` 目录再下探一层（npm scope 布局
 * `dsh-plugins/@scope/pkg`）。返回相对 root 的路径（可能含一个 `/`），跳过隐藏目录与 node_modules。
 */
async function listPluginDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.name.startsWith("@")) {
      names.push(entry.name);
      continue;
    }
    // scope 目录本身不是插件包：只把它的子目录当插件（再深一层不再下探）
    const scoped = await readdir(path.join(root, entry.name), { withFileTypes: true }).catch(() => []);
    for (const child of scoped) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      names.push(`${entry.name}/${child.name}`);
    }
  }
  return names.sort();
}

/**
 * 扫描插件目录并与配置文件合成加载计划。
 * 默认启用（与 dsh 的 cordis.yml「列出的即挂载」语义一致）：`dsh.json` 中显式 `enabled:false` 才停用。
 */
export async function scanDshPlugins(dataDir: string): Promise<DshPluginScan> {
  const root = dshPluginsRoot(dataDir);
  const config = await readDshPluginConfig(dataDir);
  const used = new Set<string>();
  const entries: DshPluginEntry[] = [];
  const plan: DshSyncItem[] = [];
  for (const directoryName of await listPluginDirectories(root)) {
    const directory = path.join(root, directoryName);
    const discovered = await readDshPluginEntry(directory, directoryName, normalizeDshPluginId(directoryName, directoryName));
    const id = uniqueDshPluginId(discovered.id, used);
    const state = config.plugins[id];
    const enabled = state?.enabled !== false;
    const entry: DshPluginEntry = { ...discovered, id, enabled };
    entries.push(entry);
    if (entry.problem === undefined && entry.entry !== undefined && enabled) {
      plan.push({
        id,
        name: entry.name,
        version: entry.version,
        directory: entry.directory,
        entry: entry.entry,
        config: state?.config ?? {},
      });
    }
  }
  return { entries, plan };
}

/**
 * 发现结果 + 宿主回报 → 最终状态表（顺序与 entries 一致）。
 * `modeEnabled=false`（设置 `dshCompatEnabled` 关闭）时不下发加载计划：全部插件标 `disabled`
 * 并给出原因，避免把「模式没开」误报成插件自身错误。
 */
export function dshPluginInfos(scan: DshPluginScan, reports: readonly DshPluginReport[] | undefined, hostError?: string, modeEnabled = true): DshPluginInfo[] {
  const byId = new Map((reports ?? []).map((report) => [report.id, report]));
  return scan.entries.map((entry) => {
    const base: DshPluginInfo = {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      directory: entry.directory,
      ...(entry.entry !== undefined ? { entry: entry.entry } : {}),
      ...(entry.clientEntry !== undefined ? { clientEntry: entry.clientEntry } : {}),
      ...(entry.client !== undefined ? { client: entry.client } : {}),
      enabled: entry.enabled,
      status: "disabled",
      dependencies: entry.dependencies,
    };
    if (!modeEnabled) {
      // 模式未启用：优先级高于其它判定（插件根本没被下发），原因如实展示
      return { ...base, error: "dsh 兼容模式未启用（dshCompatEnabled=false）" };
    }
    if (!entry.enabled) {
      // 停用优先于其它判定（用户意图）：不可用原因留在 error 字段里如实展示。
      return entry.problem === undefined ? base : { ...base, error: entry.problem.message };
    }
    if (entry.problem !== undefined) {
      return entry.problem.kind === "incompatible"
        ? { ...base, status: "incompatible", error: entry.problem.message }
        : { ...base, status: "error", error: entry.problem.message };
    }
    const report = byId.get(entry.id);
    if (!report) {
      return { ...base, status: "error", error: hostError ?? "Extension Host 未回报该插件（宿主未连接或同步失败）" };
    }
    return {
      ...base,
      status: report.status,
      ...(report.error !== undefined ? { error: report.error } : {}),
      ...(report.missing !== undefined ? { missing: [...report.missing] } : {}),
      ...(report.tools !== undefined ? { tools: [...report.tools] } : {}),
    };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
