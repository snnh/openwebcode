/**
 * dsh 插件管理面（pluginManager/*）：把 `<dataDir>/dsh-plugins` 的已安装插件投影为
 * dsh 设置页「插件」的 bundle/rows 视图，并把启停动词落到 owc 的 `dsh.json` + 宿主重同步。
 *
 * 形状权威来源：vendor `@deepseek-ai/dsh-plugin-manager/types.ts`（生产构建里的
 * `PluginBundle` / `PluginEntry` / `ChangeResult`，见 `dsh-api-remotes` 的 strict codec）：
 *   listBundles() → { name, version?, description?, enabled, installed, optional, removable,
 *                     readOnlyReason?: 'management-required'|'unaddressable', error?, rows: [{rowId, moduleName, entryId?}],
 *                     overrides: string[] }[]
 *   listPlugins(name?) → { entryId, moduleName, enabled, fiberPhase, readOnlyReason? }[]
 *   setPluginEnabled(id, enabled) / setBundleEnabled(name, enabled)
 *     → { changed, application: 'applied'|'failed'|'cancelled'|'restart-required'|'overridden',
 *         stage: 'enable'|'install'|'remove', target, enabled?, error? }
 *
 * 口径（与 dsh 的差异如实表达，不伪装）：
 *   - 一个插件目录 = 一个 bundle（owc 的 `dsh-plugins/<name>`）；`rows` 是该 bundle 的插件条目；
 *   - **面板只读**（启停在 owc 侧：`<dataDir>/dsh.json` + 宿主重放计划）：vendor 的 `listPlugins`
 *     strict codec 要求每条 entry **必须**带 `patchId`（补丁条目）或 `readOnlyReason`（'management-required'
 *     | 'unaddressable'）二选一，裸 entry 直接 ZodError 拒收。owc 的插件不是 dsh 补丁机制的产物，
 *     因此逐条如实标 `readOnlyReason: 'management-required'` —— UI 会列出插件、把开关置灰并给出原因文案；
 *   - `removable: false` + 安装/卸载/启停动词一律如实返回 `management-required` / `not-removable`，
 *     不假装成功（包管理与启停都属宿主运维，见 help/dsh-compat.md）。
 */
import type { DshPluginInfo } from "../loader.js";

/** dsh 的 fiber 相位（与 plugin-inventory 同一取值集合）。 */
type DshPluginFiberPhase = "pending" | "loading" | "active" | "failed" | "unloading" | null;

/** 启停结果（`ChangeResult`）。 */
export interface DshChangeResult {
  changed: boolean;
  application: "applied" | "failed" | "cancelled" | "restart-required" | "overridden";
  stage: "enable" | "install" | "remove";
  target: string;
  enabled?: boolean;
  error?: { code: string; diagnostic?: string };
}

/** 插件清单事实来源（由 runtime 注入；测试可注入假对象）。 */
export interface DshPluginManagerDeps {
  /** 当前插件状态（等同 `extensionManager.dshPlugins()`）。 */
  plugins(): readonly DshPluginInfo[];
}

/** 状态 → fiber 相位（与 plugin-inventory 同口径：missing-services 是 pending 而非失败）。 */
function fiberPhaseOf(plugin: DshPluginInfo): DshPluginFiberPhase {
  if (!plugin.enabled) return null;
  switch (plugin.status) {
    case "running": return "active";
    case "missing-services": return "pending";
    case "error":
    case "incompatible": return "failed";
    default: return null;
  }
}

/**
 * 只读原因码（常量）：启停在 owc 侧，dsh 面板不写配置。
 *
 * 值必须取 vendor 允许集合 {'management-required','unaddressable'}；且**必须下发**——
 * `listPlugins` 的 strict codec 里两种 entry 形状分别要求 patchId / readOnlyReason，缺一即拒收。
 */
const READ_ONLY_REASON = "management-required" as const;

/** `pluginManager/listPlugins`：全部已安装插件（含停用与失败项）。 */
export function projectPluginEntries(deps: DshPluginManagerDeps, filterBundle?: string): Array<Record<string, unknown>> {
  return deps.plugins()
    .filter((plugin) => filterBundle === undefined || bundleNameOf(plugin) === filterBundle)
    .map((plugin) => ({
      entryId: plugin.id,
      moduleName: plugin.name,
      enabled: plugin.enabled,
      fiberPhase: fiberPhaseOf(plugin),
      readOnlyReason: READ_ONLY_REASON,
    }));
}

