import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  source: "global" | "project";
  path: string;
}

/**
 * 解析 SKILL.md：可选 --- frontmatter（name/description）+ Markdown 正文。
 * name 缺省回退为目录名；正文为空视为无效技能。
 */
export function parseSkillMarkdown(text: string, fallbackName: string, source: "global" | "project", filePath: string): Skill | undefined {
  let body = text;
  const meta: Record<string, string> = {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
      if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim();
    }
    body = match[2]!;
  }
  if (body.trim() === "") return undefined;
  return {
    name: meta.name && meta.name !== "" ? meta.name : fallbackName,
    description: meta.description ?? "",
    body: body.trim(),
    source,
    path: filePath,
  };
}

/** 输入框 `/名称 补充` 命令解析；不匹配（普通文本/多行且非命令形态）返回 undefined。 */
export function parseSkillCommand(text: string): { name: string; rest: string } | undefined {
  const match = text.match(/^\/([A-Za-z0-9][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { name: match[1]!, rest: (match[2] ?? "").trim() };
}

/**
 * 技能注册表：全局 <dataDir>/skills/<name>/SKILL.md + 项目级 <cwd>/.owc/skills/<name>/SKILL.md。
 * 项目级覆盖同名全局技能；每次调用现扫（文件少、保证热更新，无需缓存失效逻辑）。
 */
export class SkillRegistry {
  constructor(private readonly globalDir: string) {}

  async listFor(cwd?: string): Promise<Skill[]> {
    const byName = new Map<string, Skill>();
    for (const skill of await this.scan(this.globalDir, "global")) byName.set(skill.name, skill);
    if (cwd) {
      for (const skill of await this.scan(path.join(cwd, ".owc", "skills"), "project")) byName.set(skill.name, skill);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async find(cwd: string | undefined, name: string): Promise<Skill | undefined> {
    return (await this.listFor(cwd)).find((skill) => skill.name === name);
  }

  private async scan(dir: string, source: "global" | "project"): Promise<Skill[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(dir, entry.name, "SKILL.md");
      try {
        const skill = parseSkillMarkdown(await readFile(filePath, "utf8"), entry.name, source, filePath);
        if (skill) skills.push(skill);
      } catch {
        // 无 SKILL.md 或读取失败的目录直接跳过
      }
    }
    return skills;
  }
}
