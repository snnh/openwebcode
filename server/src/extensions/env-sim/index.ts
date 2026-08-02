import { BUILTIN_PERSONAS } from "./builtin-personas.js";
import { loadUserPresets, type PresetWarn } from "./preset-store.js";
import type { PersonaDetail, PersonaPreset, PersonaSummary } from "./types.js";

export { BUILTIN_PERSONAS } from "./builtin-personas.js";
export { personasDir } from "./preset-store.js";
export type { PersonaAlias, PersonaDetail, PersonaPreset, PersonaSummary } from "./types.js";

/** 预设清单（内置在前，用户目录发现的后缀），供 UI 下拉与 REST 契约。 */
export async function listPersonas(dataDir: string, warn?: PresetWarn): Promise<PersonaSummary[]> {
  const users = await loadUserPresets(dataDir, warn);
  return [
    ...BUILTIN_PERSONAS.map((preset) => ({ id: preset.id, name: preset.name, builtin: true })),
    ...users.map((preset) => ({ id: preset.id, name: preset.name, builtin: false })),
  ];
}

/** 按 id 取完整预设（详情/预览端点）；内置优先，未命中返回 null。 */
export async function getPersona(dataDir: string, id: string, warn?: PresetWarn): Promise<PersonaDetail | null> {
  const builtin = BUILTIN_PERSONAS.find((preset) => preset.id === id);
  if (builtin) return { ...builtin, builtin: true };
  const user = (await loadUserPresets(dataDir, warn)).find((preset) => preset.id === id);
  return user ? { ...user, builtin: false } : null;
}

/**
 * 按 config.persona 解析预设：内置优先，其次用户目录；空串/未设置/未知 id 一律返回 null（不模拟）。
 * sessionOverride（会话级 persona）非空时优先于扩展全局配置。
 */
export async function resolvePersona(dataDir: string, config: Record<string, unknown>, warn: PresetWarn = () => undefined, sessionOverride?: string): Promise<PersonaPreset | null> {
  const override = typeof sessionOverride === "string" ? sessionOverride.trim() : "";
  const configured = typeof config.persona === "string" ? config.persona.trim() : "";
  const id = override || configured;
  if (!id) return null;
  const builtin = BUILTIN_PERSONAS.find((preset) => preset.id === id);
  if (builtin) return builtin;
  const user = (await loadUserPresets(dataDir, warn)).find((preset) => preset.id === id);
  if (!user) warn(`env-sim: unknown persona "${id}"; simulation disabled`);
  return user ?? null;
}
