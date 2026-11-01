import { BUILTIN_PRESETS } from "./builtin-presets.js";
import { migrateAgentPresetsDataDir } from "./migration.js";
import { loadUserPresets, type PresetWarn } from "./preset-store.js";
import type { AgentPreset, PresetCategory, PresetDetail, PresetSummary } from "./types.js";

export { BUILTIN_PRESETS } from "./builtin-presets.js";
export { deleteUserPreset, presetsDir, saveUserPreset } from "./preset-store.js";
export { PRESET_TOOL_GROUPS, PRESET_TOOLS } from "./tool-catalog.js";
export type { AgentPreset, PresetDetail, PresetSummary } from "./types.js";

function builtinById(id: string): AgentPreset | undefined {
  return BUILTIN_PRESETS.find((preset) => preset.id === id);
}

function categoryOf(preset: AgentPreset, builtin: boolean): PresetCategory {
  if (preset.category) return preset.category;
  return builtin ? "mimicry" : "custom";
}

function descriptionOf(preset: AgentPreset): string {
  return preset.description?.trim() || preset.name;
}

/** 内置覆盖合并：用户提供（非空数组/有值）的字段生效，缺省字段继承内置。
 * allowedBuiltIns 显式给空数组表示“不限制”，不能因空数组被内置覆盖。 */
function mergeBuiltinOverride(builtin: AgentPreset, user: AgentPreset): AgentPreset {
  return {
    ...builtin,
    ...user,
    ...(user.description ?? builtin.description ? { description: user.description ?? builtin.description! } : {}),
    ...(user.category ?? builtin.category ? { category: user.category ?? builtin.category! } : {}),
    productSections: user.productSections.length > 0 ? user.productSections : builtin.productSections,
    hideBuiltIns: user.hideBuiltIns.length > 0 ? user.hideBuiltIns : builtin.hideBuiltIns,
    aliases: user.aliases.length > 0 ? user.aliases : builtin.aliases,
    ...(user.allowedBuiltIns !== undefined
      ? { allowedBuiltIns: user.allowedBuiltIns }
      : builtin.allowedBuiltIns !== undefined
        ? { allowedBuiltIns: builtin.allowedBuiltIns }
        : {}),
    ...(user.promptStyle !== undefined ? { promptStyle: user.promptStyle } : builtin.promptStyle !== undefined ? { promptStyle: builtin.promptStyle } : {}),
    ...(user.projectContext !== undefined ? { projectContext: user.projectContext } : builtin.projectContext !== undefined ? { projectContext: builtin.projectContext } : {}),
    ...(user.externalTools !== undefined ? { externalTools: user.externalTools } : builtin.externalTools !== undefined ? { externalTools: builtin.externalTools } : {}),
    ...(user.toolDescriptions !== undefined
      ? { toolDescriptions: { ...(builtin.toolDescriptions ?? {}), ...user.toolDescriptions } }
      : builtin.toolDescriptions !== undefined
        ? { toolDescriptions: builtin.toolDescriptions }
        : {}),
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

/** 每个数据目录只跑一次迁移（进程内缓存）：解析与列表都会走到这里，避免每轮多次 stat。 */
const migratedDataDirs = new Set<string>();

async function ensureMigrated(dataDir: string): Promise<void> {
  if (migratedDataDirs.has(dataDir)) return;
  try {
    await migrateAgentPresetsDataDir(dataDir);
    migratedDataDirs.add(dataDir);
  } catch {
    // 迁移失败（只读目录/权限）不阻断预设读取：沿用旧目录仍可列出用户预设。
  }
}

/** 预设清单（内置在前，用户目录发现的后缀；内置被用户覆盖时合并为单项并标记 overridden）。 */
export async function listPresets(dataDir: string, warn?: PresetWarn): Promise<PresetSummary[]> {
  await ensureMigrated(dataDir);
  const users = await loadUserPresets(dataDir, warn);
  const userById = new Map(users.map((preset) => [preset.id, preset]));
  return [
    ...BUILTIN_PRESETS.map((preset) => {
      const override = userById.get(preset.id);
      const merged = override ? mergeBuiltinOverride(preset, override) : preset;
      return {
        id: preset.id,
        name: merged.name,
        description: descriptionOf(merged),
        category: categoryOf(merged, true),
        builtin: true,
        ...(override ? { overridden: true } : {}),
      };
    }),
    ...users
      .filter((preset) => !builtinById(preset.id))
      .map((preset) => ({ id: preset.id, name: preset.name, description: descriptionOf(preset), category: categoryOf(preset, false), builtin: false })),
  ];
}

/** 按 id 取完整预设；用户覆盖优先（内置 id 的覆盖返回合并形态并标记 overridden）。 */
export async function getPreset(dataDir: string, id: string, warn?: PresetWarn): Promise<PresetDetail | null> {
  await ensureMigrated(dataDir);
  const user = (await loadUserPresets(dataDir, warn)).find((preset) => preset.id === id);
  if (user) {
    const builtin = builtinById(id);
    const merged = builtin ? mergeBuiltinOverride(builtin, user) : user;
    return {
      ...merged,
      description: descriptionOf(merged),
      category: categoryOf(merged, Boolean(builtin)),
      builtin: Boolean(builtin),
      ...(builtin ? { overridden: true } : {}),
    };
  }
  const builtin = builtinById(id);
  return builtin ? { ...builtin, description: descriptionOf(builtin), category: categoryOf(builtin, true), builtin: true } : null;
}

/**
 * 按 config.preset 解析预设；兼容旧 config.persona。
 * sessionOverride（会话级 preset）非空时优先于扩展全局配置；`classic` 强制返回 null。
 */
export async function resolvePreset(dataDir: string, config: Record<string, unknown>, warn: PresetWarn = () => undefined, sessionOverride?: string): Promise<AgentPreset | null> {
  const override = typeof sessionOverride === "string" ? sessionOverride.trim() : "";
  const configured = typeof config.preset === "string"
    ? config.preset.trim()
    : typeof config.persona === "string"
      ? config.persona.trim()
      : "";
  const id = override || configured;
  if (!id || id === "classic") return null;
  await ensureMigrated(dataDir);
  const user = (await loadUserPresets(dataDir, warn)).find((preset) => preset.id === id);
  if (user) {
    const builtin = builtinById(id);
    return builtin ? mergeBuiltinOverride(builtin, user) : user;
  }
  const builtin = builtinById(id);
  if (builtin) return builtin;
  warn(`agent-presets: unknown preset "${id}"; classic behavior enabled`);
  return null;
}
