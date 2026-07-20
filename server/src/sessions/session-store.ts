import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { parseSessionImport, serializeSession } from "./session-transfer.js";
import type { ChatMessage, ManagedWorkspaceMeta, MessageContent, MessageRole, SandboxMode, SessionDetail, SessionMeta } from "./types.js";

export interface CreateSessionInput {
  cwd: string;
  provider?: string;
  model?: string;
  title?: string;
  agentMode?: "plan" | "build";
  sandboxMode?: SandboxMode;
  setupScript?: string;
  /** 托管工作区：调用方预分配 id（镜像/挂载路径按 id 推导，必须先于 create 准备） */
  id?: string;
  workspace?: ManagedWorkspaceMeta;
  /** 托管工作区预设快照后端名（vhdx-chain/qcow2-chain），跳过探测 */
  snapshotBackend?: string;
}

export class SessionStore {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async create(input: CreateSessionInput): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const resolvedCwd = path.resolve(input.cwd);
    const meta: SessionMeta = {
      id: input.id ?? randomUUID(),
      cwd: resolvedCwd,
      provider: input.provider ?? "development",
      model: input.model ?? "deterministic-tool-loop",
      sandbox: { enabled: true, readRoots: [resolvedCwd], writeRoots: [resolvedCwd], denyPaths: [path.join(resolvedCwd, ".env")], network: "allow" },
      title: input.title ?? "New session",
      createdAt: now,
      updatedAt: now,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.snapshotBackend ? { snapshotBackend: input.snapshotBackend } : {}),
    };
    // appcontainer 为默认不落盘；setupScript 仅非空时保留
    if (input.sandboxMode && input.sandboxMode !== "appcontainer") meta.sandboxMode = input.sandboxMode;
    if (input.setupScript?.trim()) meta.setupScript = input.setupScript;
    if (input.agentMode === "plan") meta.agentMode = "plan";
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

  async updateConfig(id: string, update: Pick<SessionMeta, "provider" | "model"> & Partial<Pick<SessionMeta, "thinking" | "effort" | "agentMode" | "snapshotMode">>): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    meta.provider = update.provider;
    meta.model = update.model;
    if (update.thinking === undefined) delete meta.thinking;
    else meta.thinking = update.thinking;
    if (update.effort === undefined) delete meta.effort;
    else meta.effort = update.effort;
    if (update.agentMode === undefined || update.agentMode === "build") delete meta.agentMode;
    else meta.agentMode = update.agentMode;
    if (update.snapshotMode === undefined || update.snapshotMode === "auto") delete meta.snapshotMode;
    else meta.snapshotMode = update.snapshotMode;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  async truncateMessages(id: string, count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Message count must be a non-negative integer");
    const detail = await this.get(id);
    if (!detail) throw new Error("Session not found");
    const messages = detail.messages.slice(0, count);
    await writeFile(this.messagesPath(id), messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length ? "\n" : ""), "utf8");
    const meta = await this.readMeta(id);
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
  }

  async updatePermissions(id: string, permissionMode: SessionMeta["permissionMode"], permissionRules: NonNullable<SessionMeta["permissionRules"]>): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    if (permissionMode === undefined) delete meta.permissionMode;
    else meta.permissionMode = permissionMode;
    meta.permissionRules = permissionRules.map((rule) => ({ ...rule }));
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /** 更新沙盒模式；appcontainer/空 setupScript 视为缺省（从 meta 删除） */
  async updateSandboxMode(id: string, sandboxMode: SandboxMode | undefined, setupScript: string | undefined): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    if (!sandboxMode || sandboxMode === "appcontainer") delete meta.sandboxMode;
    else meta.sandboxMode = sandboxMode;
    if (!setupScript?.trim()) delete meta.setupScript;
    else meta.setupScript = setupScript;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /** 记录探测到的快照后端名（zfs 附带数据集："zfs:<dataset>"）。 */
  async updateSnapshotBackend(id: string, backend: string): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    meta.snapshotBackend = backend;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  contextRoot(id: string): string {
    return this.sessionPath(id);
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

  /** 导出为 JSONL：首行 meta，其后每行一条消息；ledger/artifacts 不含在内（上下文按消息重建）。 */
  async exportJsonl(id: string): Promise<string | undefined> {
    const detail = await this.get(id);
    if (!detail) return undefined;
    const { messages, ...meta } = detail;
    return serializeSession(meta as SessionMeta, messages);
  }

  /** 导入 JSONL：原 id 未被占用则沿用（迁移恢复），否则分配新 id。 */
  async importJsonl(text: string): Promise<SessionMeta> {
    const parsed = parseSessionImport(text);
    let id = parsed.meta.id ?? randomUUID();
    try {
      await mkdir(this.sessionPath(id), { recursive: false });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        id = randomUUID();
        await mkdir(this.sessionPath(id), { recursive: false });
      } else {
        throw error;
      }
    }
    const { id: _ignored, ...restMeta } = parsed.meta;
    const meta: SessionMeta = { ...restMeta, id };
    await this.writeMeta(meta);
    await writeFile(
      this.messagesPath(id),
      parsed.messages.map((message) => JSON.stringify(message)).join("\n") + (parsed.messages.length ? "\n" : ""),
      "utf8",
    );
    return meta;
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
    const target = this.metaPath(meta.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
