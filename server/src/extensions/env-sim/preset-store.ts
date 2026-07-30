import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_PERSONAS } from "./builtin-personas.js";
import type { PersonaAlias, PersonaPreset } from "./types.js";

/** 用户预设目录：<dataDir>/env-sim/personas/*.json，一个文件一个预设（分享机制：拷入即用）。 */
export function personasDir(dataDir: string): string {
  return path.join(dataDir, "env-sim", "personas");
}

export type PresetWarn = (message: string) => void;

function parseAlias(raw: unknown): PersonaAlias | undefined {
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

/** 宽松解析单个预设文件；形状不合返回 undefined（调用方记警告并跳过，绝不抛错）。 */
export function parsePreset(raw: unknown, fallbackId: string): PersonaPreset | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id ? record.id : fallbackId;
  if (typeof record.name !== "string" || !record.name) return undefined;
  if (typeof record.identity !== "string" || !record.identity) return undefined;
  if (typeof record.basePrompt !== "string" || !record.basePrompt) return undefined;
  const aliases = (Array.isArray(record.aliases) ? record.aliases : []).map(parseAlias);
  if (aliases.some((alias) => !alias)) return undefined;
  return {
    id,
    name: record.name,
    identity: record.identity,
    basePrompt: record.basePrompt,
    productSections: strings(record.productSections),
    hideBuiltIns: strings(record.hideBuiltIns),
    aliases: aliases.filter((alias): alias is PersonaAlias => Boolean(alias)),
  };
}

/** 读取用户预设目录；无效文件/内置 id 冲突一律跳过并记警告。目录不存在时懒创建。 */
export async function loadUserPresets(dataDir: string, warn: PresetWarn = () => undefined): Promise<PersonaPreset[]> {
  const directory = personasDir(dataDir);
  await mkdir(directory, { recursive: true }).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const builtinIds = new Set(BUILTIN_PERSONAS.map((preset) => preset.id));
  const presets: PersonaPreset[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    const fallbackId = entry.name.replace(/\.json$/, "");
    try {
      const preset = parsePreset(JSON.parse(await readFile(file, "utf8")), fallbackId);
      if (!preset) {
        warn(`env-sim: preset file ${entry.name} has an invalid shape; skipped`);
        continue;
      }
      if (builtinIds.has(preset.id) || presets.some((item) => item.id === preset.id)) {
        warn(`env-sim: preset id "${preset.id}" collides with ${builtinIds.has(preset.id) ? "a built-in" : "another user"} preset; skipped`);
        continue;
      }
      presets.push(preset);
    } catch (error) {
      warn(`env-sim: failed to load preset ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return presets;
}
