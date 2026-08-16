import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { chmodPrivate, ensureDirWithMode, isMissing } from "../fs-utils.js";
import { monotonicTimestamp } from "../monotonic-clock.js";
import { parseSessionImport, serializeSession } from "./session-transfer.js";
import { activePathMessages } from "./session-tree.js";
import { defaultSandboxPolicy } from "./default-sandbox.js";
import { readMessagesTail, readMessagesBefore, checkRecoveryTail, DEFAULT_PAGE_SIZE } from "./message-reader.js";
import { deriveTitleFromMessages, serializeByKey, titleFromContent } from "./store-utils.js";
import type { BindLinkSpec, ChatMessage, FallbackModelEntry, ManagedWorkspaceMeta, MessageContent, MessageRole, MessagesPage, SandboxMode, SandboxNetwork, SessionDetail, SessionMeta } from "./types.js";

/** readMessages 整表缓存条数上限（与 message-reader 的索引缓存同一 LRU 纪律）。 */
const MAX_CACHED_MESSAGE_LISTS = 32;

/**
 * 单会话消息整表缓存：size+mtime+ctime 指纹校验（同 message-reader），
 * 命中时免去整份 messages.jsonl 的 read+全量 JSON.parse。
 * appendMessage 追加穿透（尺寸吻合才增量，否则失效），rewrite/删除一律失效。
 */
interface MessagesCacheEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  messages: ChatMessage[];
  recovery?: NonNullable<SessionMeta["recovery"]>;
}

interface CreateSessionInput {
  cwd: string;
  provider?: string;
  model?: string;
  title?: string;
  agentMode?: "plan" | "code" | "goal";
  sandboxMode?: SandboxMode;
  /** 会话网络策略（缺省 allow；并入默认沙盒策略持久化）。 */
  network?: SandboxNetwork;
  setupScript?: string;
  /** 可选 Bind Link 目录绑定（Windows 11 24H2+；非空时并入默认沙盒策略持久化）。 */
  bindLinks?: BindLinkSpec[];
  /** 托管工作区：调用方预分配 id（镜像/挂载路径按 id 推导，必须先于 create 准备） */
  id?: string;
  workspace?: ManagedWorkspaceMeta;
  /** 托管工作区预设快照后端名（vhdx-chain/qcow2-chain），跳过探测 */
  snapshotBackend?: string;
  /** 会话级内置工具白名单/黑名单（非空才落盘；语义见 SessionMeta.toolsAllow）。 */
  toolsAllow?: string[];
  toolsDeny?: string[];
  /** 会话级备选模型链（非空才落盘；语义见 SessionMeta.fallbackModels）。 */
  fallbackModels?: FallbackModelEntry[];
}

export class SessionStore {
  /** 首条用户消息派生标题时回调（"New session" → 派生标题）；由装配层接线为 session.updated 事件 */
  onDerivedTitle?: (meta: SessionMeta) => void;

  /** 按会话 id 的 LRU 消息整表缓存；agent loop 每轮 get() 不再整份重解析。 */
  private readonly messagesCache = new Map<string, MessagesCacheEntry>();

  /** appendMessage 的每会话串行化链：并发追加大消息时底层多次 write 可能交织坏行。 */
  private readonly appendChains = new Map<string, Promise<void>>();

