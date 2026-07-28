import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { parseSessionImport, serializeSession } from "./session-transfer.js";
import { defaultSandboxPolicy } from "./default-sandbox.js";
import { readMessagesTail, readMessagesBefore, checkRecovery, DEFAULT_PAGE_SIZE } from "./message-reader.js";
import type { ChatMessage, ManagedWorkspaceMeta, MessageContent, MessageRole, MessagesPage, SandboxMode, SessionDetail, SessionMeta } from "./types.js";

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
  /** 首条用户消息派生标题时回调（"New session" → 派生标题）；由装配层接线为 session.updated 事件 */
  onDerivedTitle?: (meta: SessionMeta) => void;

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
      // API callers resolve a configured provider/model before creating a session.
      // Keep direct store use neutral rather than choosing an implicit provider.
      provider: input.provider ?? "",
      model: input.model ?? "",
      sandbox: defaultSandboxPolicy(resolvedCwd),
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
          const meta = await this.readMeta(entry.name);
          // 0.5.0 Phase 2: only check tail corruption for list() — full scan deferred to get()
          const { recovery } = await checkRecovery(this.messagesPath(entry.name));
          return { ...meta, ...(recovery ? { recovery } : {}) };
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
    const { messages, recovery } = await this.readMessages(id);
    return { ...meta, ...(recovery ? { recovery } : {}), messages };
  }

  /**
   * 0.5.0 Phase 2: paginated session load.
   * Returns meta + last `limit` messages + pagination metadata.
   * Only JSON.parses the returned page — not the entire history.
   */
  async getTail(id: string, limit: number = DEFAULT_PAGE_SIZE): Promise<SessionDetail | undefined> {
    let meta: SessionMeta;
    try {
      meta = await this.readMeta(id);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const page = await readMessagesTail<ChatMessage>(this.messagesPath(id), limit);
    return {
      ...meta,
      ...(page.recovery ? { recovery: page.recovery } : {}),
      messages: page.messages,
      messageCount: page.totalLines,
      hasMoreMessages: page.hasMore,
    };
  }

  /**
   * 0.5.0 Phase 2: load older messages before a given message ID.
   * Used for "load more" pagination when scrolling up in the conversation.
   */
  async getMessagesBefore(id: string, beforeMessageId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<MessagesPage | undefined> {
    // Verify session exists
    try {
      await this.readMeta(id);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const page = await readMessagesBefore<ChatMessage>(this.messagesPath(id), beforeMessageId, limit);
    return { messages: page.messages, hasMore: page.hasMore, totalLines: page.totalLines };
  }

  async appendMessage(
    sessionId: string,
    role: MessageRole,
    content: MessageContent[],
    lineage?: Pick<ChatMessage, "parentId" | "runId" | "turnId">,
  ): Promise<ChatMessage> {
    const meta = await this.readMeta(sessionId);
    const existing = meta.activeLeafId ? undefined : await this.readMessages(sessionId);
    const parentId = lineage?.parentId ?? meta.activeLeafId ?? existing?.messages.at(-1)?.id;
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: now,
      ...(parentId
        ? { parentId }
        : {}),
      ...(lineage?.runId ? { runId: lineage.runId } : {}),
      ...(lineage?.turnId ? { turnId: lineage.turnId } : {}),
    };
    await appendFile(this.messagesPath(sessionId), `${JSON.stringify(message)}\n`, "utf8");
    meta.updatedAt = now;
    meta.activeLeafId = message.id;
    let titleDerived = false;
    if (meta.title === "New session" && role === "user") {
      const firstText = content.find((block) => block.type === "text");
      if (firstText?.type === "text") {
        meta.title = firstText.text.slice(0, 80);
        titleDerived = true;
      }
    }
    await this.writeMeta(meta);
    if (titleDerived) this.onDerivedTitle?.(meta);
    return message;
  }

  async updateConfig(id: string, update: Pick<SessionMeta, "provider" | "model"> & Partial<Pick<SessionMeta, "thinking" | "effort" | "agentMode" | "snapshotMode" | "shellBackend">>): Promise<SessionMeta> {
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
    if (update.shellBackend === undefined || update.shellBackend === "default") delete meta.shellBackend;
    else meta.shellBackend = update.shellBackend;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /** 会话显示属性：title 为用户覆盖（空串清除覆盖并回落到派生标题），pinned 控制列表置顶（false 从 meta 删除）。
   *  纯展示属性：不更新 updatedAt，避免重命名/置顶改变列表排序。 */
  async updateDisplay(id: string, update: { title?: string; pinned?: boolean }): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    if (update.title !== undefined) {
      if (typeof update.title !== "string") throw new Error("title must be a string");
      const trimmed = update.title.trim();
      if (trimmed.length > 120) throw new Error("title must be at most 120 characters");
      meta.title = trimmed || await this.deriveTitle(id);
    }
    if (update.pinned !== undefined) {
      if (typeof update.pinned !== "boolean") throw new Error("pinned must be a boolean");
      if (update.pinned) meta.pinned = true;
      else delete meta.pinned;
    }
    await this.writeMeta(meta);
    return meta;
  }

  /** 派生标题：首条非空用户文本消息的前 80 字符；无消息时回退 "New session"（与 appendMessage 的自动命名一致）。 */
  private async deriveTitle(id: string): Promise<string> {
    const { messages } = await this.readMessages(id);
    for (const message of messages) {
      if (message.role !== "user") continue;
      const text = message.content.find((block) => block.type === "text");
      if (text?.type === "text" && text.text.trim()) return text.text.slice(0, 80);
    }
    return "New session";
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

  /** 选择性上下文（§4.4）：pin/排除清单持久化在会话配置；空清单视为缺省（从 meta 删除）。 */
  async updateContextSelection(id: string, selection: { pins?: string[] | undefined; excludes?: string[] | undefined }): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    const clean = (values: string[] | undefined, label: string): string[] | undefined => {
      if (values === undefined) return undefined;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new Error(`${label} must be an array of strings`);
      }
      const items = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
      if (items.length > 200) throw new Error(`${label} must contain at most 200 entries`);
      if (items.some((value) => value.length > 1024)) throw new Error(`${label} entries must be at most 1024 characters`);
      return items.length > 0 ? items : undefined;
    };
    const pins = clean(selection.pins, "pins");
    const excludes = clean(selection.excludes, "excludes");
    if (pins === undefined) delete meta.contextPins;
    else meta.contextPins = pins;
    if (excludes === undefined) delete meta.contextExcludes;
    else meta.contextExcludes = excludes;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /** repo map 自动注入开关与 token 预算（§4.1）；缺省值不落盘（开 / 2048）。 */
  async updateRepoMapSettings(id: string, settings: { enabled?: boolean | undefined; budget?: number | undefined }): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    if (settings.enabled === undefined || settings.enabled === true) delete meta.repoMapEnabled;
    else meta.repoMapEnabled = false;
    if (settings.budget === undefined) delete meta.repoMapBudget;
    else {
      if (!Number.isSafeInteger(settings.budget) || settings.budget < 64 || settings.budget > 100_000) {
        throw new Error("repo map budget must be an integer between 64 and 100000");
      }
      meta.repoMapBudget = settings.budget;
    }
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

  /** Safe branch fallback: copy history into a separately selected workspace, never share a writable cwd. */
  async cloneCurrent(id: string, cwd: string, title?: string): Promise<SessionDetail> {
    const source = await this.get(id);
    if (!source) throw new Error("Session not found");
    if (path.resolve(cwd) === source.cwd) throw new Error("A cloned session requires a different workspace directory");
    const meta = await this.create({ cwd, provider: source.provider, model: source.model, title: title ?? `${source.title} (clone)`, ...(source.agentMode ? { agentMode: source.agentMode } : {}), ...(source.sandboxMode ? { sandboxMode: source.sandboxMode } : {}), ...(source.setupScript ? { setupScript: source.setupScript } : {}) });
    if (source.thinking !== undefined || source.effort !== undefined || source.snapshotMode !== undefined || source.shellBackend !== undefined) await this.updateConfig(meta.id, { provider: source.provider, model: source.model, ...(source.thinking ? { thinking: source.thinking } : {}), ...(source.effort ? { effort: source.effort } : {}), ...(source.agentMode ? { agentMode: source.agentMode } : {}), ...(source.snapshotMode ? { snapshotMode: source.snapshotMode } : {}), ...(source.shellBackend ? { shellBackend: source.shellBackend } : {}) });
    for (const message of source.messages) await this.appendMessage(meta.id, message.role, message.content, { ...(message.runId ? { runId: message.runId } : {}), ...(message.turnId ? { turnId: message.turnId } : {}) });
    return (await this.get(meta.id))!;
  }

  /**
   * JSONL is append-only, so a process interruption can only normally damage
   * its final record. Keep every valid record and make the recovery state
   * explicit instead of making the complete session disappear from list().
   */
  private async readMessages(id: string): Promise<{ messages: ChatMessage[]; recovery?: NonNullable<SessionMeta["recovery"]> }> {
    let raw: string;
    try {
      raw = await readFile(this.messagesPath(id), "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { messages: [], recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
    }
    const lines = raw.split("\n");
    const nonEmpty = lines.reduce<number[]>((indexes, line, index) => {
      if (line.trim()) indexes.push(index);
      return indexes;
    }, []);
    const last = nonEmpty.at(-1);
    const messages: ChatMessage[] = [];
    let corruptMiddle = false;
    let corruptTail = false;
    for (const index of nonEmpty) {
      try {
        const parsed = JSON.parse(lines[index]!) as ChatMessage;
        // Old linear logs stay untouched on disk; derive their parent links while reading.
        if (!parsed.parentId && messages.length > 0) parsed.parentId = messages.at(-1)!.id;
        messages.push(parsed);
      } catch {
        if (index === last) corruptTail = true;
        else corruptMiddle = true;
      }
    }
    if (corruptMiddle) {
      return { messages, recovery: { state: "needs_repair", message: "messages.jsonl contains corrupt non-tail records" } };
    }
    if (corruptTail) {
      return { messages, recovery: { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" } };
    }
    return { messages };
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    const target = this.metaPath(meta.id);
    await writeUtf8Atomically(target, `${JSON.stringify(meta, null, 2)}\n`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
