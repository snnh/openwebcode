import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EXTENSION_API_VERSION,
  EXTENSION_PERMISSIONS,
  type ExtensionManifest,
  type ExtensionRoute,
  type ToolShapingSpec,
} from "./types.js";

/** 已发现扩展：manifest 本体 + 第三方扩展的安装目录（官方扩展无目录）。 */
export type DiscoveredManifest = ExtensionManifest & { directory?: string };

/** 运行时权限白名单（与 `EXTENSION_PERMISSIONS` 同源，避免 manifest 校验另维护一份）。 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(EXTENSION_PERMISSIONS);

/**
 * 读取并校验 `<directory>/manifest.json`；任何形状问题都抛错（调用方决定是记录警告还是拒绝安装）。
 * 第三方 manifest 不继承 official 标志，也不允许声明 official。
 */
export async function readManifest(directory: string): Promise<ExtensionManifest> {
  const raw = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Partial<ExtensionManifest>;
  if (!raw.id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(raw.id)) throw new Error("manifest.id is invalid");
  if (!raw.name || !raw.version || !raw.description) throw new Error("manifest requires name, version and description");
  if (raw.apiVersion !== EXTENSION_API_VERSION) throw new Error(`Unsupported apiVersion ${raw.apiVersion ?? "missing"}`);
  // 官方扩展是内置硬编码清单，磁盘上的第三方 manifest 不允许自称 official（否则 status/builtIn 会被污染）。
  if (raw.official === true) throw new Error("Third-party extension cannot claim official status");
  if (!Array.isArray(raw.permissions) || raw.permissions.some((permission) => typeof permission !== "string" || !ALLOWED_PERMISSIONS.has(permission))) {
    throw new Error("manifest.permissions contains an unsupported permission");
  }
  const entry = raw.entry ?? "index.js";
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error("manifest.entry must stay inside the extension directory");
  // 工具形态：第三方需 tools:shaping 权限，防止伪装成内置工具名（官方清单为内置硬编码，不走本函数）。
  if (raw.toolShaping !== undefined && !raw.permissions.includes("tools:shaping")) throw new Error("manifest.toolShaping requires the tools:shaping permission");
  if (raw.toolShaping !== undefined) validateToolShaping(raw.toolShaping);
  // 私有 HTTP 路由：声明即要求 http:route 权限；path 以 / 开头且不允许 .. 段
  if (raw.routes !== undefined) {
    if (!raw.permissions.includes("http:route")) throw new Error("manifest.routes requires the http:route permission");
    if (!Array.isArray(raw.routes)) throw new Error("manifest.routes must be an array");
    for (const route of raw.routes) {
      if (!route || (route.method !== "GET" && route.method !== "POST" && route.method !== "DELETE")) throw new Error("manifest.routes method must be GET, POST or DELETE");
      if (typeof route.path !== "string" || !route.path.startsWith("/") || route.path.split("/").includes("..")) throw new Error("manifest.routes path must start with / and must not contain .. segments");
    }
  }
  if (raw.configSchema !== undefined && (!raw.configSchema || typeof raw.configSchema !== "object" || Array.isArray(raw.configSchema))) throw new Error("manifest.configSchema must be an object");
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description,
    apiVersion: raw.apiVersion,
    permissions: raw.permissions,
    entry,
    defaultEnabled: false,
    ...(raw.configSchema ? { configSchema: raw.configSchema } : {}),
    ...(raw.toolShaping ? { toolShaping: raw.toolShaping } : {}),
    ...(raw.routes ? { routes: raw.routes.map((route): ExtensionRoute => ({ method: route.method, path: route.path })) } : {}),
  };
}

/** 工具形态声明的形状校验（官方扩展在代码里直接声明，同样经此把关）。 */
function validateToolShaping(spec: ToolShapingSpec): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("manifest.toolShaping must be an object");
  if (spec.hideBuiltIns !== undefined && (!Array.isArray(spec.hideBuiltIns) || spec.hideBuiltIns.some((name) => typeof name !== "string"))) {
    throw new Error("manifest.toolShaping.hideBuiltIns must be an array of tool names");
  }
  if (spec.aliases !== undefined && (!Array.isArray(spec.aliases) || spec.aliases.some((alias) => !alias || typeof alias.from !== "string" || typeof alias.as !== "string"
    || (alias.argMap !== undefined && (!alias.argMap || typeof alias.argMap !== "object" || Array.isArray(alias.argMap) || Object.values(alias.argMap).some((value) => typeof value !== "string")))))) {
    throw new Error("manifest.toolShaping.aliases entries require string from/as and an optional string-valued argMap");
  }
}
