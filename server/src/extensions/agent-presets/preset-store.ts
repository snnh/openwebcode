import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../../atomic-file.js";
import type { AgentPreset, PresetAlias } from "./types.js";
import { PRESET_TOOL_NAMES } from "./tool-catalog.js";

/** 预设 id 只接受文件名安全字符（一个文件一个预设，id 即文件名）。 */
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 用户预设目录：<dataDir>/agent-presets/presets/*.json，一个文件一个预设（分享机制：拷入即用）。 */
export function presetsDir(dataDir: string): string {
  return path.join(dataDir, "agent-presets", "presets");
}

export type PresetWarn = (message: string) => void;

function parseAlias(raw: unknown): PresetAlias | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.from !== "string" || typeof record.as !== "string" || !record.from || !record.as) return undefined;
  const inputSchema = record.inputSchema && typeof record.inputSchema === "object" && !Array.isArray(record.inputSchema)
    ? record.inputSchema as Record<string, unknown>
    : undefined;
  const argMap = record.argMap && typeof record.argMap === "object" && !Array.isArray(record.argMap)
    && Object.values(record.argMap as Record<string, unknown>).every((value) => typeof value === "string")
    ? record.argMap as Record<string, string>
    : undefined;
  return {
    from: record.from,
    as: record.as,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(argMap ? { argMap } : {}),
  };
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function optionalStrings(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? strings(raw) : undefined;
}

function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

