import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { isModelRole, type ModelRole } from "./model-roles.js";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  /** 显式 provider 覆盖（frontmatter provider:；与 model: 一起优先于 role: 与调用级 role）。 */
  provider?: string;
  /** 模型角色档（frontmatter role:；仅 premium/balanced/fast/cheap，非法值静默忽略、保留定义本身——与 tools 解析的宽松风格一致）。 */
  role?: ModelRole;
  body: string;
  source: "project" | "global";
}

export function parseAgentMarkdown(
  text: string,
  fallbackName: string,
  source: "project" | "global",
): AgentDefinition | undefined {
  if (text.startsWith("---") && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) return undefined;
  const { meta, listMeta, body: rawBody } = parseFrontmatter(text);
  if (rawBody === text) return undefined;
  const description = meta.description?.trim();
  const body = rawBody.trim();
  if (!description || !body) return undefined;

  const rawTools = meta.tools?.trim();
  const tools = listMeta.tools?.length
    ? listMeta.tools
    : rawTools
      ? rawTools.replace(/^\[|\]$/g, "").split(",").map((tool) => tool.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
      : undefined;
  return {
    name: meta.name || fallbackName,
    description,
    ...(tools ? { tools } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.role && isModelRole(meta.role) ? { role: meta.role } : {}),
    body,
    source,
  };
}

export class AgentRegistry {
  private readonly scanCache = new Map<string, { fingerprint: string; agents: AgentDefinition[] }>();

  constructor(private readonly globalDir: string) {}

  async listFor(cwd: string): Promise<AgentDefinition[]> {
    const byName = new Map<string, AgentDefinition>();
    for (const agent of await this.scan(this.globalDir, "global")) byName.set(agent.name, agent);
    for (const agent of await this.scan(path.join(cwd, ".owc", "agents"), "project")) byName.set(agent.name, agent);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 仅全局目录（无项目 cwd 时的 REST 目录查询）。 */
  async listGlobal(): Promise<AgentDefinition[]> {
    return this.scan(this.globalDir, "global");
  }

  async find(cwd: string, name: string): Promise<AgentDefinition | undefined> {
    return (await this.listFor(cwd)).find((agent) => agent.name === name);
  }

  private async scan(dir: string, source: "project" | "global"): Promise<AgentDefinition[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".md")
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
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
    if (cached?.fingerprint === fingerprint) return cached.agents.map((agent) => ({ ...agent, ...(agent.tools ? { tools: [...agent.tools] } : {}) }));
    const agents = (await Promise.all(usable.map(async ({ name, filePath }) => {
      try { return parseAgentMarkdown(await readFile(filePath, "utf8"), path.basename(name, path.extname(name)), source); } catch { return undefined; }
    }))).filter((agent): agent is AgentDefinition => agent !== undefined);
    this.scanCache.set(dir, { fingerprint, agents });
    return agents.map((agent) => ({ ...agent, ...(agent.tools ? { tools: [...agent.tools] } : {}) }));
  }
}
