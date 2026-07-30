import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

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
  const { meta, body: rawBody } = parseFrontmatter(text);
  const body = rawBody.trim();
  if (body === "") return undefined;
  return {
    name: meta.name && meta.name !== "" ? meta.name : fallbackName,
    description: meta.description ?? "",
    body,
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
  private readonly scanCache = new Map<string, { fingerprint: string; skills: Skill[] }>();

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
    const files = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name, "SKILL.md");
        try {
          const info = await lstat(filePath);
          return info.isFile() ? { name: entry.name, filePath, fingerprint: `${entry.name}:${info.size}:${info.mtimeMs}` } : undefined;
        } catch {
          return undefined;
        }
      }));
    const usable = files.filter((file): file is NonNullable<typeof file> => file !== undefined);
    const fingerprint = usable.map((file) => file.fingerprint).join("|");
    const cached = this.scanCache.get(dir);
    if (cached?.fingerprint === fingerprint) return cached.skills.map((skill) => ({ ...skill }));
    const skills = (await Promise.all(usable.map(async ({ name, filePath }) => {
      try { return parseSkillMarkdown(await readFile(filePath, "utf8"), name, source, filePath); } catch { return undefined; }
    }))).filter((skill): skill is Skill => skill !== undefined);
    this.scanCache.set(dir, { fingerprint, skills });
    return skills.map((skill) => ({ ...skill }));
  }
}
