import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  body: string;
  source: "project" | "global";
}

export function parseAgentMarkdown(
  text: string,
  fallbackName: string,
  source: "project" | "global",
): AgentDefinition | undefined {
  if (text.startsWith("---") && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) return undefined;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;

  const meta: Record<string, string> = {};
  const listMeta: Record<string, string[]> = {};
  let listKey: string | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item && listKey) {
      listMeta[listKey]!.push(item[1]!.replace(/^['"]|['"]$/g, ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) {
      listKey = undefined;
      continue;
    }
    const key = kv[1]!.toLowerCase();
    meta[key] = kv[2]!.trim();
    listKey = meta[key] === "" ? key : undefined;
    if (listKey) listMeta[listKey] = [];
  }
  const description = meta.description?.trim();
  const body = match[2]!.trim();
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
    body,
    source,
  };
}

export class AgentRegistry {
  constructor(private readonly globalDir: string) {}

  async listFor(cwd: string): Promise<AgentDefinition[]> {
    const byName = new Map<string, AgentDefinition>();
    for (const agent of await this.scan(this.globalDir, "global")) byName.set(agent.name, agent);
    for (const agent of await this.scan(path.join(cwd, ".owc", "agents"), "project")) byName.set(agent.name, agent);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
    const agents: AgentDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      try {
        const filePath = path.join(dir, entry.name);
        const agent = parseAgentMarkdown(await readFile(filePath, "utf8"), path.basename(entry.name, path.extname(entry.name)), source);
        if (agent) agents.push(agent);
      } catch {
        // unreadable or malformed definitions are ignored
      }
    }
    return agents;
  }
}