/** 宽松解析单个预设文件；形状不合返回 undefined（调用方记警告并跳过，绝不抛错）。 */
function parsePreset(raw: unknown, fallbackId: string): AgentPreset | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id ? record.id : fallbackId;
  if (typeof record.name !== "string" || !record.name) return undefined;
  // minimal 预设允许空 identity（构建器回退默认身份行）。
  if (typeof record.identity !== "string") return undefined;
  if (typeof record.basePrompt !== "string" || !record.basePrompt) return undefined;
  const aliases = (Array.isArray(record.aliases) ? record.aliases : []).map(parseAlias);
  if (aliases.some((alias) => !alias)) return undefined;
  const optionalPrompt = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const initPrompt = optionalPrompt(record.initPrompt);
  const compactOverviewPrompt = optionalPrompt(record.compactOverviewPrompt);
  const compactToolcallsPrompt = optionalPrompt(record.compactToolcallsPrompt);
  const userAgent = optionalPrompt(record.userAgent);
  const description = optionalPrompt(record.description);
  const category = record.category === "minimal" || record.category === "mimicry" || record.category === "custom"
    ? record.category
    : undefined;
  const promptStyle = record.promptStyle === "minimal" || record.promptStyle === "classic" ? record.promptStyle : undefined;
  const projectContext = record.projectContext === "paths" || record.projectContext === "content" || record.projectContext === "none"
    ? record.projectContext
    : undefined;
  const allowedBuiltIns = optionalStrings(record.allowedBuiltIns);
  const toolDescriptions = stringRecord(record.toolDescriptions);
  return {
    id,
    name: record.name,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    identity: record.identity,
    basePrompt: record.basePrompt,
    productSections: strings(record.productSections),
    ...(allowedBuiltIns ? { allowedBuiltIns } : {}),
    hideBuiltIns: strings(record.hideBuiltIns),
    ...(promptStyle ? { promptStyle } : {}),
    ...(projectContext ? { projectContext } : {}),
    ...(typeof record.externalTools === "boolean" ? { externalTools: record.externalTools } : {}),
    aliases: aliases.filter((alias): alias is PresetAlias => Boolean(alias)),
    ...(toolDescriptions ? { toolDescriptions } : {}),
    ...(Array.isArray(record.firstTurnOnlyTools) ? { firstTurnOnlyTools: strings(record.firstTurnOnlyTools) } : {}),
    ...(initPrompt ? { initPrompt } : {}),
    ...(compactOverviewPrompt ? { compactOverviewPrompt } : {}),
    ...(compactToolcallsPrompt ? { compactToolcallsPrompt } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

/** 保存时严格校验工具名；加载旧文件时宽松（兼容旧预设形状）。 */
function validatePresetTools(preset: AgentPreset): void {
  const allowed = new Set<string>(PRESET_TOOL_NAMES);
  // spawn_task 是 subagent 的旧名，保存时拒绝新写。
  const bad = (name: string, field: string): void => {
    if (!allowed.has(name)) throw new Error(`unknown tool "${name}" in ${field}`);
  };
  for (const name of preset.allowedBuiltIns ?? []) {
    bad(name, "allowedBuiltIns");
    // read_artifact 是自动注入工具（驱逐/截断联动），不能进白名单。
    if (name === "read_artifact") throw new Error('"read_artifact" is injected automatically and cannot be in allowedBuiltIns');
  }
  for (const name of preset.hideBuiltIns) bad(name, "hideBuiltIns");
  for (const name of Object.keys(preset.toolDescriptions ?? {})) bad(name, "toolDescriptions");
  for (const alias of preset.aliases) {
    const from = alias.from === "spawn_task" ? "subagent" : alias.from;
    bad(from, "aliases.from");
  }
  // 精简形态必须保留 bash：工具白名单是硬上限，去掉 bash 等于失去唯一的执行出口。
  const minimalStyle = preset.promptStyle === "minimal" || preset.id === "minimal";
  if (minimalStyle && preset.allowedBuiltIns !== undefined && !preset.allowedBuiltIns.includes("bash")) {
    throw new Error("minimal presets must keep \"bash\" in allowedBuiltIns");
  }
  const visible = new Set(preset.allowedBuiltIns?.length
    ? preset.allowedBuiltIns.filter((name) => !preset.hideBuiltIns.includes(name))
    : [...allowed].filter((name) => !preset.hideBuiltIns.includes(name)));
  for (const alias of preset.aliases) visible.add(alias.as);
  for (const name of preset.firstTurnOnlyTools ?? []) {
    if (!visible.has(name) && name !== "spawn_task") throw new Error(`unknown or hidden tool "${name}" in firstTurnOnlyTools`);
  }
}

/**
 * 读取用户预设目录；无效文件一律跳过并记警告，重复 id（用户文件之间）跳过。
 * 与内置同 id 的文件是「内置覆盖」——保留并返回（解析侧用户优先），不再跳过。
 * 目录不存在时懒创建。
 */
export async function loadUserPresets(dataDir: string, warn: PresetWarn = () => undefined): Promise<AgentPreset[]> {
  const directory = presetsDir(dataDir);
  await mkdir(directory, { recursive: true }).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const presets: AgentPreset[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    const fallbackId = entry.name.replace(/\.json$/, "");
    try {
      const preset = parsePreset(JSON.parse(await readFile(file, "utf8")), fallbackId);
      if (!preset) {
        warn(`agent-presets: preset file ${entry.name} has an invalid shape; skipped`);
        continue;
      }
      if (presets.some((item) => item.id === preset.id)) {
        warn(`agent-presets: preset id "${preset.id}" collides with another user preset; skipped`);
        continue;
      }
      presets.push(preset);
    } catch (error) {
      warn(`agent-presets: failed to load preset ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return presets;
}

/**
 * 保存用户预设：<dataDir>/agent-presets/presets/<id>.json 原子写（0600，覆盖同 id 旧文件）。
 * 形状经 parsePreset 宽松校验 + 工具名严格校验；与内置同 id 时写入覆盖文件（解析侧用户优先，
 * 字段级继承内置未提供部分）——即「自定义内置预设」；非法 id 一律抛错（REST 层映射 400）。
 */
export async function saveUserPreset(dataDir: string, raw: unknown): Promise<AgentPreset> {
  const preset = parsePreset(raw, "");
  if (!preset) throw new Error("invalid preset shape: id/name/identity/basePrompt are required, and every alias needs from/as");
  if (!PRESET_ID_PATTERN.test(preset.id)) throw new Error(`invalid preset id "${preset.id}": lowercase letters, digits, '-' and '_' only, starting with a letter or digit`);
  if (preset.id === "classic") throw new Error("preset id \"classic\" is reserved");
  validatePresetTools(preset);
  const directory = presetsDir(dataDir);
  await mkdir(directory, { recursive: true });
  await writeUtf8Atomically(path.join(directory, `${preset.id}.json`), `${JSON.stringify(preset, null, 2)}\n`, { mode: 0o600 });
  return preset;
}

/**
 * 删除用户预设：仅删用户目录文件。内置 id 时删除覆盖文件（还原内置），无覆盖文件返回 false；
 * 未命中返回 false。非法 id 抛错。
 */
export async function deleteUserPreset(dataDir: string, id: string): Promise<boolean> {
  if (!PRESET_ID_PATTERN.test(id)) throw new Error(`invalid preset id "${id}"`);
  try {
    await unlink(path.join(presetsDir(dataDir), `${id}.json`));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
