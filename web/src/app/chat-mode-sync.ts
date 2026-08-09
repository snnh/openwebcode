import type { SettingsView } from "../lib/contracts";

/**
 * 从服务设置视图读取 chatModeEnabled（general 组布尔字段，热生效）。
 * 返回 undefined 表示设置尚未加载或服务端无该字段——调用方据此不改动本地状态，
 * 避免 settings 到达前把 chatModeEnabled 闪成默认值。
 */
export function readChatModeEnabled(view: SettingsView | undefined): boolean | undefined {
  if (!view) return undefined;
  const field = view.groups.flatMap((group) => group.fields).find((entry) => entry.key === "chatModeEnabled");
  if (!field) return undefined;
  return field.value === true;
}
