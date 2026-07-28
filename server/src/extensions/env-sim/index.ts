import { BUILTIN_PERSONAS } from "./builtin-personas.js";
import { loadUserPresets, personasDir, type PresetWarn } from "./preset-store.js";
import type { PersonaPreset, PersonaSummary } from "./types.js";

export { BUILTIN_PERSONAS } from "./builtin-personas.js";
export { personasDir } from "./preset-store.js";
export type { PersonaAlias, PersonaPreset, PersonaSummary } from "./types.js";

/** 预设清单（内置在前，用户目录发现的后缀），供 UI 下拉与 REST 契约。 */
export async function listPersonas(dataDir: string, warn?: PresetWarn): Promise<PersonaSummary[]> {
  const users = await loadUserPresets(dataDir, warn);
  return [
    ...BUILTIN_PERSONAS.map((preset) => ({ id: preset.id, name: preset.name, builtin: true })),
    ...users.map((preset) => ({ id: preset.id, name: preset.name, builtin: false })),
  ];
}

/** 按 config.persona 解析预设：内置优先，其次用户目录；空串/未设置/未知 id 一律返回 null（不模拟）。 */
export async function resolvePersona(dataDir: string, config: Record<string, unknown>, warn: PresetWarn = () => undefined): Promise<PersonaPreset | null> {
  const id = typeof config.persona === "string" ? config.persona.trim() : "";
  if (!id) return null;
  const builtin = BUILTIN_PERSONAS.find((preset) => preset.id === id);
  if (builtin) return builtin;
  const user = (await loadUserPresets(dataDir, warn)).find((preset) => preset.id === id);
  if (!user) warn(`env-sim: unknown persona "${id}"; simulation disabled`);
  return user ?? null;
}
