import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, MessageContent, MessageRole, SessionDetail, SessionMeta } from "./types.js";

export interface CreateSessionInput {
  cwd: string;
  provider?: string;
  model?: string;
  title?: string;
}

export class SessionStore {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async create(input: CreateSessionInput): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      cwd: path.resolve(input.cwd),
      provider: input.provider ?? "development",
      model: input.model ?? "deterministic-tool-loop",
      title: input.title ?? "New session",
      createdAt: now,
      updatedAt: now,
    };
    await mkdir(this.sessionPath(meta.id), { recursive: false });
    await this.writeMeta(meta);
    await writeFile(this.messagesPath(meta.id), "", { encoding: "utf8", flag: "wx" });
    return meta;
  }

  async list(): Promise<SessionMeta[]> {
    await this.initialize();
    const entries = await readdir(this.root, { withFileTypes: true });
    const sessions = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try {
          return await this.readMeta(entry.name);
        } catch {
          return undefined;
        }
      }),
    );
    return sessions
      .filter((session): session is SessionMeta => session !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<SessionDetail | undefined> {
    let meta: SessionMeta;
    try {
      meta = await this.readMeta(id);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const raw = await readFile(this.messagesPath(id), "utf8");
    const messages = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatMessage);
    return { ...meta, messages };
  }

  async appendMessage(
    sessionId: string,
    role: MessageRole,
    content: MessageContent[],
  ): Promise<ChatMessage> {
    const meta = await this.readMeta(sessionId);
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: now,
    };
    await appendFile(this.messagesPath(sessionId), `${JSON.stringify(message)}\n`, "utf8");
    meta.updatedAt = now;
    if (meta.title === "New session" && role === "user") {
      const firstText = content.find((block) => block.type === "text");
      if (firstText?.type === "text") meta.title = firstText.text.slice(0, 80);
    }
    await this.writeMeta(meta);
    return message;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.sessionPath(id), { recursive: true, force: false });
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private sessionPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid session ID");
    return path.join(this.root, id);
  }

  private metaPath(id: string): string {
    return path.join(this.sessionPath(id), "meta.json");
  }

  private messagesPath(id: string): string {
    return path.join(this.sessionPath(id), "messages.jsonl");
  }

  private async readMeta(id: string): Promise<SessionMeta> {
    return JSON.parse(await readFile(this.metaPath(id), "utf8")) as SessionMeta;
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    await writeFile(this.metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