/** bundle 名：npm 包名优先，缺省用插件 id（目录名）。 */
function bundleNameOf(plugin: DshPluginInfo): string {
  return plugin.name !== "" ? plugin.name : plugin.id;
}

/**
 * `pluginManager/listBundles`：一个插件目录一个 bundle。
 *
 * `enabled` 取该 bundle 下任一插件是否启用（owc 的启用粒度是插件级；同目录多条目暂只可能出现一个主机条目）；
 * `installed: true`（本地已安装）、`optional: true`（装卸由宿主运维决定）、`removable: false`（面板不提供卸载）。
 */
export function projectPluginBundles(deps: DshPluginManagerDeps): Array<Record<string, unknown>> {
  const byBundle = new Map<string, DshPluginInfo[]>();
  for (const plugin of deps.plugins()) {
    const name = bundleNameOf(plugin);
    const list = byBundle.get(name);
    if (list === undefined) byBundle.set(name, [plugin]);
    else list.push(plugin);
  }
  return [...byBundle.entries()].map(([name, plugins]) => ({
    name,
    ...(plugins[0]?.version === undefined || plugins[0].version === "" ? {} : { version: plugins[0].version }),
    ...(plugins[0]?.description === undefined || plugins[0].description === "" ? {} : { description: plugins[0].description }),
    enabled: plugins.some((plugin) => plugin.enabled),
    installed: true,
    optional: true,
    removable: false,
    readOnlyReason: READ_ONLY_REASON,
    rows: plugins.map((plugin) => ({
      rowId: plugin.id,
      moduleName: plugin.name,
      ...(plugin.entry === undefined ? {} : { entryId: plugin.id }),
    })),
    overrides: [],
  }));
}

/** 启停失败的统一结果（`application: 'failed'`，UI 会展示 `error.code` 对应文案）。 */
function failed(target: string, code: string, diagnostic?: string): DshChangeResult {
  return {
    changed: false,
    application: "failed",
    stage: "enable",
    target,
    error: { code, ...(diagnostic === undefined ? {} : { diagnostic }) },
  };
}

/**
 * `pluginManager/setPluginEnabled(id, enabled)`：**面板只读**，如实回 `management-required`。
 *
 * 入参在 wire 上是两个位置参数（`parameters: [id, enabled]`），handler 收到 `{ id, enabled }`。
 * 启停的真实入口是 owc 侧的 `<dataDir>/dsh.json`（宿主重放加载计划），不经 dsh 面板——
 * 与 `readOnlyReason` 的置灰状态一致，绝不返回「假装成功」。
 */
export async function applyPluginEnabled(
  deps: DshPluginManagerDeps,
  id: string | undefined,
  enabled: unknown,
): Promise<DshChangeResult> {
  if (id === undefined || id === "") return failed(String(id ?? ""), "invalid-spec", "缺少插件 id");
  if (typeof enabled !== "boolean") return failed(id, "invalid-spec", "enabled 必须是布尔值");
  if (!deps.plugins().some((plugin) => plugin.id === id)) return failed(id, "unknown-plugin", `未安装该插件：${id}`);
  return failed(id, "management-required", "插件启停在 owc 侧管理（<数据目录>/dsh.json），dsh 面板只读");
}

/** `pluginManager/setBundleEnabled(name, enabled)`：对该 bundle 的所有插件逐个启停。 */
export async function applyBundleEnabled(
  deps: DshPluginManagerDeps,
  name: string | undefined,
  enabled: unknown,
): Promise<DshChangeResult> {
  if (name === undefined || name === "") return failed(String(name ?? ""), "invalid-spec", "缺少 bundle 名");
  if (typeof enabled !== "boolean") return failed(name, "invalid-spec", "enabled 必须是布尔值");
  if (!deps.plugins().some((plugin) => bundleNameOf(plugin) === name)) return failed(name, "unknown-plugin", `未安装该 bundle：${name}`);
  return failed(name, "management-required", "插件启停在 owc 侧管理（<数据目录>/dsh.json），dsh 面板只读");
}

/** 安装/卸载动词：owc 不提供面板内包管理，如实返回 `not-removable`（不改任何状态）。 */
export function rejectedBundleMutation(target: string, code: "not-removable" | "management-required"): DshChangeResult {
  return failed(target, code, "owc 侧不提供 dsh 面板内的安装/卸载（包管理属宿主运维）");
}
