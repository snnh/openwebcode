import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEvent, EventBus } from "../events/event-bus.js";
import type { ProviderTool } from "../providers/provider.js";
import type { ChatMessage, SessionDetail, SessionMeta } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import { ContextManager } from "../context/context-manager.js";
import { EXTENSION_API_VERSION, isExtensionEventAllowed, type ApiRequest, type ApiResponse, type ContextHookPayload, type EventMessage, type ExtensionApiMethod, type ExtensionHook, type ExtensionInfo, type ExtensionManifest, type ExtensionPermission, type ExtensionState, type ExtensionToolResult, type ExtensionToolSpec, type HostRequest, type HostResponse, type PromptHookPayload, type PromptHookResult, type ToolHookPayload, type ToolShapingAlias, type ToolShapingSpec } from "./types.js";
import { OFFICIAL_DEFAULT_CONFIG, OFFICIAL_EXTENSIONS } from "./official.js";
import { BUILTIN_PERSONAS, getPersona, listPersonas, resolvePersona, personasDir, type PersonaDetail, type PersonaSummary } from "./env-sim/index.js";

/** activeToolShaping 聚合结果：hideBuiltIns 按内置名隐藏，aliases 以新名（as）为键。 */
export interface ActiveToolShaping {
  hideBuiltIns: Set<string>;
  aliases: Map<string, { from: string; description?: string; inputSchema?: Record<string, unknown>; argMap?: Record<string, string> }>;
}

const ALIAS_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const BUILTIN_PERSONA_IDS = new Set(BUILTIN_PERSONAS.map((preset) => preset.id));

interface StoredConfig { version: 1; extensions: Record<string, ExtensionState> }
type DiscoveredManifest = ExtensionManifest & { directory?: string };

/** 扩展 API 所需的权限映射；events.subscribe 挂 sessions:read。 */
const API_PERMISSIONS: Record<ExtensionApiMethod, ExtensionPermission> = {
  "sessions.list": "sessions:read",
  "sessions.get": "sessions:read",
  "context.getView": "context:read",
  "context.readArtifact": "context:read",
  "events.subscribe": "sessions:read",
};

/** sessions:read 只暴露元信息白名单字段；不落出沙盒路径/setupScript 等内部配置。 */
function publicSessionMeta(meta: SessionMeta): Record<string, unknown> {
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    provider: meta.provider,
    model: meta.model,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.thinking ? { thinking: meta.thinking } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    ...(meta.agentMode ? { agentMode: meta.agentMode } : {}),
    ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    ...(meta.recovery ? { recovery: meta.recovery } : {}),
  };
}

