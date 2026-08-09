import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeUtf8Atomically } from "../atomic-file.js";
import { ensureDirWithMode } from "../fs-utils.js";
import type { ChatAssistant } from "./chat-types.js";

/** 聊天助手预设存储（<dataDir>/chat-assistants.json），内存整表 + 原子落盘。 */
export class ChatAssistantStore {
  private assistants: ChatAssistant[] = [];

  constructor(private filePath: string) {}

  /** 加载助手列表；文件缺失/损坏时写入内置默认助手。 */
  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      this.assistants = Array.isArray(raw) ? raw : [];
    } catch {
      this.assistants = this.defaultAssistants();
      await this.persist();
    }
  }

  private defaultAssistants(): ChatAssistant[] {
    const now = new Date().toISOString();
    return [
      { id: randomUUID(), name: "通用助手", description: "General purpose assistant", systemPrompt: "", createdAt: now, updatedAt: now },
      { id: randomUUID(), name: "编程助手", description: "Coding assistant with file and Python tools", systemPrompt: "You are a helpful coding assistant. You can read and write files, execute Python code for computation, and search the web.", toolList: ["python", "read_file", "write_file"], createdAt: now, updatedAt: now },
    ];
  }

  async list(): Promise<ChatAssistant[]> { return [...this.assistants]; }

  async get(id: string): Promise<ChatAssistant | undefined> { return this.assistants.find((a) => a.id === id); }

  async create(init: Omit<ChatAssistant, "id" | "createdAt" | "updatedAt">): Promise<ChatAssistant> {
    const now = new Date().toISOString();
    const assistant: ChatAssistant = { ...init, id: randomUUID(), createdAt: now, updatedAt: now };
    this.assistants.push(assistant);
    await this.persist();
    return assistant;
  }

  async update(id: string, patch: Partial<ChatAssistant>): Promise<ChatAssistant> {
    const index = this.assistants.findIndex((a) => a.id === id);
    if (index === -1) throw new Error(`Assistant not found: ${id}`);
    this.assistants[index] = { ...this.assistants[index]!, ...patch, id, updatedAt: new Date().toISOString() };
    await this.persist();
    return this.assistants[index]!;
  }

  async delete(id: string): Promise<void> {
    this.assistants = this.assistants.filter((a) => a.id !== id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await ensureDirWithMode(path.dirname(this.filePath), 0o700);
    await writeUtf8Atomically(this.filePath, `${JSON.stringify(this.assistants, null, 2)}\n`, { mode: 0o600 });
  }
}
