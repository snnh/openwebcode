import { BUILTIN_PERSONAS } from "./builtin-personas.js";
import { loadUserPresets, type PresetWarn } from "./preset-store.js";
import type { PersonaDetail, PersonaPreset, PersonaSummary } from "./types.js";

export { BUILTIN_PERSONAS } from "./builtin-personas.js";
export { deleteUserPreset, personasDir, saveUserPreset } from "./preset-store.js";
export type { PersonaDetail, PersonaPreset, PersonaSummary } from "./types.js";

function builtinById(id: string): PersonaPreset | undefined {
  return BUILTIN_PERSONAS.find((preset) => preset.id === id);
}

/**
 * 内置覆盖合并：用户同 id 覆盖文件与内置逐字段合并——用户提供（非空数组/有值）的字段
 * 生效，缺省字段继承内置。使「自定义内置预设」只需写想改的字段（如身份行），
 * 工具形态/命令拟态等其余部分自动保留。
 */
function mergeBuiltinOverride(builtin: PersonaPreset, user: PersonaPreset): PersonaPreset {
  return {
    ...builtin,
    ...user,
    productSections: user.productSections.length > 0 ? user.productSections : builtin.productSections,
    hideBuiltIns: user.hideBuiltIns.length > 0 ? user.hideBuiltIns : builtin.hideBuiltIns,
    aliases: user.aliases.length > 0 ? user.aliases : builtin.aliases,
    ...(user.firstTurnOnlyTools !== undefined
      ? { firstTurnOnlyTools: user.firstTurnOnlyTools }
      : builtin.firstTurnOnlyTools !== undefined
        ? { firstTurnOnlyTools: builtin.firstTurnOnlyTools }
        : {}),
    ...(user.initPrompt !== undefined
      ? { initPrompt: user.initPrompt }
      : builtin.initPrompt !== undefined
        ? { initPrompt: builtin.initPrompt }
        : {}),
    ...(user.compactOverviewPrompt !== undefined
      ? { compactOverviewPrompt: user.compactOverviewPrompt }
      : builtin.compactOverviewPrompt !== undefined
        ? { compactOverviewPrompt: builtin.compactOverviewPrompt }
        : {}),
    ...(user.compactToolcallsPrompt !== undefined
      ? { compactToolcallsPrompt: user.compactToolcallsPrompt }
      : builtin.compactToolcallsPrompt !== undefined
        ? { compactToolcallsPrompt: builtin.compactToolcallsPrompt }
        : {}),
    ...(user.userAgent !== undefined
      ? { userAgent: user.userAgent }
      : builtin.userAgent !== undefined
        ? { userAgent: builtin.userAgent }
        : {}),
  };
}

/**
 * 预设清单（内置在前，用户目录发现的后缀；内置被用户覆盖时合并为单项并标记 overridden），
 * 供 UI 下拉与 REST 契约。
 */
export async function listPersonas(dataDir: string, warn?: PresetWarn): Promise<PersonaSummary[]> {
  const users = await loadUserPresets(dataDir, warn);
  const userById = new Map(users.map((preset) => [preset.id, preset]));
  return [
    ...BUILTIN_PERSONAS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      builtin: true,
      ...(userById.has(preset.id) ? { overridden: true } : {}),
    })),
    ...users
      .filter((preset) => !builtinById(preset.id))
      .map((preset) => ({ id: preset.id, name: preset.name, builtin: false })),
  ];
}

/** 按 id 取完整预设（详情/预览端点）；用户覆盖优先（内置 id 的覆盖返回合并形态并标记
 *  overridden），其次内置，最后用户目录；未命中返回 null。 */
export async function getPersona(dataDir: string, id: string, warn?: PresetWarn): Promise<PersonaDetail | null> {
  const user = (await loadUserPresets(dataDir, warn)).find((preset) => preset.id === id);
  if (user) {
    const builtin = builtinById(id);
    return builtin
      ? { ...mergeBuiltinOverride(builtin, user), builtin: true, overridden: true }
      : { ...user, builtin: false };
  }
  const builtin = builtinById(id);
  return builtin ? { ...builtin, builtin: true } : null;
}

/**
 * 按 config.persona 解析预设：用户目录优先（同 id 覆盖文件生效，内置被覆盖时逐字段合并），
 * 其次内置；空串/未设置/未知 id 一律返回 null（不模拟）。
 * sessionOverride（会话级 persona）非空时优先于扩展全局配置。
 */
export async function resolvePersona(dataDir: string, config: Record<string, unknown>, warn: PresetWarn = () => undefined, sessionOverride?: string): Promise<PersonaPreset | null> {
  const override = typeof sessionOverride === "string" ? sessionOverride.trim() : "";
  const configured = typeof config.persona === "string" ? config.persona.trim() : "";
  const id = override || configured;
  if (!id) return null;
  const user = (await loadUserPresets(dataDir, warn)).find((preset) => preset.id === id);
  if (user) {
    const builtin = builtinById(id);
    return builtin ? mergeBuiltinOverride(builtin, user) : user;
  }
  const builtin = builtinById(id);
  if (builtin) return builtin;
  warn(`env-sim: unknown persona "${id}"; simulation disabled`);
  return null;
}
