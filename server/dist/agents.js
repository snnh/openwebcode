import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
export function parseAgentMarkdown(text, fallbackName, source) {
    if (text.startsWith("---") && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text))
        return undefined;
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match)
        return undefined;
    const meta = {};
    const listMeta = {};
    let listKey;
    for (const line of match[1].split(/\r?\n/)) {
        const item = line.match(/^\s*-\s*(.+?)\s*$/);
        if (item && listKey) {
            listMeta[listKey].push(item[1].replace(/^['"]|['"]$/g, ""));
            continue;
        }
        const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (!kv) {
            listKey = undefined;
            continue;
        }
        const key = kv[1].toLowerCase();
        meta[key] = kv[2].trim();
        listKey = meta[key] === "" ? key : undefined;
        if (listKey)
            listMeta[listKey] = [];
    }
    const description = meta.description?.trim();
    const body = match[2].trim();
    if (!description || !body)
        return undefined;
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
    globalDir;
    constructor(globalDir) {
        this.globalDir = globalDir;
    }
    async listFor(cwd) {
        const byName = new Map();
        for (const agent of await this.scan(this.globalDir, "global"))
            byName.set(agent.name, agent);
        for (const agent of await this.scan(path.join(cwd, ".owc", "agents"), "project"))
            byName.set(agent.name, agent);
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    async find(cwd, name) {
        return (await this.listFor(cwd)).find((agent) => agent.name === name);
    }
    async scan(dir, source) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const agents = [];
        for (const entry of entries) {
            if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md")
                continue;
            try {
                const filePath = path.join(dir, entry.name);
                const agent = parseAgentMarkdown(await readFile(filePath, "utf8"), path.basename(entry.name, path.extname(entry.name)), source);
                if (agent)
                    agents.push(agent);
            }
            catch {
                // unreadable or malformed definitions are ignored
            }
        }
        return agents;
    }
}
