import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { isModelRole, type ModelRole } from "./model-roles.js";

interface AgentDefinition {
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

function parseAgentMarkdown(
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

/**
 * 目录扫描缓存条数上限：每个访问过的目录（全局 agents 目录 + 每个项目的 .owc/agents）都常驻
 * 一份 agent 正文全文，多项目长跑时目录数只增不减——限 64 个目录并按 LRU 逐出，缓存不再无限膨胀。
 */
const MAX_CACHED_DIRS = 64;

interface ScanCacheEntry {
  fingerprint: string;
  agents: AgentDefinition[];
}

export class AgentRegistry {
  private readonly scanCache = new Map<string, ScanCacheEntry>();

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
    if (cached?.fingerprint === fingerprint) {
      this.rememberScan(dir, cached); // 命中同样刷新热度（真 LRU：频繁访问的目录不被逐出）
      return cached.agents.map((agent) => ({ ...agent, ...(agent.tools ? { tools: [...agent.tools] } : {}) }));
    }
    const agents = (await Promise.all(usable.map(async ({ name, filePath }) => {
      try { return parseAgentMarkdown(await readFile(filePath, "utf8"), path.basename(name, path.extname(name)), source); } catch { return undefined; }
    }))).filter((agent): agent is AgentDefinition => agent !== undefined);
    this.rememberScan(dir, { fingerprint, agents });
    return agents.map((agent) => ({ ...agent, ...(agent.tools ? { tools: [...agent.tools] } : {}) }));
  }

  /** 扫描缓存落账（LRU）：写入/命中都先 delete 再 set 刷新热度（Map 迭代序即插入序），
   *  超出条数上限逐出最旧目录——条目含 agent 正文全文，不能按目录常驻不还。 */
  private rememberScan(dir: string, entry: ScanCacheEntry): void {
    this.scanCache.delete(dir);
    this.scanCache.set(dir, entry);
    while (this.scanCache.size > MAX_CACHED_DIRS) {
      this.scanCache.delete(this.scanCache.keys().next().value!);
    }
  }
}