  /**
   * 已知的会话 cwd 引用计数集（path.resolve 后）：isKnownSessionCwd 专用，
   * 避免每次 prompt-override 写入都全量 list()。create/import 递增、delete 递减，
   * 首次访问时由磁盘重建；重建失败按无缓存处理。
   */
  private knownCwds: Map<string, number> | undefined;

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    // sessions 根目录含会话内容：POSIX 收紧为 0700（Windows no-op）
    await ensureDirWithMode(this.root, 0o700);
  }

  async create(input: CreateSessionInput): Promise<SessionMeta> {
    const now = monotonicTimestamp();
    const resolvedCwd = path.resolve(input.cwd);
    const meta: SessionMeta = {
      id: input.id ?? randomUUID(),
      cwd: resolvedCwd,
      // API callers resolve a configured provider/model before creating a session.
      // Keep direct store use neutral rather than choosing an implicit provider.
      provider: input.provider ?? "",
      model: input.model ?? "",
      sandbox: {
        ...defaultSandboxPolicy(resolvedCwd),
        ...(input.network ? { network: input.network } : {}),
        ...(input.bindLinks?.length ? { bindLinks: input.bindLinks } : {}),
      },
      title: input.title ?? "New session",
      createdAt: now,
      updatedAt: now,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.snapshotBackend ? { snapshotBackend: input.snapshotBackend } : {}),
    };
    // jobobject 为默认不落盘；setupScript 仅非空时保留
    if (input.sandboxMode && input.sandboxMode !== "jobobject") meta.sandboxMode = input.sandboxMode;
    if (input.setupScript?.trim()) meta.setupScript = input.setupScript;
    if (input.agentMode === "plan" || input.agentMode === "goal") meta.agentMode = input.agentMode;
    // 工具白名单/黑名单：空数组等同未设置，不落盘
    if (input.toolsAllow?.length) meta.toolsAllow = input.toolsAllow;
    if (input.toolsDeny?.length) meta.toolsDeny = input.toolsDeny;
    // 备选模型链：空数组等同未设置，不落盘
    if (input.fallbackModels?.length) meta.fallbackModels = input.fallbackModels;
    // overlayfs 托管会话在 create 前已 provision（stateRoot 位于会话目录下），目录已存在属预期
    await mkdir(this.sessionPath(meta.id), { recursive: input.workspace?.backend === "overlayfs" });
    await chmodPrivate(this.sessionPath(meta.id), 0o700);
    await this.writeMeta(meta);
    await writeFile(this.messagesPath(meta.id), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmodPrivate(this.messagesPath(meta.id), 0o600);
    this.messagesCache.delete(meta.id);
    this.noteSessionCwd(resolvedCwd);
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
          // 尾行检查只读文件尾部窗口，不为列表建全量字节索引（分页路径才需要索引）
          const { recovery } = await checkRecoveryTail(this.messagesPath(entry.name));
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

  /** 只读 meta.json（不触碰 messages.jsonl）：热路径上仅取配置字段的调用点用。 */
  async getMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      return await this.readMeta(id);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** cwd 是否为某个现存会话的工作目录（内存引用计数集，避免每次校验全量 list()）。 */
  async hasSessionCwd(cwd: string): Promise<boolean> {
    this.knownCwds ??= await this.scanSessionCwds();
    return (this.knownCwds.get(path.resolve(cwd)) ?? 0) > 0;
  }

  /** 从磁盘重建 cwd 集（readdir + 逐会话 meta；不触碰 messages.jsonl）。坏会话目录跳过。 */
  private async scanSessionCwds(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return counts;
      throw error;
    }
    await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try {
          const meta = await this.readMeta(entry.name);
          const key = path.resolve(meta.cwd);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        } catch {
          // 坏会话目录跳过（与 list() 同款纪律）
        }
      }),
    );
    return counts;
  }

  /** create/import 成功后登记 cwd（缓存未建时跳过，首次 hasSessionCwd 会全量重建）。 */
  private noteSessionCwd(cwd: string): void {
    if (!this.knownCwds) return;
    const key = path.resolve(cwd);
    this.knownCwds.set(key, (this.knownCwds.get(key) ?? 0) + 1);
  }

  /** delete 前摘除 cwd；meta 已不可读时整体失效，下次访问重建。 */
  private async forgetSessionCwd(id: string): Promise<void> {
    if (!this.knownCwds) return;
    try {
      const meta = await this.readMeta(id);
      const key = path.resolve(meta.cwd);
      const count = (this.knownCwds.get(key) ?? 1) - 1;
      if (count > 0) this.knownCwds.set(key, count);
      else this.knownCwds.delete(key);
    } catch {
      this.knownCwds = undefined;
    }
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
    return serializeByKey(this.appendChains, sessionId, () => this.appendMessageSerialized(sessionId, role, content, lineage));
  }

  private async appendMessageSerialized(
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
    const appendedLine = `${JSON.stringify(message)}\n`;
    await appendFile(this.messagesPath(sessionId), appendedLine, "utf8");
    await this.noteAppendedMessage(sessionId, message, Buffer.byteLength(appendedLine, "utf8"));
    meta.updatedAt = now;
    meta.activeLeafId = message.id;
    let titleDerived = false;
    if (meta.title === "New session" && role === "user") {
      const derived = titleFromContent(content);
      if (derived !== undefined) {
        meta.title = derived;
        titleDerived = true;
      }
    }
    await this.writeMeta(meta);
    if (titleDerived) this.onDerivedTitle?.(meta);
    return message;
  }

  async updateConfig(id: string, update: Pick<SessionMeta, "provider" | "model"> & Partial<Pick<SessionMeta, "thinking" | "effort" | "agentMode" | "snapshotMode" | "shellBackend" | "pythonEnv" | "nodeEnv" | "persona" | "swarmEnabled" | "reviewModel" | "toolsAllow" | "toolsDeny" | "fallbackModels">>): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    meta.provider = update.provider;
    meta.model = update.model;
    if (update.thinking === undefined) delete meta.thinking;
    else meta.thinking = update.thinking;
    if (update.effort === undefined) delete meta.effort;
    else meta.effort = update.effort;
    if (update.agentMode === undefined || update.agentMode === "code") delete meta.agentMode;
    else meta.agentMode = update.agentMode;
    if (update.snapshotMode === undefined || update.snapshotMode === "auto") delete meta.snapshotMode;
    else meta.snapshotMode = update.snapshotMode;
    if (update.shellBackend === undefined || update.shellBackend === "default") delete meta.shellBackend;
    else meta.shellBackend = update.shellBackend;
    if (update.pythonEnv === undefined || update.pythonEnv === "global") delete meta.pythonEnv;
    else meta.pythonEnv = update.pythonEnv;
    if (update.nodeEnv === undefined || update.nodeEnv === "global") delete meta.nodeEnv;
    else meta.nodeEnv = update.nodeEnv;
    if (update.persona === undefined || update.persona === "") delete meta.persona;
    else meta.persona = update.persona;
    if (update.swarmEnabled !== true) delete meta.swarmEnabled;
    else meta.swarmEnabled = true;
    // reviewModel 不做清除语义：仅显式提供时更新
    if (update.reviewModel !== undefined) meta.reviewModel = update.reviewModel;
    // 工具白名单/黑名单：undefined 或空数组 = 清除（与 nodeEnv 的 global 清除语义同款）
    if (update.toolsAllow === undefined || update.toolsAllow.length === 0) delete meta.toolsAllow;
    else meta.toolsAllow = update.toolsAllow;
    if (update.toolsDeny === undefined || update.toolsDeny.length === 0) delete meta.toolsDeny;
    else meta.toolsDeny = update.toolsDeny;
    // 备选模型链：undefined 或空数组 = 清除（与 toolsAllow 同款语义）
    if (update.fallbackModels === undefined || update.fallbackModels.length === 0) delete meta.fallbackModels;
    else meta.fallbackModels = update.fallbackModels;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /** 会话级扩展状态补丁：key=扩展 id，value 为 JSON 对象（整体替换该扩展的状态）；null 清除该扩展的状态。 */
  async updateExtensionState(id: string, patch: Record<string, Record<string, unknown> | null>): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    const next: Record<string, Record<string, unknown>> = { ...(meta.extensionState ?? {}) };
    // 扩展 id 改名迁移（context-manager → context-saver）：写入时把旧键归一到新键。
    // 读路径不迁移——旧 id 无会话级状态消费端，残留键惰性随下次写入清理。
    if (next["context-manager"] !== undefined) {
      next["context-saver"] ??= next["context-manager"];
      delete next["context-manager"];
    }
    for (const [extensionId, value] of Object.entries(patch)) {
      if (value === null) delete next[extensionId];
      else next[extensionId] = value;
    }
    if (Object.keys(next).length === 0) delete meta.extensionState;
    else meta.extensionState = next;
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
    return deriveTitleFromMessages(messages, "New session");
  }

  async truncateMessages(id: string, count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Message count must be a non-negative integer");
    const detail = await this.get(id);
    if (!detail) throw new Error("Session not found");
    const messages = detail.messages.slice(0, count);
    await writeFile(this.messagesPath(id), messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length ? "\n" : ""), "utf8");
    this.messagesCache.delete(id);
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

  /** 更新沙盒模式；jobobject/空 setupScript 视为缺省（从 meta 删除）。sandboxMode 未提供时保留现值（setupScript-only 补丁不误清模式）。 */
  async updateSandboxMode(id: string, sandboxMode: SandboxMode | undefined, setupScript: string | undefined): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    if (sandboxMode !== undefined) {
      if (sandboxMode === "jobobject") delete meta.sandboxMode;
      else meta.sandboxMode = sandboxMode;
    }
    if (!setupScript?.trim()) delete meta.setupScript;
    else meta.setupScript = setupScript;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /** 更新沙盒网络策略（meta.sandbox 缺失时先补默认策略） */
  async updateSandboxNetwork(id: string, network: SandboxNetwork): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    meta.sandbox = { ...(meta.sandbox ?? defaultSandboxPolicy(meta.cwd)), network };
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

  /** repo map 自动注入开关与 token 预算（§4.1）；缺省值不落盘（关 / 2048）。 */
  async updateRepoMapSettings(id: string, settings: { enabled?: boolean | undefined; budget?: number | undefined }): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    if (settings.enabled === undefined || settings.enabled === false) delete meta.repoMapEnabled;
    else meta.repoMapEnabled = true;
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
    this.messagesCache.delete(id);
    await this.forgetSessionCwd(id);
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
    await chmodPrivate(this.sessionPath(id), 0o700);
    const { id: _ignored, ...restMeta } = parsed.meta;
    const meta: SessionMeta = { ...restMeta, id };
    await this.writeMeta(meta);
    await writeFile(
      this.messagesPath(id),
      parsed.messages.map((message) => JSON.stringify(message)).join("\n") + (parsed.messages.length ? "\n" : ""),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmodPrivate(this.messagesPath(id), 0o600);
    this.messagesCache.delete(id);
    this.noteSessionCwd(meta.cwd);
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
    if (source.thinking !== undefined || source.effort !== undefined || source.snapshotMode !== undefined || source.shellBackend !== undefined || source.pythonEnv !== undefined || source.nodeEnv !== undefined || source.persona !== undefined || source.swarmEnabled !== undefined || source.reviewModel !== undefined || source.toolsAllow !== undefined || source.toolsDeny !== undefined) await this.updateConfig(meta.id, { provider: source.provider, model: source.model, ...(source.thinking ? { thinking: source.thinking } : {}), ...(source.effort ? { effort: source.effort } : {}), ...(source.agentMode ? { agentMode: source.agentMode } : {}), ...(source.snapshotMode ? { snapshotMode: source.snapshotMode } : {}), ...(source.shellBackend ? { shellBackend: source.shellBackend } : {}), ...(source.pythonEnv ? { pythonEnv: source.pythonEnv } : {}), ...(source.nodeEnv ? { nodeEnv: source.nodeEnv } : {}), ...(source.persona ? { persona: source.persona } : {}), ...(source.swarmEnabled ? { swarmEnabled: true } : {}), ...(source.reviewModel ? { reviewModel: source.reviewModel } : {}), ...(source.toolsAllow?.length ? { toolsAllow: source.toolsAllow } : {}), ...(source.toolsDeny?.length ? { toolsDeny: source.toolsDeny } : {}) });
    for (const message of source.messages) await this.appendMessage(meta.id, message.role, message.content, { ...(message.runId ? { runId: message.runId } : {}), ...(message.turnId ? { turnId: message.turnId } : {}) });
    return (await this.get(meta.id))!;
  }

  /**
   * checkout：仅更新活动叶子（meta-only，不触碰 messages.jsonl，
   * 消息整表缓存的 stat 指纹保持有效）。调用方负责校验 messageId 在树中。
   */
  async setActiveLeaf(id: string, messageId: string): Promise<SessionMeta> {
    const meta = await this.readMeta(id);
    meta.activeLeafId = messageId;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    return meta;
  }

  /**
   * 会话内分支（fork）：同 cwd 新建会话，复制根到 leaf 的活动路径消息
   * （不含 messageId 时到当前活动叶子；对话 only，不带 ledger/快照/artifact），
   * 配置（provider/model/thinking/effort/agentMode/sandboxMode/setupScript/
   * snapshotMode/shellBackend）随 meta 复制。源会话运行中也允许（纯读复制）。
   * 复制经 create+appendMessage 走正常落盘与缓存穿透路径，消息获得新 id，
   * 父链沿路径线性重建，新会话活动叶子落在最后一条复制消息上。
   */
  async fork(id: string, messageId?: string): Promise<SessionDetail> {
    const source = await this.get(id);
    if (!source) throw new Error("Session not found");
    if (messageId !== undefined && !source.messages.some((message) => message.id === messageId)) {
      throw new Error("Message not found");
    }
    const leafId = messageId ?? source.activeLeafId ?? source.messages.at(-1)?.id;
    const activePath = leafId ? activePathMessages(source.messages, leafId) : [];
    const meta = await this.create({ cwd: source.cwd, provider: source.provider, model: source.model, title: `${source.title} (分支)`, ...(source.agentMode ? { agentMode: source.agentMode } : {}), ...(source.sandboxMode ? { sandboxMode: source.sandboxMode } : {}), ...(source.setupScript ? { setupScript: source.setupScript } : {}) });
    if (source.thinking !== undefined || source.effort !== undefined || source.snapshotMode !== undefined || source.shellBackend !== undefined || source.pythonEnv !== undefined || source.nodeEnv !== undefined || source.persona !== undefined || source.swarmEnabled !== undefined || source.reviewModel !== undefined || source.toolsAllow !== undefined || source.toolsDeny !== undefined) await this.updateConfig(meta.id, { provider: source.provider, model: source.model, ...(source.thinking ? { thinking: source.thinking } : {}), ...(source.effort ? { effort: source.effort } : {}), ...(source.agentMode ? { agentMode: source.agentMode } : {}), ...(source.snapshotMode ? { snapshotMode: source.snapshotMode } : {}), ...(source.shellBackend ? { shellBackend: source.shellBackend } : {}), ...(source.pythonEnv ? { pythonEnv: source.pythonEnv } : {}), ...(source.nodeEnv ? { nodeEnv: source.nodeEnv } : {}), ...(source.persona ? { persona: source.persona } : {}), ...(source.swarmEnabled ? { swarmEnabled: true } : {}), ...(source.reviewModel ? { reviewModel: source.reviewModel } : {}), ...(source.toolsAllow?.length ? { toolsAllow: source.toolsAllow } : {}), ...(source.toolsDeny?.length ? { toolsDeny: source.toolsDeny } : {}) });
    for (const message of activePath) await this.appendMessage(meta.id, message.role, message.content, { ...(message.runId ? { runId: message.runId } : {}), ...(message.turnId ? { turnId: message.turnId } : {}) });
    return (await this.get(meta.id))!;
  }

  /**
   * JSONL is append-only, so a process interruption can only normally damage
   * its final record. Keep every valid record and make the recovery state
   * explicit instead of making the complete session disappear from list().
   */
  private async readMessages(id: string): Promise<{ messages: ChatMessage[]; recovery?: NonNullable<SessionMeta["recovery"]> }> {
    const filePath = this.messagesPath(id);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(filePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.messagesCache.delete(id);
      return { messages: [], recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
    }
    const cached = this.messagesCache.get(id);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) {
      this.touchMessagesCache(id, cached);
      // 浅拷贝返回：调用方不得改动缓存数组本身（消息对象语义上只读）。
      return { messages: cached.messages.slice(), ...(cached.recovery ? { recovery: cached.recovery } : {}) };
    }
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.messagesCache.delete(id);
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
    let recovery: MessagesCacheEntry["recovery"];
    if (corruptMiddle) recovery = { state: "needs_repair", message: "messages.jsonl contains corrupt non-tail records" };
    else if (corruptTail) recovery = { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" };
    this.touchMessagesCache(id, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, messages, ...(recovery ? { recovery } : {}) });
    return { messages: messages.slice(), ...(recovery ? { recovery } : {}) };
  }

  /** LRU 接触：移到最新位并逐出超限旧条目。 */
  private touchMessagesCache(id: string, entry: MessagesCacheEntry): void {
    this.messagesCache.delete(id);
    this.messagesCache.set(id, entry);
    while (this.messagesCache.size > MAX_CACHED_MESSAGE_LISTS) this.messagesCache.delete(this.messagesCache.keys().next().value!);
  }

  /**
   * appendMessage 后的缓存穿透：仅当文件尺寸恰好增长本次追加字节数时才增量
   * push（任何并发/外部写入导致的尺寸不符都降级为整表失效，下次读取重建）。
   * recovery 状态不做增量（损坏尾行被追加后性质变化），直接失效。
   */
  private async noteAppendedMessage(id: string, message: ChatMessage, appendedBytes: number): Promise<void> {
    const cached = this.messagesCache.get(id);
    if (!cached) return;
    if (cached.recovery) {
      this.messagesCache.delete(id);
      return;
    }
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

  private async writeMeta(meta: SessionMeta): Promise<void> {
    const target = this.metaPath(meta.id);
    // 紧凑序列化：meta.json 只被机器读取；读取侧 JSON.parse 兼容存量美化格式。
    await writeUtf8Atomically(target, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  }
}
