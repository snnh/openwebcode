import { randomUUID } from "node:crypto";
import { appendFile, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { chmodPrivate, ensureDirWithMode, isMissing } from "../fs-utils.js";
import { monotonicTimestamp } from "../monotonic-clock.js";
import { activePathMessages } from "../sessions/session-tree.js";
import { deriveTitleFromMessages, serializeByKey, titleFromContent } from "../sessions/store-utils.js";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { ChatSessionMeta, ChatShare } from "./chat-types.js";

/** 新会话默认标题（首条用户文本消息到达后自动派生替换）。 */
const DEFAULT_TITLE = "New chat";

/** readMessages 整表缓存条数上限（与 SessionStore/message-reader 同一 LRU 纪律）。 */
const MAX_CACHED_MESSAGE_LISTS = 32;

/**
 * 单会话消息整表缓存：size+mtime+ctime 指纹校验（同 SessionStore.messagesCache），
 * 命中时免去整份 messages.jsonl 的 read+全量 JSON.parse（chat 消息可内嵌大 base64 图）。
 * appendMessage 追加穿透（尺寸吻合才增量，否则失效），会话删除一律失效。
 */
interface MessagesCacheEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  messages: ChatMessage[];
}

/**
 * 聊天会话存储：<dataDir>/chat-sessions/<uuid>/{meta.json, messages.jsonl}。
 * 简化版 SessionStore：无沙盒/账本/恢复标记，保留原子写、NDJSON 串行追加
 * 与消息树（parentId + activeLeafId）语义；树遍历直接复用 sessions 的
 * activePathMessages，branch/fork/checkout/retry 与 agent 会话同款。
 */
export class ChatSessionStore {
  /** 按会话 id 的 LRU 消息整表缓存；chat-runner 每条用户消息不再整份重解析。 */
  private readonly messagesCache = new Map<string, MessagesCacheEntry>();

  /** appendMessage 的每会话串行化链：并发追加大消息时底层多次 write 可能交织坏行。 */
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  private get root(): string {
    return path.join(this.dataDir, "chat-sessions");
  }

  async initialize(): Promise<void> {
    // chat-sessions 根目录含会话内容：POSIX 收紧为 0700（Windows no-op）
    await ensureDirWithMode(this.root, 0o700);
  }

