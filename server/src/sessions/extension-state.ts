import type { SessionMeta } from "./types.js";

/** 读取会话级扩展状态里的字符串值；空串/非字符串视为未设置。 */
export function sessionExtensionValue(meta: Pick<SessionMeta, "extensionState">, extensionId: string, key: string): string | undefined {
  const value = meta.extensionState?.[extensionId]?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** env-sim 会话级 persona：优先 extensionState["env-sim"].persona（新通道），回退旧 SessionMeta.persona 字段。 */
export function resolveSessionPersona(meta: Pick<SessionMeta, "persona" | "extensionState">): string | undefined {
  return sessionExtensionValue(meta, "env-sim", "persona") ?? meta.persona;
}
