/**
 * `pluginInventory/list` 投影（M4 续）：dsh 设置页「插件」清单的只读映射。
 *
 * 形状权威来源：上游 `packages/host/plugin-inventory/src/types.ts`（`PluginInventorySnapshot`）。
 * 口径：映射的是**dsh 兼容模式的插件**（`<dataDir>/dsh-plugins` 扫描 + `<dataDir>/dsh.json` 启停，
 * 见 dsh/loader.ts），不是 owc 的官方扩展（那是 owc 自己的扩展体系，在同一页面伪装成 dsh 插件会误导）。
 * `managementAvailable=false`：dsh 面板不提供插件安装/启停的持久化管理面（owc 侧管理）。
 */
import type { DshPluginInfo, DshPluginStatus } from "../loader.js";

/** dsh 的 fiber 相位（`packages/host/plugin-inventory/src/types.ts` 的 PluginFiberPhase）。 */
type DshPluginFiberPhase = "pending" | "loading" | "active" | "failed" | "unloading" | null;

/**
 * owc 插件状态 → dsh fiber 相位：
 *   - running → active
 *   - missing-services → pending（等缺失的 inject 服务，语义就是 cordis 的 pending，不是失败）
 *   - error / incompatible → failed（激活失败 / 版本不兼容，进不来）
 *   - disabled → null（没有活着的 root fiber；关闭态如实不带相位）
 */
function fiberPhaseOf(status: DshPluginStatus, enabled: boolean): DshPluginFiberPhase {
  if (!enabled) return null;
  switch (status) {
    case "running": return "active";
    case "missing-services": return "pending";
    case "error": return "failed";
    case "incompatible": return "failed";
    default: return null;
  }
}

/** `pluginInventory/list` 的返回值（`PluginInventorySnapshot`）。 */
export function projectPluginInventory(plugins: readonly DshPluginInfo[]): Record<string, unknown> {
  return {
    managementAvailable: false,
    entries: plugins.map((plugin) => ({
      entryId: plugin.id,
      moduleName: plugin.name,
      enabled: plugin.enabled,
      fiberPhase: fiberPhaseOf(plugin.status, plugin.enabled),
    })),
  };
}
