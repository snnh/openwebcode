import type { SessionMeta } from "./types.js";

/** 读取会话级扩展状态里的字符串值；空串/非字符串视为未设置。 */
function sessionExtensionValue(meta: Pick<SessionMeta, "extensionState">, extensionId: string, key: string): string | undefined {
  const value = meta.extensionState?.[extensionId]?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Agent 预设会话级覆盖：优先 SessionMeta.preset（新字段），回退 extensionState["agent-presets"].preset、
 * extensionState["env-sim"].persona 与旧 SessionMeta.persona。`classic` 强制经典。 */
export function resolveSessionPreset(meta: Pick<SessionMeta, "preset" | "persona" | "extensionState">): string | undefined {
  if (typeof meta.preset === "string" && meta.preset.trim()) return meta.preset.trim();
  return sessionExtensionValue(meta, "agent-presets", "preset")
    ?? sessionExtensionValue(meta, "env-sim", "persona")
    ?? (typeof meta.persona === "string" && meta.persona.trim() ? meta.persona : undefined);
}