export class ExtensionManager {
  private readonly root: string;
  private readonly configPath: string;
  private manifests: DiscoveredManifest[] = [];
  private states: Record<string, ExtensionState> = {};
  private child: ChildProcess | undefined;
  private hostErrors: Record<string, string> = {};
  private readonly pending = new Map<string, { child: ChildProcess; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly stoppingHosts = new WeakSet<ChildProcess>();
  private readonly handledHostFailures = new WeakSet<ChildProcess>();
  private hostRestartTimer: NodeJS.Timeout | undefined;
  private hostRestartCount = 0;
  /** 扩展注册的工具表（extensionId → toolName → spec），由 initialize/reload 响应重建。 */
  private readonly extensionTools = new Map<string, Map<string, ExtensionToolSpec>>();
  /** 扩展的事件订阅（extensionId → 类型集合），host 断线时清空。 */
  private readonly eventSubscriptions = new Map<string, Set<string>>();
  private busListenerAttached = false;
  /** 已发出的工具形态警告（去重，避免每轮重复刷事件）。 */
  private readonly shapingWarningsIssued = new Set<string>();

  constructor(private readonly dataDir: string, private readonly events?: EventBus, private readonly deps: { sessions?: SessionStore } = {}) {
    this.root = path.join(dataDir, "extensions");
    this.configPath = path.join(this.root, "extensions.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.manifests = [...OFFICIAL_EXTENSIONS, ...(await this.discoverThirdParty())];
    this.states = await this.loadStates();
    await this.startHost();
  }

  async close(): Promise<void> {
    if (this.hostRestartTimer) clearTimeout(this.hostRestartTimer);
    this.hostRestartTimer = undefined;
    if (this.busListenerAttached && this.events) {
      this.events.removeListener("event", this.onBusEvent);
      this.busListenerAttached = false;
    }
    this.eventSubscriptions.clear();
    this.extensionTools.clear();
    const child = this.child;
    if (!child) return;
    this.stoppingHosts.add(child);
    await this.request("shutdown").catch(() => undefined);
    // Host 可能在 shutdown 响应后立即自行退出，exit handler 会先清空 this.child。
    // 始终操作捕获的实例，并只在它仍是当前实例时清理引用。
    if (!child.killed) child.kill();
    if (this.child === child) this.child = undefined;
  }

  list(): ExtensionInfo[] {
    return this.manifests.map((manifest) => {
      const state = this.stateFor(manifest);
      const hostError = this.hostErrors[manifest.id];
      const connected = this.child?.connected === true;
      const status = !state.enabled ? "disabled" as const : connected && !hostError ? "running" as const : "error" as const;
      const { directory: _directory, ...publicManifest } = manifest;
      return {
        ...publicManifest,
        enabled: state.enabled,
        builtIn: manifest.official === true,
        status,
        config: { ...state.config },
        ...(state.enabled && (hostError || !connected) ? { error: hostError ?? "Extension Host 未连接" } : {}),
      };
    });
  }

  isEnabled(id: string): boolean {
    const manifest = this.manifests.find((item) => item.id === id);
    return manifest ? this.stateFor(manifest).enabled : false;
  }

  async configure(id: string, update: { enabled?: boolean; config?: Record<string, unknown> }): Promise<ExtensionInfo> {
    const manifest = this.manifests.find((item) => item.id === id);
    if (!manifest) throw new Error("Extension not found");
    const previous = this.stateFor(manifest);
    this.states[id] = {
      enabled: update.enabled ?? previous.enabled,
      config: update.config ? { ...previous.config, ...update.config } : previous.config,
    };
    await this.saveStates();
    const reloaded = await this.request("reload", { states: this.states }) as { tools?: Record<string, ExtensionToolSpec[]> };
    this.replaceTools(reloaded.tools);
    this.events?.publish({ source: "server", type: "extension.updated", payload: { id, ...this.states[id] } });
    return this.list().find((item) => item.id === id)!;
  }

  async install(sourcePath: string): Promise<ExtensionInfo> {
    if (!path.isAbsolute(sourcePath)) throw new Error("Extension path must be absolute");
    if (!(await stat(sourcePath).catch(() => undefined))?.isDirectory()) throw new Error("Extension path must be a directory");
    const manifest = await readManifest(sourcePath);
    if (manifest.official) throw new Error("Third-party extension cannot claim official status");
    if (this.manifests.some((item) => item.id === manifest.id)) throw new Error(`Extension ID already exists: ${manifest.id}`);
    const target = path.join(this.root, `owc-ext-${manifest.id}`);
    await cp(sourcePath, target, { recursive: true, force: false, errorOnExist: true });
    await this.restart();
    const installed = this.list().find((item) => item.id === manifest.id);
    if (!installed) throw new Error("Installed extension was not discovered");
    return installed;
  }

  async uninstall(id: string): Promise<void> {
    const manifest = this.manifests.find((item) => item.id === id);
    if (!manifest) throw new Error("Extension not found");
    if (manifest.official || !manifest.directory) throw new Error("Official extensions cannot be uninstalled");
    await rm(manifest.directory, { recursive: true, force: true });
    delete this.states[id];
    await this.saveStates();
    await this.restart();
  }

  async transformContext(payload: ContextHookPayload): Promise<{ messages: ChatMessage[]; metadata?: Record<string, unknown> }> {
    const result = await this.hook("context.beforeBuild", payload) as ContextHookPayload & { metadata?: Record<string, unknown> };
    return { messages: result.messages, ...(result.metadata ? { metadata: result.metadata } : {}) };
  }

  async beforeSend(payload: ContextHookPayload): Promise<{ messages: ChatMessage[]; metadata?: Record<string, unknown> }> {
    const result = await this.hook("message.beforeSend", payload) as ContextHookPayload & { metadata?: Record<string, unknown> };
    return { messages: result.messages, ...(result.metadata ? { metadata: result.metadata } : {}) };
  }

  async beforeTool(payload: ToolHookPayload): Promise<ToolHookPayload & { blocked?: boolean; reason?: string }> {
    return this.hook("tool.beforeExecute", payload) as Promise<ToolHookPayload & { blocked?: boolean; reason?: string }>;
  }

  /**
   * prompt.beforeBuild 变换：先走 host 的通用 hook 扇出（第三方扩展），再叠加 env-sim。
   * env-sim 的提示词变换在 server 侧直接合成——内置预设与用户预设目录都是 server 本地
   * 状态，经 Extension Host IPC 传递反而是多余一跳（与工具形态同为 server 侧内建行为）。
   */
  async transformPrompt(payload: PromptHookPayload, sessionPersona?: string): Promise<PromptHookResult> {
    const hostResult = await this.hook("prompt.beforeBuild", payload) as Partial<PromptHookResult>;
    const result: PromptHookResult = {
      ...(typeof hostResult.identity === "string" ? { identity: hostResult.identity } : {}),
      ...(typeof hostResult.basePromptOverride === "string" ? { basePromptOverride: hostResult.basePromptOverride } : {}),
      ...(Array.isArray(hostResult.productSections) ? { productSections: hostResult.productSections.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(hostResult.prependSections) ? { prependSections: hostResult.prependSections.filter((item): item is string => typeof item === "string") } : {}),
    };
    const envSim = this.manifests.find((item) => item.id === "env-sim");
    if (envSim && this.stateFor(envSim).enabled) {
      // 会话级 persona（SessionMeta.persona）优先于扩展全局 config.persona
      const persona = await resolvePersona(this.dataDir, this.stateFor(envSim).config, (message) => this.warnShaping(message), sessionPersona);
      if (persona) {
        result.identity = persona.identity;
        result.basePromptOverride = persona.basePrompt;
        result.productSections = persona.productSections;
      }
    }
    return result;
  }

  /**
   * 聚合所有已启用官方扩展的工具形态（静态 manifest toolShaping + env-sim 活跃预设）。
   * builtInNames 传入本轮实际内置工具表（含条件项），据此完成 from 存在性与命名冲突校验；
   * 无效条目记警告并跳过。无形态生效时返回 undefined。
   */
  async activeToolShaping(builtInNames: readonly string[], sessionPersona?: string): Promise<ActiveToolShaping | undefined> {
    const shaping: ActiveToolShaping = { hideBuiltIns: new Set(), aliases: new Map() };
    for (const manifest of this.manifests) {
      if (!manifest.toolShaping || manifest.official !== true || !this.isEnabled(manifest.id)) continue;
      this.applyShapingSpec(manifest.id, manifest.toolShaping, builtInNames, shaping);
    }
    const envSim = this.manifests.find((item) => item.id === "env-sim");
    if (envSim && this.stateFor(envSim).enabled) {
      // env-sim 的形态由 config.persona 驱动（动态预设），不走静态 manifest toolShaping；
      // 会话级 persona 覆盖与 transformPrompt 同源。
      const persona = await resolvePersona(this.dataDir, this.stateFor(envSim).config, (message) => this.warnShaping(message), sessionPersona);
      if (persona) this.applyShapingSpec("env-sim", { hideBuiltIns: persona.hideBuiltIns, aliases: persona.aliases }, builtInNames, shaping);
    }
    return shaping.hideBuiltIns.size === 0 && shaping.aliases.size === 0 ? undefined : shaping;
  }

  private applyShapingSpec(owner: string, spec: ToolShapingSpec, builtInNames: readonly string[], shaping: ActiveToolShaping): void {
    for (const name of spec.hideBuiltIns ?? []) {
      if (typeof name === "string" && name) shaping.hideBuiltIns.add(name);
    }
    for (const alias of spec.aliases ?? []) {
      this.applyShapingAlias(owner, alias, builtInNames, shaping);
    }
  }

  private applyShapingAlias(owner: string, alias: ToolShapingAlias, builtInNames: readonly string[], shaping: ActiveToolShaping): void {
    const invalid = (reason: string): void => this.warnShaping(`${owner}: tool alias "${String(alias?.as ?? "")}" skipped (${reason})`);
    if (!alias || typeof alias.from !== "string" || typeof alias.as !== "string") return invalid("from/as must be non-empty strings");
    if (!ALIAS_NAME_PATTERN.test(alias.as)) return invalid("as must match [a-zA-Z][a-zA-Z0-9_]{0,63}");
    if (alias.as.startsWith("ext__") || alias.as.startsWith("mcp__")) return invalid("as must not use the ext__/mcp__ prefixes");
    if (!builtInNames.includes(alias.from)) return invalid(`unknown built-in tool "${alias.from}"`);
    if (shaping.hideBuiltIns.has(alias.from)) return; // 隐藏工具不可再被别名引出
    if (shaping.aliases.has(alias.as)) return invalid(`alias name "${alias.as}" is already taken`);
    if (builtInNames.includes(alias.as) && !shaping.hideBuiltIns.has(alias.as)) return invalid(`"${alias.as}" collides with a non-hidden built-in tool`);
    shaping.aliases.set(alias.as, {
      from: alias.from,
      ...(typeof alias.description === "string" ? { description: alias.description } : {}),
      ...(alias.inputSchema && typeof alias.inputSchema === "object" ? { inputSchema: alias.inputSchema } : {}),
      ...(alias.argMap && typeof alias.argMap === "object" && Object.values(alias.argMap).every((value) => typeof value === "string") ? { argMap: alias.argMap } : {}),
    });
  }

  private warnShaping(message: string): void {
    if (this.shapingWarningsIssued.has(message)) return;
    this.shapingWarningsIssued.add(message);
    this.events?.publish({ source: "server", type: "extension.warning", payload: { message } });
  }

  /** manifest 声明的 configSchema（无则 undefined），供 REST 层做松散校验。 */
  configSchemaFor(id: string): Record<string, unknown> | undefined {
    return this.manifests.find((item) => item.id === id)?.configSchema;
  }

  /** env-sim 预设清单 + 用户预设目录绝对路径（UI 展示「把分享的预设 JSON 放到这里」）。 */
  async listEnvSimPersonas(): Promise<{ personas: PersonaSummary[]; directory: string }> {
    return {
      personas: await listPersonas(this.dataDir, (message) => this.warnShaping(message)),
      directory: personasDir(this.dataDir),
    };
  }

  /** env-sim 预设详情（选前预览端点）；未命中返回 null。 */
  async envSimPersonaDetail(id: string): Promise<PersonaDetail | null> {
    return getPersona(this.dataDir, id, (message) => this.warnShaping(message));
  }

  /** 当前生效的 env-sim 预设（会话级覆盖优先于扩展全局配置）；未启用/未设置/未知返回 null。 */
  async activeEnvSimPersona(sessionPersona?: string): Promise<PersonaSummary | null> {
    const envSim = this.manifests.find((item) => item.id === "env-sim");
    if (!envSim || !this.stateFor(envSim).enabled) return null;
    const persona = await resolvePersona(this.dataDir, this.stateFor(envSim).config, (message) => this.warnShaping(message), sessionPersona);
    if (!persona) return null;
    const builtin = BUILTIN_PERSONA_IDS.has(persona.id);
    return { id: persona.id, name: persona.name, builtin };
  }

  /** 已启用扩展注册的工具表（ext__<extensionId>__<name>），供 agent 工具注入；同步读注册表。 */
  registeredTools(): ProviderTool[] {
    const result: ProviderTool[] = [];
    for (const [extensionId, tools] of this.extensionTools) {
      if (!this.isEnabled(extensionId)) continue;
      for (const spec of tools.values()) {
        result.push({
          name: `ext__${extensionId}__${spec.name}`,
          description: `[${extensionId}] ${spec.description || spec.name}`,
          inputSchema: spec.inputSchema,
        });
      }
    }
    return result;
  }

  /** 转发 agent 的 ext__ 工具调用到 Extension Host；5 秒超时按工具失败处理。 */
  async invokeTool(namespaced: string, input: Record<string, unknown>): Promise<ExtensionToolResult> {
    const match = /^ext__([a-z0-9][a-z0-9-]{1,63})__([a-zA-Z0-9_-]{1,64})$/.exec(namespaced);
    const extensionId = match?.[1] ?? "";
    const tool = match?.[2] ?? "";
    if (!match || !this.extensionTools.get(extensionId)?.has(tool)) throw new Error(`Unknown extension tool: ${namespaced}`);
    if (!this.isEnabled(extensionId)) throw new Error(`Extension ${extensionId} is disabled`);
    const result = await this.request("tool.invoke", { extensionId, tool, input }, 5000);
    if (!result || typeof result !== "object" || typeof (result as { content?: unknown }).content !== "string") {
      throw new Error(`Extension tool ${namespaced} returned an invalid result`);
    }
    const value = result as { content: string; isError?: unknown };
    return { content: value.content, ...(value.isError === true ? { isError: true } : {}) };
  }

  private replaceTools(reported: Record<string, ExtensionToolSpec[]> | undefined): void {
    this.extensionTools.clear();
    for (const [extensionId, specs] of Object.entries(reported ?? {})) {
      if (!Array.isArray(specs)) continue;
      const registered = new Map<string, ExtensionToolSpec>();
      for (const spec of specs) {
        if (!spec || typeof spec.name !== "string" || typeof spec.description !== "string") continue;
        registered.set(spec.name, {
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema && typeof spec.inputSchema === "object" ? spec.inputSchema : { type: "object", properties: {} },
        });
      }
      if (registered.size > 0) this.extensionTools.set(extensionId, registered);
    }
  }

  private async hook(hook: ExtensionHook, payload: unknown): Promise<unknown> {
    try {
      return await this.request("hook", { hook, payload });
    } catch (error) {
      this.events?.publish({ source: "server", type: "extension.hook_failed", payload: { hook, message: error instanceof Error ? error.message : String(error) } });
      return payload;
    }
  }

  /** host→server 能力调用：校验扩展身份与 manifest 权限后分发，结果以 ApiResponse 回送。 */
  private async handleApi(child: ChildProcess, request: ApiRequest): Promise<void> {
    let result: unknown;
    let error: string | undefined;
    try {
      result = await this.dispatchApi(request);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (!child.connected) return;
    child.send({ id: request.id, api: request.api, ...(error ? { error } : { result }) } satisfies ApiResponse, () => undefined);
  }

  private async dispatchApi(request: ApiRequest): Promise<unknown> {
    const manifest = this.manifests.find((item) => item.id === request.extensionId);
    if (!manifest) throw new Error(`Unknown extension: ${request.extensionId}`);
    const required = API_PERMISSIONS[request.api];
    if (!required) throw new Error(`Unsupported extension api: ${request.api}`);
    if (!manifest.permissions.includes(required)) throw new Error(`Extension ${manifest.id} lacks permission: ${required}`);
    const sessions = this.deps.sessions;
    const params = request.params ?? {};
    switch (request.api) {
      case "sessions.list": {
        if (!sessions) throw new Error("Session store is not configured");
        return (await sessions.list()).map((meta) => publicSessionMeta(meta));
      }
      case "sessions.get": {
        if (!sessions) throw new Error("Session store is not configured");
        const detail = await sessions.get(String(params.id ?? ""));
        if (!detail) throw new Error("Session not found");
        return this.publicSessionDetail(detail);
      }
      case "context.getView": {
        if (!sessions) throw new Error("Session store is not configured");
        const detail = await sessions.get(String(params.sessionId ?? ""));
        if (!detail) throw new Error("Session not found");
        return new ContextManager(sessions.contextRoot(detail.id)).buildView(detail.messages);
      }
      case "context.readArtifact": {
        if (!sessions) throw new Error("Session store is not configured");
        const sessionId = String(params.sessionId ?? "");
        if (!(await sessions.getTail(sessionId, 1))) throw new Error("Session not found");
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        const limit = params.limit === undefined ? 64_000 : Number(params.limit);
        return new ContextManager(sessions.contextRoot(sessionId)).readArtifact(String(params.artifactId ?? ""), offset, limit);
      }
      case "events.subscribe": {
        const requested = Array.isArray(params.types) ? params.types.filter((type): type is string => typeof type === "string") : [];
        const allowed = requested.filter(isExtensionEventAllowed);
        // 与 host 侧累加语义对齐：重订阅取并集而非替换
        const existing = this.eventSubscriptions.get(manifest.id);
        if (existing) {
          for (const type of allowed) existing.add(type);
        } else if (allowed.length > 0) {
          this.eventSubscriptions.set(manifest.id, new Set(allowed));
        }
        this.attachBusListener();
        return { subscribed: allowed };
      }
    }
  }

  private publicSessionDetail(detail: SessionDetail): Record<string, unknown> {
    return {
      ...publicSessionMeta(detail),
      messages: detail.messages,
      ...(detail.messageCount !== undefined ? { messageCount: detail.messageCount } : {}),
      ...(detail.hasMoreMessages !== undefined ? { hasMoreMessages: detail.hasMoreMessages } : {}),
    };
  }

  private attachBusListener(): void {
    if (this.busListenerAttached || !this.events) return;
    this.busListenerAttached = true;
    this.events.on("event", this.onBusEvent);
  }

  /** EventBus → host 推送：白名单 + 扩展订阅类型双重过滤；host 断线时自然静默。 */
  private readonly onBusEvent = (event: AppEvent): void => {
    if (this.eventSubscriptions.size === 0 || !isExtensionEventAllowed(event.type)) return;
    const child = this.child;
    if (!child?.connected) return;
    for (const [extensionId, types] of this.eventSubscriptions) {
      if (!types.has(event.type) || !this.isEnabled(extensionId)) continue;
      child.send({ event: event.type, ...(event.sessionId ? { sessionId: event.sessionId } : {}), payload: event.payload } satisfies EventMessage, () => undefined);
    }
  };

  private stateFor(manifest: ExtensionManifest): ExtensionState {
    return this.states[manifest.id] ?? {
      enabled: manifest.defaultEnabled === true,
      config: { ...(OFFICIAL_DEFAULT_CONFIG[manifest.id] ?? {}) },
    };
  }

  private async loadStates(): Promise<Record<string, ExtensionState>> {
    let stored: StoredConfig = { version: 1, extensions: {} };
    try { stored = JSON.parse(await readFile(this.configPath, "utf8")) as StoredConfig; } catch { /* first run */ }
    const result: Record<string, ExtensionState> = {};
    for (const manifest of this.manifests) {
      const value = stored.extensions?.[manifest.id];
      result[manifest.id] = {
        enabled: typeof value?.enabled === "boolean" ? value.enabled : manifest.defaultEnabled === true,
        config: { ...(OFFICIAL_DEFAULT_CONFIG[manifest.id] ?? {}), ...(value?.config ?? {}) },
      };
    }
    return result;
  }

  private async saveStates(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify({ version: 1, extensions: this.states }, null, 2)}\n`, "utf8");
  }

  private async discoverThirdParty(): Promise<DiscoveredManifest[]> {
    const result: DiscoveredManifest[] = [];
    const ids = new Set(OFFICIAL_EXTENSIONS.map((manifest) => manifest.id));
    for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !entry.name.startsWith("owc-ext-")) continue;
      const directory = path.join(this.root, entry.name);
      try {
        const manifest = await readManifest(directory);
        if (ids.has(manifest.id)) throw new Error(`Duplicate or reserved extension ID: ${manifest.id}`);
        ids.add(manifest.id);
        result.push({ ...manifest, directory });
      } catch (error) {
        this.events?.publish({ source: "server", type: "extension.invalid", payload: { directory, message: error instanceof Error ? error.message : String(error) } });
      }
    }
    return result;
  }

  private async restart(): Promise<void> {
    await this.close();
    this.manifests = [...OFFICIAL_EXTENSIONS, ...(await this.discoverThirdParty())];
    this.states = await this.loadStates();
    await this.startHost();
  }

  private async startHost(): Promise<void> {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = fileURLToPath(new URL(`./extension-host-process.${extension}`, import.meta.url));
    // dist 运行直接 fork 编译后的 JS；tsx 开发/测试运行显式安装 loader，确保 NodeNext 的 .js specifier 可解析到 .ts 源文件。
    const execArgv = extension === "ts" ? ["--import", "tsx"] : [];
    this.child = fork(worker, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv });
    const child = this.child;
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("message", (message: HostResponse | ApiRequest) => {
      if ("api" in message) {
        void this.handleApi(child, message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    child.on("error", (error) => this.handleHostFailure(child, error));
    child.on("disconnect", () => this.handleHostFailure(child, new Error("Extension Host IPC disconnected")));
    child.on("exit", (code, signal) => this.handleHostFailure(child, new Error(`Extension Host exited${code !== null ? ` (${code})` : ""}${signal ? ` (${signal})` : ""}`)));
    try {
      const initialized = await this.request("initialize", { states: this.states, manifests: this.manifests }) as { errors?: Record<string, string>; tools?: Record<string, ExtensionToolSpec[]> };
      this.hostErrors = initialized.errors ?? {};
      this.replaceTools(initialized.tools);
      this.hostRestartCount = 0;
      this.events?.publish({ source: "server", type: "extension.host_started", payload: { extensions: this.list().length } });
    } catch (error) {
      this.handleHostFailure(child, asError(error));
      throw error;
    }
  }

  private request(method: HostRequest["method"], params?: Record<string, unknown>, timeoutMs = 5500): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error("Extension Host is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension Host ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { child, resolve, reject, timer });
      child.send({ id, method, ...(params ? { params } : {}) } satisfies HostRequest, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
        this.handleHostFailure(child, error);
      });
    });
  }

  private handleHostFailure(child: ChildProcess, error: Error): void {
    if (this.handledHostFailures.has(child)) return;
    this.handledHostFailures.add(child);
    const intentional = this.stoppingHosts.has(child);
    if (this.child === child) this.child = undefined;
    // host 断线：工具注册表与事件订阅全部失效（重启后由 initialize/activate 重建）。
    this.extensionTools.clear();
    this.eventSubscriptions.clear();
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (intentional) {
      this.events?.publish({ source: "server", type: "extension.host_stopped", payload: {} });
      return;
    }
    this.events?.publish({ source: "server", type: "extension.host_failed", payload: { message: error.message } });
    if (this.hostRestartTimer || this.hostRestartCount >= 3) return;
    const delayMs = 250 * 2 ** this.hostRestartCount++;
    this.hostRestartTimer = setTimeout(() => {
      this.hostRestartTimer = undefined;
      void this.startHost().catch(() => undefined);
    }, delayMs);
    this.hostRestartTimer.unref();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function readManifest(directory: string): Promise<ExtensionManifest> {
  const raw = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Partial<ExtensionManifest>;
  if (!raw.id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(raw.id)) throw new Error("manifest.id is invalid");
  if (!raw.name || !raw.version || !raw.description) throw new Error("manifest requires name, version and description");
  if (raw.apiVersion !== EXTENSION_API_VERSION) throw new Error(`Unsupported apiVersion ${raw.apiVersion ?? "missing"}`);
  const allowedPermissions = new Set(["context:read", "context:mutate", "tools:register", "sessions:read", "ui:panel", "ui:messageAttachment", "network:fetch"]);
  if (!Array.isArray(raw.permissions) || raw.permissions.some((permission) => typeof permission !== "string" || !allowedPermissions.has(permission))) throw new Error("manifest.permissions contains an unsupported permission");
  const entry = raw.entry ?? "index.js";
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error("manifest.entry must stay inside the extension directory");
  // 工具形态只允许官方扩展声明（此处只处理第三方 manifest，官方列表为内置硬编码）；
  // 第三方携带即拒绝，防止伪装成内置工具名。
  if (raw.toolShaping !== undefined && raw.official !== true) throw new Error("manifest.toolShaping is only allowed for official extensions");
  if (raw.toolShaping !== undefined) validateToolShaping(raw.toolShaping);
  if (raw.configSchema !== undefined && (!raw.configSchema || typeof raw.configSchema !== "object" || Array.isArray(raw.configSchema))) throw new Error("manifest.configSchema must be an object");
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description,
    apiVersion: raw.apiVersion,
    permissions: raw.permissions,
    entry,
    defaultEnabled: false,
    ...(raw.configSchema ? { configSchema: raw.configSchema } : {}),
    ...(raw.toolShaping ? { toolShaping: raw.toolShaping } : {}),
  };
}

function validateToolShaping(spec: ToolShapingSpec): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("manifest.toolShaping must be an object");
  if (spec.hideBuiltIns !== undefined && (!Array.isArray(spec.hideBuiltIns) || spec.hideBuiltIns.some((name) => typeof name !== "string"))) {
    throw new Error("manifest.toolShaping.hideBuiltIns must be an array of tool names");
  }
  if (spec.aliases !== undefined && (!Array.isArray(spec.aliases) || spec.aliases.some((alias) => !alias || typeof alias.from !== "string" || typeof alias.as !== "string"
    || (alias.argMap !== undefined && (!alias.argMap || typeof alias.argMap !== "object" || Array.isArray(alias.argMap) || Object.values(alias.argMap).some((value) => typeof value !== "string")))))) {
    throw new Error("manifest.toolShaping.aliases entries require string from/as and an optional string-valued argMap");
  }
}