  async list(): Promise<ChatSessionMeta[]> {
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
      .filter((session): session is ChatSessionMeta => session !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ChatSessionMeta | undefined> {
    try {
      return await this.readMeta(id);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async create(init: {
    provider: string;
    model: string;
    title?: string;
    cwd?: string;
    systemPrompt?: string;
    assistantId?: string;
    enabledTools?: string[];
    sandboxEnabled?: boolean;
    temperature?: number;
  }): Promise<ChatSessionMeta> {
    const now = monotonicTimestamp();
    const meta: ChatSessionMeta = {
      id: randomUUID(),
      title: init.title ?? DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      provider: init.provider,
      model: init.model,
      ...(init.systemPrompt ? { systemPrompt: init.systemPrompt } : {}),
      ...(init.assistantId ? { assistantId: init.assistantId } : {}),
      ...(init.enabledTools ? { enabledTools: init.enabledTools } : {}),
      ...(init.sandboxEnabled !== undefined ? { sandboxEnabled: init.sandboxEnabled } : {}),
      ...(init.temperature !== undefined ? { temperature: init.temperature } : {}),
      ...(init.cwd ? { cwd: path.resolve(init.cwd) } : {}),
    };
    await ensureDirWithMode(this.sessionPath(meta.id), 0o700);
    await this.writeMeta(meta);
    await writeFile(this.messagesPath(meta.id), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmodPrivate(this.messagesPath(meta.id), 0o600);
    return meta;
  }

  async rename(id: string, title: string): Promise<ChatSessionMeta> {
    const meta = await this.readMeta(id);
    meta.title = title.trim() || await this.deriveTitle(id);
    // 纯展示属性：不更新 updatedAt，避免重命名改变列表排序（与 session-store 同款纪律）
    await this.writeMeta(meta);
    return meta;
  }

  async delete(id: string): Promise<void> {
    this.messagesCache.delete(id);
    await rm(this.sessionPath(id), { recursive: true, force: true });
  }

  async appendMessage(
    id: string,
    role: "user" | "assistant" | "tool",
    content: MessageContent[],
    lineage?: { parentId?: string; runId?: string; turnId?: string },
  ): Promise<ChatMessage> {
    return serializeByKey(this.appendChains, id, () => this.appendMessageSerialized(id, role, content, lineage));
  }

  private async appendMessageSerialized(
    id: string,
    role: "user" | "assistant" | "tool",
    content: MessageContent[],
    lineage?: { parentId?: string; runId?: string; turnId?: string },
  ): Promise<ChatMessage> {
    const meta = await this.readMeta(id);
    const existing = meta.activeLeafId ? undefined : await this.readMessages(id);
    const parentId = lineage?.parentId ?? meta.activeLeafId ?? existing?.at(-1)?.id;
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: now,
      ...(parentId ? { parentId } : {}),
      ...(lineage?.runId ? { runId: lineage.runId } : {}),
      ...(lineage?.turnId ? { turnId: lineage.turnId } : {}),
    };
    const appendedLine = `${JSON.stringify(message)}\n`;
    await appendFile(this.messagesPath(id), appendedLine, "utf8");
    await this.noteAppendedMessage(id, message, Buffer.byteLength(appendedLine, "utf8"));
    meta.updatedAt = now;
    meta.activeLeafId = message.id;
    if (!meta.rootId) meta.rootId = message.id;
    // 首条用户文本消息派生标题（前 80 字符，与 session-store 一致）
    if (meta.title === DEFAULT_TITLE && role === "user") {
      const derived = titleFromContent(content);
      if (derived !== undefined) meta.title = derived;
    }
    await this.writeMeta(meta);
    return message;
  }

  /** 整表读取 messages.jsonl；损坏行静默跳过（简化处理，不上报恢复状态）。 */
  async getMessages(id: string): Promise<ChatMessage[]> {
    return this.readMessages(id);
  }

  /** 读取 beforeId 之前（不含）的最近 limit 条消息，用于向上翻页加载。 */
  async getMessagesBefore(id: string, beforeId: string, limit: number): Promise<ChatMessage[]> {
    const messages = await this.readMessages(id);
    const index = messages.findIndex((message) => message.id === beforeId);
    if (index === -1) return [];
    return messages.slice(Math.max(0, index - limit), index);
  }

  /** patch.share 显式传 undefined 表示撤销分享（删除该键而非落盘 undefined）。 */
  async updateMeta(id: string, patch: Partial<Omit<ChatSessionMeta, "share">> & { share?: ChatShare | undefined }): Promise<ChatSessionMeta> {
    const meta = await this.readMeta(id);
    const { share, ...rest } = patch;
    const next: ChatSessionMeta = { ...meta, ...rest, id, updatedAt: new Date().toISOString() };
    if (share) next.share = share;
    else if ("share" in patch) delete next.share;
    await this.writeMeta(next);
    return next;
  }

  /** 分支：复制当前活动路径到新会话（等价于从活动叶子 fork）。 */
  async branch(id: string): Promise<ChatSessionMeta> {
    return this.fork(id);
  }

  /**
   * fork：从指定消息（缺省当前活动叶子）复制根→leaf 的活动路径到新会话，
   * 消息获得新 id，父链沿路径线性重建，新会话活动叶子落在最后一条复制消息上。
   */
  async fork(id: string, messageId?: string): Promise<ChatSessionMeta> {
    const source = await this.get(id);
    if (!source) throw new Error("Session not found");
    const messages = await this.readMessages(id);
    if (messageId !== undefined && !messages.some((message) => message.id === messageId)) {
      throw new Error("Message not found");
    }
    const leafId = messageId ?? source.activeLeafId ?? messages.at(-1)?.id;
    const activePath = leafId ? activePathMessages(messages, leafId) : [];
    const meta = await this.create({
      provider: source.provider,
      model: source.model,
      title: `${source.title} (分支)`,
      ...(source.cwd ? { cwd: source.cwd } : {}),
    });
    for (const message of activePath) {
      await this.appendMessage(meta.id, message.role, message.content, {
        ...(message.runId ? { runId: message.runId } : {}),
        ...(message.turnId ? { turnId: message.turnId } : {}),
      });
    }
    return (await this.get(meta.id))!;
  }

  /** checkout：切换活动叶子（meta-only，不触碰 messages.jsonl）；messageId 必须存在。 */
  async checkout(id: string, messageId: string): Promise<ChatSessionMeta> {
    const messages = await this.readMessages(id);
    if (!messages.some((message) => message.id === messageId)) throw new Error("Message not found");
    const meta = await this.readMeta(id);
    meta.activeLeafId = messageId;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /**
   * retry：回溯到指定用户消息的父消息（活动叶子设为其 parentId），
   * 下一次 appendMessage 即从该点长出新分支，旧分支消息保留在 JSONL 中。
   */
  async retry(id: string, messageId: string): Promise<ChatSessionMeta> {
    const messages = await this.readMessages(id);
    const target = messages.find((message) => message.id === messageId);
    if (!target) throw new Error("Message not found");
    if (target.role !== "user") throw new Error("Can only retry from a user message");
    const meta = await this.readMeta(id);
    if (target.parentId) meta.activeLeafId = target.parentId;
    else delete meta.activeLeafId;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /** 派生标题：首条非空用户文本消息的前 80 字符；无消息时回退默认标题。 */
  private async deriveTitle(id: string): Promise<string> {
    const messages = await this.readMessages(id);
    return deriveTitleFromMessages(messages, DEFAULT_TITLE);
  }

  private async readMessages(id: string): Promise<ChatMessage[]> {
    const filePath = this.messagesPath(id);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(filePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.messagesCache.delete(id);
      return [];
    }
    const cached = this.messagesCache.get(id);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) {
      this.touchMessagesCache(id, cached);
      // 浅拷贝返回：调用方不得改动缓存数组本身（消息对象语义上只读）
      return cached.messages.slice();
    }
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.messagesCache.delete(id);
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ChatMessage;
        // 旧线性日志不落盘迁移；读取时补齐父链
        if (!parsed.parentId && messages.length > 0) parsed.parentId = messages.at(-1)!.id;
        messages.push(parsed);
      } catch {
        // 损坏行跳过（append-only 下正常只可能损坏尾行）
      }
    }
    this.touchMessagesCache(id, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, messages });
    return messages.slice();
  }

  /** LRU 接触：移到最新位并逐出超限旧条目（与 SessionStore 同一纪律）。 */
  private touchMessagesCache(id: string, entry: MessagesCacheEntry): void {
    this.messagesCache.delete(id);
    this.messagesCache.set(id, entry);
    while (this.messagesCache.size > MAX_CACHED_MESSAGE_LISTS) this.messagesCache.delete(this.messagesCache.keys().next().value!);
  }

  /**
   * appendMessage 后的缓存穿透：仅当文件尺寸恰好增长本次追加字节数时才增量
   * push（任何并发/外部写入导致的尺寸不符都降级为整表失效，下次读取重建）。
   */
  private async noteAppendedMessage(id: string, message: ChatMessage, appendedBytes: number): Promise<void> {
    const cached = this.messagesCache.get(id);
    if (!cached) return;
    try {
      const info = await stat(this.messagesPath(id));
      if (info.size !== cached.size + appendedBytes) {
        this.messagesCache.delete(id);
        return;
      }
      cached.messages.push(message);
      cached.size = info.size;
      cached.mtimeMs = info.mtimeMs;
      cached.ctimeMs = info.ctimeMs;
      this.touchMessagesCache(id, cached);
    } catch {
      this.messagesCache.delete(id);
    }
  }

  /** 会话目录（聊天工具的文件读写根与 python 工作目录）。 */
  sessionDir(id: string): string {
    return this.sessionPath(id);
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

  private async readMeta(id: string): Promise<ChatSessionMeta> {
    return JSON.parse(await readFile(this.metaPath(id), "utf8")) as ChatSessionMeta;
  }

  private async writeMeta(meta: ChatSessionMeta): Promise<void> {
    await writeUtf8Atomically(this.metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  }
}
