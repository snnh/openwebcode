import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

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
  const { meta, body: rawBody } = parseFrontmatter(text);
  if (text.startsWith("---") && rawBody === text) return undefined;
  const description = meta.description?.trim() || undefined;
  const body = rawBody.trim();
  if (body === "") return undefined;
  return { name: fallbackName, ...(description ? { description } : {}), body, source };
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
