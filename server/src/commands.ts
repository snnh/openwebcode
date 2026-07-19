import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface CommandDefinition {
  name: string;
  description?: string;
  body: string;
  source: "project" | "global";
}

export function parseCommandMarkdown(
  text: string,
  fallbackName: string,
  source: "project" | "global",
): CommandDefinition | undefined {
  let body = text;
  let description: string | undefined;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (text.startsWith("---") && !match) return undefined;
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
      if (kv?.[1]?.toLowerCase() === "description" && kv[2]!.trim() !== "") description = kv[2]!.trim();
    }
    body = match[2]!;
  }
  if (body.trim() === "") return undefined;
  return { name: fallbackName, ...(description ? { description } : {}), body: body.trim(), source };
}

export function renderCommand(body: string, args: string): string {
  const words = args.trim() === "" ? [] : args.trim().split(/\s+/);
  return body.replace(/\$ARGUMENTS|\$([1-9])/g, (placeholder, index: string | undefined) =>
    placeholder === "$ARGUMENTS" ? args : words[Number(index) - 1] ?? "");
}

export class CommandRegistry {
  constructor(private readonly globalDir: string) {}

  async listFor(cwd: string): Promise<CommandDefinition[]> {
    const byName = new Map<string, CommandDefinition>();
    for (const command of await this.scan(this.globalDir, "global")) byName.set(command.name, command);
    for (const command of await this.scan(path.join(cwd, ".owc", "commands"), "project")) byName.set(command.name, command);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async find(cwd: string, name: string): Promise<CommandDefinition | undefined> {
    return (await this.listFor(cwd)).find((command) => command.name === name);
  }

  private async scan(dir: string, source: "project" | "global"): Promise<CommandDefinition[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const commands: CommandDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      try {
        const filePath = path.join(dir, entry.name);
        const command = parseCommandMarkdown(await readFile(filePath, "utf8"), path.basename(entry.name, path.extname(entry.name)), source);
        if (command) commands.push(command);
      } catch {
        // unreadable command definitions are ignored
      }
    }
    return commands;
  }
}
