import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEvent, EventBus } from "../events/event-bus.js";
import type { FastModelClient } from "../fast-model.js";
import type { CoreClientLike } from "../core-client.js";
import { getModelProfile } from "../context/model-profile.js";
import type { ModelRegistry } from "../context/model-registry.js";
import { minimalChildEnv } from "../mcp/client.js";
import { isMissing } from "../fs-utils.js";
import type { ProviderRegistry, ProviderTool } from "../providers/provider.js";
import type { ChatMessage } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import { ContextManager } from "../context/context-manager.js";
import { clampExtensionRouteTimeout, isExtensionEventAllowed, isExtensionHook, type ApiRequest, type ApiResponse, type ContextHookPayload, type EventMessage, type ExtensionApiMethod, type ExtensionHook, type ExtensionInfo, type ExtensionManifest, type ExtensionPermission, type ExtensionState, type ExtensionToolResult, type ExtensionToolSpec, type HostRequest, type HostResponse, type PromptHookPayload, type PromptHookResult, type ToolAfterHookPayload, type ToolHookPayload, type ToolShapingAlias, type ToolShapingSpec } from "./types.js";
import { OFFICIAL_DEFAULT_CONFIG, OFFICIAL_EXTENSIONS } from "./official.js";
import { readManifest, type DiscoveredManifest } from "./manifest.js";
import { ExtensionStorage, storageRoot, type StorageQuota } from "./extension-storage.js";
import { publicSessionDetail, publicSessionMeta } from "./session-projection.js";
import { dshPluginInfos, dshToolSourceId, scanDshPlugins, type DshPluginInfo, type DshPluginReport } from "../dsh/loader.js";
import { DSH_SERVICE_APIS } from "../dsh/services.js";
import { setSimulatedUserAgent } from "../user-agent.js";
import { BUILTIN_PRESETS, getPreset, listPresets, resolvePreset, presetsDir, saveUserPreset, deleteUserPreset, PRESET_TOOL_GROUPS, PRESET_TOOLS, type PresetDetail, type AgentPreset, type PresetSummary } from "./agent-presets/index.js";
import type { CompactVaultService } from "./compact-vault.js";
import type { ProviderProfilesService } from "../provider-profiles.js";
import { MAX_IMAGE_BASE64_CHARS } from "../media-limits.js";
import { completeWithFastModel, describeWithVisionModel } from "./extension-model-api.js";
import { importSession } from "./extension-session-import.js";
import { upsertProviderProfiles } from "./extension-provider-api.js";

/** activeToolShaping 聚合结果：hideBuiltIns 按内置名隐藏，aliases 以新名（as）为键。 */
export interface ActiveToolShaping {
  /** 非空时只保留白名单内的内置工具（硬上限）。 */
  allowedBuiltIns?: Set<string>;
  hideBuiltIns: Set<string>;
  toolDescriptions: Map<string, string>;
  aliases: Map<string, { from: string; description?: string; inputSchema?: Record<string, unknown>; argMap?: Record<string, string> }>;
  /** 是否允许扩展/MCP 工具进入工具表；缺省 true。 */
  externalTools?: boolean;
}

/** 扩展 HTTP 路由转发的错误：statusCode 直接映射为 REST 响应码。 */
export class ExtensionRouteError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const ALIAS_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** 子代理转录的 taskId 形状（uuid；与 SessionStore/routes 的读取侧同一正则，防路径穿越）。 */
const SUBAGENT_TASK_ID_PATTERN = /^[0-9a-f-]{36}$/;
const BUILTIN_PRESET_IDS = new Set(BUILTIN_PRESETS.map((preset) => preset.id));
/** dsh 插件同步超时：插件激活可能含 IO（模型调用应在 apply 之外，超时即判错）。 */
const DSH_SYNC_TIMEOUT_MS = 30_000;
/** context.readImageFile 图片 base64 上限（≈5MB 原始字节，与消息带图同口径）：见 media-limits.ts。 */

interface StoredConfig { version: 1; extensions: Record<string, ExtensionState> }

/** 官方扩展 id 改名迁移表（新 id → 旧 id）：loadStates 时新键缺失则读旧键。 */
const EXTENSION_ID_MIGRATIONS: Record<string, string> = { "context-saver": "context-manager", "agent-presets": "env-sim" };

/** 扩展 API 所需的权限映射；null = 无需权限（私有能力，如扩展私有存储）。events.subscribe 挂 sessions:read。 */
const API_PERMISSIONS: Record<ExtensionApiMethod, ExtensionPermission | null> = {
  "sessions.list": "sessions:read",
  "sessions.get": "sessions:read",
  "sessions.getLedger": "sessions:read",
  "sessions.getSubagent": "sessions:read",
  "context.getView": "context:read",
  "context.readArtifact": "context:read",
  "context.readVaultFile": "context:read",
  "context.readImageFile": "context:read",
  "events.subscribe": "sessions:read",
  "storage.read": null,
  "storage.write": null,
  "storage.delete": null,
  "storage.list": null,
  "model.complete": "model:fast",
  "model.vision": "model:fast",
  "models.getCapabilities": null,
  "models.defaultSelection": null,
  "providers.listProfiles": "providers:read",
  "providers.upsertProfiles": "providers:mutate",
  "sessions.import": "sessions:mutate",
};

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
  /** 宿主上报的「已启用且注册了处理器」的钩子集合：空钩子跳过 IPC，避免大上下文每轮序列化。 */
  private readonly hostHooks = new Set<ExtensionHook>();
  private busListenerAttached = false;
  /** 已发出的工具形态警告（去重，避免每轮重复刷事件）。 */
  private readonly shapingWarningsIssued = new Set<string>();
  /** UA 模拟刷新序号：连续 configure 时只让最后一次异步解析落地。 */
  private userAgentSimulationSeq = 0;
  /** dsh 兼容模式（M2）：上次同步聚合的插件状态，供 REST/UI 读取。 */
  private dshInfos: DshPluginInfo[] = [];
  /** 已请求过 dsh 同步：宿主崩溃重启 / 热重载后自动重放最近一次加载计划。 */
  private dshSyncRequested = false;
  /** 上次同步时 dsh 兼容模式的开关态（决定下发真实计划还是空计划）。 */
  private dshSyncEnabled = false;
  /** 宿主启动中的 promise（含 initialize + 启动期重放），供 dsh 插件同步等待。 */
  private hostStarting: Promise<void> | undefined;
  /** 当前这次 dsh 同步是否由宿主启动流程（重放）驱动：是则不再等 `hostStarting`。 */
  private dshSyncFromHostStart = false;
  private dshSyncInFlight: Promise<DshPluginInfo[]> | undefined;

  constructor(private readonly dataDir: string, private readonly events?: EventBus, private readonly deps: { sessions?: SessionStore; fastModel?: FastModelClient; storageQuota?: StorageQuota; vaultService?: CompactVaultService; providers?: ProviderRegistry; core?: CoreClientLike; models?: ModelRegistry; providerProfiles?: ProviderProfilesService; events?: EventBus; resolveModelSelection?: (provider?: string) => { provider?: string; model?: string } | undefined } = {}) {
    this.root = path.join(dataDir, "extensions");
    this.configPath = path.join(this.root, "extensions.json");
    if (this.events && !this.deps.events) this.deps.events = this.events;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.manifests = [...OFFICIAL_EXTENSIONS, ...(await this.discoverThirdParty())];
    this.states = await this.loadStates();
    await this.applyUserAgentSimulation();
    // 延迟启动：没有任何启用扩展时不 fork 宿主进程（实测常驻 100MB+，且扩展宿主是独立 Node）。
    // 首次真正需要宿主的操作（启用扩展 / 打开 dsh 兼容模式）会按需拉起，见 ensureHost()。
    if (this.hasEnabledExtensions()) await this.startHost();
    else process.stderr.write("[extensions] 无需要宿主的启用扩展：扩展宿主延迟启动（server 侧扩展照常生效）\n");
  }

  /** server 侧内建功能：启用不意味着需要 Extension Host。 */
  private static readonly HOSTLESS_EXTENSIONS = new Set([
    "agent-presets", "owc-eval", "session-format-upgrade",
  ]);

  /** 是否有任一需要宿主的启用扩展（延迟启动宿主判据）。 */
  private hasEnabledExtensions(): boolean {
    return this.manifests.some((manifest) => !ExtensionManager.HOSTLESS_EXTENSIONS.has(manifest.id) && this.stateFor(manifest).enabled);
  }

  /**
   * 按需拉起扩展宿主：宿主未连接时启动（启动中的并发调用等同一份启动）。
   * 注意启动流程内部（startHostProcess / runDshSync 的 fromHostStart 分支）不得调用本方法，
   * 否则会自等死锁。
   */
  private async ensureHost(): Promise<void> {
    if (this.child?.connected) return;
    if (this.hostStarting) {
      await this.hostStarting.catch(() => undefined);
      return;
    }
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
    this.hostHooks.clear();
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
      const hostless = ExtensionManager.HOSTLESS_EXTENSIONS.has(manifest.id);
      const status = !state.enabled ? "disabled" as const : hostless ? "running" as const : connected && !hostError ? "running" as const : "error" as const;
      const { directory: _directory, ...publicManifest } = manifest;
      return {
        ...publicManifest,
        enabled: state.enabled,
        builtIn: manifest.official === true,
        status,
        config: { ...state.config },
        ...(state.enabled && !hostless && (hostError || !connected) ? { error: hostError ?? "Extension Host 未连接" } : {}),
      };
    });
  }

  isEnabled(id: string): boolean {
    const manifest = this.manifests.find((item) => item.id === id);
    if (manifest) return this.stateFor(manifest).enabled;
    // dsh 插件是伪扩展（无 manifest）：启用态由 dsh 同步回报决定。
    return this.dshInfos.some((info) => dshToolSourceId(info.id) === id && info.status === "running");
  }

  /** 扩展 id 是否已知（官方或已安装的第三方）；供 REST 层做会话级扩展状态等校验。 */
  hasExtension(id: string): boolean {
    return this.manifests.some((item) => item.id === id);
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
    await this.applyUserAgentSimulation();
    if (this.hasEnabledExtensions() || this.dshSyncEnabled) {
      await this.ensureHost();
      const reloaded = await this.request("reload", { states: this.states }) as { tools?: Record<string, ExtensionToolSpec[]>; hooks?: unknown };
      this.replaceTools(reloaded.tools);
      this.replaceHostHooks(reloaded.hooks);
      // reload 会清空宿主侧扩展状态：dsh 伪扩展的启用态与工具随加载计划重放。
      await this.resyncDsh();
    } else {
      // 延迟启动的对称面：最后一个扩展关闭后宿主不再有活可干，回收进程（常驻 100MB+）。
      await this.close();
    }
    this.events?.publish({ source: "server", type: "extension.updated", payload: { id, ...this.states[id] } });
    return this.list().find((item) => item.id === id)!;
  }

  async install(sourcePath: string): Promise<ExtensionInfo> {
    if (!path.isAbsolute(sourcePath)) throw new Error("Extension path must be absolute");
    if (!(await stat(sourcePath).catch(() => undefined))?.isDirectory()) throw new Error("Extension path must be a directory");
    // readManifest 已拒绝 official 声明；这里只处理重复 id。
    const manifest = await readManifest(sourcePath);
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

  async beforeTool(payload: ToolHookPayload): Promise<ToolHookPayload & { blocked?: boolean; reason?: string; audit?: string }> {
    // dsh 兼容模式（M3）：任一 dsh 插件监听 tools/pre-execute 时走宿主 waterfall，
    // 按上游判别式取 deny/ask/cancel（ask 降级为放行 + 审计）；无监听快速回落到通用扩展链。
    if (this.dshInfos.some((info) => info.status === "running")) {
      const dshOutcome = await this.dshToolHook("dsh.beforeTool", payload) as { blocked?: boolean; reason?: string; audit?: string } | undefined;
      if (dshOutcome?.blocked) return { ...payload, blocked: true, ...(dshOutcome.reason ? { reason: dshOutcome.reason } : {}) };
    }
    return this.hook("tool.beforeExecute", payload) as Promise<ToolHookPayload & { blocked?: boolean; reason?: string }>;
  }

  /** tool.afterExecute（M3）：工具执行完成通知；dsh post-execute 可变换 content/isError（失败只记录不阻断）。 */
  async afterTool(payload: ToolAfterHookPayload): Promise<ToolAfterHookPayload> {
    if (this.dshInfos.some((info) => info.status === "running")) {
      const dshOutcome = await this.dshToolHook("dsh.afterTool", payload) as { content?: string; isError?: boolean } | undefined;
      if (dshOutcome && (typeof dshOutcome.content === "string" || dshOutcome.isError === true)) {
        return {
          ...payload,
          result: {
            ...payload.result,
            ...(typeof dshOutcome.content === "string" ? { content: dshOutcome.content } : {}),
            ...(dshOutcome.isError === true ? { isError: true } : {}),
          },
        };
      }
    }
    const result = await this.hook("tool.afterExecute", payload) as { result?: { content?: string; isError?: boolean } };
    if (result?.result && (typeof result.result.content === "string" || result.result.isError === true)) {
      return {
        ...payload,
        result: {
          ...payload.result,
          ...(typeof result.result.content === "string" ? { content: result.result.content } : {}),
          ...(result.result.isError === true ? { isError: true } : {}),
        },
      };
    }
    return payload;
  }

  /** dsh 工具钩子：走宿主专设通道（dsh.beforeTool/dsh.afterTool），失败只记录不变换。 */
  private async dshToolHook(method: "dsh.beforeTool" | "dsh.afterTool", payload: ToolHookPayload | ToolAfterHookPayload): Promise<unknown> {
    try {
      return await this.request(method, { ...payload }, 5500);
    } catch (error) {
      this.events?.publish({ source: "server", type: "extension.hook_failed", payload: { hook: method, message: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  }

  /**
   * agent-presets 出站 UA 模拟：直接调用 user-agent 模块的覆盖接口（自动填充拟态 UA）。
   * 仅由扩展的全局配置驱动——`config.simulateUserAgent` 手动开关 + 全局
   * `config.preset` 预设的 userAgent 字段，二者同时满足才生效；否则清除覆盖
   * 恢复官方默认。会话级 persona 覆盖不参与：出站请求没有会话上下文，全局
   * 覆盖会在并发会话间串扰。更新检查链路固定官方 UA，不受模拟影响。
   * 用序列号防止连续 configure 的异步解析乱序落地。
   */
  private async applyUserAgentSimulation(): Promise<void> {
    const agentPresets = this.manifests.find((item) => item.id === "agent-presets");
    const seq = ++this.userAgentSimulationSeq;
    const clear = (): void => {
      if (seq === this.userAgentSimulationSeq) setSimulatedUserAgent(null);
    };
    if (!agentPresets || !this.stateFor(agentPresets).enabled) {
      clear();
      return;
    }
    const config = this.stateFor(agentPresets).config;
    if (config.simulateUserAgent !== true) {
      clear();
      return;
    }
    // 用户优先解析（覆盖文件需读目录）——异步等待完成再返回，保证 configure/initialize
    // 返回时 UA 已就位（测试与热更新依赖该顺序）。
    const persona = await resolvePreset(this.dataDir, config, (message) => this.warnShaping(message));
    if (seq !== this.userAgentSimulationSeq) return; // 已被更新的配置覆盖
    setSimulatedUserAgent(persona?.userAgent ?? null);
  }

  /**
   * prompt.beforeBuild 变换：先走 host 的通用 hook 扇出（带 prompt:shape 权限的第三方扩展），再叠加 agent-presets。
   * agent-presets 的提示词变换在 server 侧直接合成——内置预设与用户预设目录都是 server 本地
   * 状态，经 Extension Host IPC 传递反而是多余一跳（与工具形态同为 server 侧内建行为）。
   */
  async transformPrompt(payload: PromptHookPayload, sessionPreset?: string): Promise<PromptHookResult> {
    const hostResult = await this.hook("prompt.beforeBuild", payload) as Partial<PromptHookResult>;
    const result: PromptHookResult = {
      ...(hostResult.promptStyle === "minimal" || hostResult.promptStyle === "classic" ? { promptStyle: hostResult.promptStyle } : {}),
      ...(hostResult.projectContext === "paths" || hostResult.projectContext === "content" || hostResult.projectContext === "none" ? { projectContext: hostResult.projectContext } : {}),
      ...(typeof hostResult.identity === "string" ? { identity: hostResult.identity } : {}),
      ...(typeof hostResult.basePromptOverride === "string" ? { basePromptOverride: hostResult.basePromptOverride } : {}),
      ...(Array.isArray(hostResult.productSections) ? { productSections: hostResult.productSections.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(hostResult.prependSections) ? { prependSections: hostResult.prependSections.filter((item): item is string => typeof item === "string") } : {}),
    };
    const agentPresets = this.manifests.find((item) => item.id === "agent-presets");
    if (agentPresets && this.stateFor(agentPresets).enabled) {
      // 会话级 persona（SessionMeta.persona）优先于扩展全局 config.preset
      const persona = await resolvePreset(this.dataDir, this.stateFor(agentPresets).config, (message) => this.warnShaping(message), sessionPreset);
      if (persona) {
        result.identity = persona.identity;
        result.basePromptOverride = persona.basePrompt;
        result.productSections = persona.productSections;
        result.promptStyle = persona.promptStyle ?? "classic";
        result.projectContext = persona.projectContext ?? "content";
      }
    }
    return result;
  }

  /**
   * 聚合所有已启用且有权声明工具形态的扩展（静态 manifest toolShaping + agent-presets 活跃预设）。
   * 官方扩展直接声明；第三方扩展需 tools:shaping 权限（readManifest 已把关，此处纵深防御）。
   * builtInNames 传入本轮实际内置工具表（含条件项），据此完成 from 存在性与命名冲突校验；
   * 无效条目记警告并跳过。无形态生效时返回 undefined。
   */
  async activeToolShaping(builtInNames: readonly string[], sessionPreset?: string): Promise<ActiveToolShaping | undefined> {
    const shaping: ActiveToolShaping = { hideBuiltIns: new Set(), toolDescriptions: new Map(), aliases: new Map() };
    for (const manifest of this.manifests) {
      if (!manifest.toolShaping || !this.stateFor(manifest).enabled) continue;
      if (manifest.official !== true && !manifest.permissions.includes("tools:shaping")) continue;
      this.applyShapingSpec(manifest.id, manifest.toolShaping, builtInNames, shaping);
    }
    const agentPresets = this.manifests.find((item) => item.id === "agent-presets");
    if (agentPresets && this.stateFor(agentPresets).enabled) {
      // agent-presets 的形态由 config.preset 驱动（动态预设），不走静态 manifest toolShaping；
      // 会话级 persona 覆盖与 transformPrompt 同源。
      const persona = await resolvePreset(this.dataDir, this.stateFor(agentPresets).config, (message) => this.warnShaping(message), sessionPreset);
      if (persona) {
        if (persona.allowedBuiltIns?.length) shaping.allowedBuiltIns = new Set(persona.allowedBuiltIns);
        // 白名单里的未知工具名不阻断（保存时已校验），但运行时要能看见漂移
        for (const name of persona.allowedBuiltIns ?? []) {
          if (!builtInNames.includes(name)) this.warnShaping(`agent-presets: allowed tool "${name}" is not in this turn's built-in tool set`);
        }
        if (persona.externalTools === false) shaping.externalTools = false;
        for (const [name, description] of Object.entries(persona.toolDescriptions ?? {})) {
          if (builtInNames.includes(name)) shaping.toolDescriptions.set(name, description);
        }
        this.applyShapingSpec("agent-presets", { hideBuiltIns: persona.hideBuiltIns, aliases: persona.aliases }, builtInNames, shaping);
      }
    }
    return !shaping.allowedBuiltIns && shaping.hideBuiltIns.size === 0 && shaping.toolDescriptions.size === 0 && shaping.aliases.size === 0
      && shaping.externalTools !== false ? undefined : shaping;
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

  /**
   * dsh 兼容模式插件同步（M2）：扫描 `<dataDir>/dsh-plugins` + `<dataDir>/dsh.json` 合成加载计划，
   * 下发 Extension Host（插件激活在子进程内逐插件隔离），再与宿主回报合并为最终状态。
   * 再次调用即全量重放（停用的插件自动卸载并回滚已注册的工具）；宿主重启 / 热重载后自动重放。
   *
   * `enabled` 对应设置 `dshCompatEnabled`（默认关闭）：关闭时下发**空计划**，把已加载的 dsh 插件
   * 全部卸载并回滚工具——dsh 插件是可信代码，加载与否由用户显式开关决定，而不是「装了就生效」。
   */
  async syncDsh(enabled = true): Promise<DshPluginInfo[]> {
    this.dshSyncEnabled = enabled;
    this.dshSyncRequested = true;
    // 打开兼容模式 = 有活要给宿主干：延迟启动的宿主在这里按需拉起（关闭态无需唤醒）
    if (enabled) await this.ensureHost();
    const previous = this.dshSyncInFlight;
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve([])).then(() => this.runDshSync());
    this.dshSyncInFlight = next;
    try {
      return await next;
    } finally {
      if (this.dshSyncInFlight === next) this.dshSyncInFlight = undefined;
    }
  }

  /** 上次同步聚合的 dsh 插件状态（未同步过返回空表）。 */
  dshPlugins(): DshPluginInfo[] {
    return this.dshInfos.map((info) => ({ ...info }));
  }

  private async runDshSync(): Promise<DshPluginInfo[]> {
    // 宿主正在启动（initialize + 启动期重放）时先等它落地：启动流程自己调用时用 fromHostStart 跳过，
    // 避免自等死锁（resyncDsh 由 startHostProcess 内部调用）。
    if (!this.dshSyncFromHostStart && this.hostStarting !== undefined) {
      await this.hostStarting.catch(() => undefined);
    }
    const scan = await scanDshPlugins(this.dataDir);
    // 模式关闭：空计划 = 卸载全部 dsh 插件（含工具回滚），状态表如实标注原因
    const plan = this.dshSyncEnabled ? scan.plan : [];
    const child = this.child;
    if (!child?.connected) {
      this.dshInfos = dshPluginInfos(scan, undefined, "Extension Host 未连接，dsh 插件未加载", this.dshSyncEnabled);
      return this.dshInfos;
    }
    let failure: string | undefined;
    try {
      const response = await this.request("dsh.sync", { plugins: plan }, DSH_SYNC_TIMEOUT_MS) as { plugins?: DshPluginReport[]; tools?: Record<string, ExtensionToolSpec[]> };
      this.replaceTools(response.tools);
      this.dshInfos = dshPluginInfos(scan, response.plugins, undefined, this.dshSyncEnabled);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      const message = `dsh 插件同步失败：${failure}`;
      this.events?.publish({ source: "server", type: "extension.warning", payload: { message } });
      this.dshInfos = dshPluginInfos(scan, undefined, message, this.dshSyncEnabled);
    }
    return this.dshInfos;
  }

  /** 宿主重启 / 热重载后重放 dsh 加载计划（未同步过则跳过）。 */
  private async resyncDsh(): Promise<void> {
    if (!this.dshSyncRequested) return;
    this.dshSyncFromHostStart = true;
    try {
      await this.runDshSync().catch(() => undefined);
    } finally {
      this.dshSyncFromHostStart = false;
    }
  }

  /** agent-presets 预设清单 + 用户预设目录绝对路径（UI 展示「把分享的预设 JSON 放到这里」）。 */
  async listAgentPresets(): Promise<{ presets: PresetSummary[]; directory: string; enabled: boolean }> {
    const manifest = this.manifests.find((item) => item.id === "agent-presets");
    return {
      presets: await listPresets(this.dataDir, (message) => this.warnShaping(message)),
      directory: presetsDir(this.dataDir),
      enabled: Boolean(manifest && this.stateFor(manifest).enabled),
    };
  }

  /** agent-presets 预设详情（选前预览端点）；未命中返回 null。 */
  async agentPresetDetail(id: string): Promise<PresetDetail | null> {
    return getPreset(this.dataDir, id, (message) => this.warnShaping(message));
  }

  /** 当前生效的 agent-presets 预设（会话级覆盖优先于扩展全局配置）；未启用/未设置/未知返回 null。 */
  async activeAgentPreset(sessionPreset?: string): Promise<PresetSummary | null> {
    const preset = await this.activeAgentPresetDetail(sessionPreset);
    if (!preset) return null;
    const builtin = BUILTIN_PRESET_IDS.has(preset.id);
    return { id: preset.id, name: preset.name, description: preset.description ?? preset.name, category: preset.category ?? (builtin ? "mimicry" : "custom"), builtin };
  }

  /** 当前生效的 agent-presets 完整预设（/init、/compact 命令提示词拟态消费用）；未启用/未设置/未知返回 null。 */
  async activeAgentPresetDetail(sessionPreset?: string): Promise<AgentPreset | null> {
    const agentPresets = this.manifests.find((item) => item.id === "agent-presets");
    if (!agentPresets || !this.stateFor(agentPresets).enabled) return null;
    return resolvePreset(this.dataDir, this.stateFor(agentPresets).config, (message) => this.warnShaping(message), sessionPreset);
  }

  /** 新建/覆盖用户 agent-presets 预设（形状不合法抛错，REST 映射 400）；与内置同 id 即「自定义内置」：写入覆盖文件，解析侧字段级合并。 */
  async createAgentPreset(raw: unknown): Promise<PresetDetail> {
    const preset = await saveUserPreset(this.dataDir, raw);
    const detail = await getPreset(this.dataDir, preset.id, (message) => this.warnShaping(message));
    if (!detail) throw new Error(`preset "${preset.id}" was saved but cannot be read back`);
    return detail;
  }

  /** 删除用户 agent-presets 预设；内置 id 时删除覆盖文件（还原内置），无覆盖文件返回 false（REST 映射 404）。 */
  async deleteAgentPreset(id: string): Promise<boolean> {
    return deleteUserPreset(this.dataDir, id);
  }

  /** 精简模式工具编辑器供数：全量内置工具目录 + 默认分组。 */
  agentPresetToolCatalog(): { tools: typeof PRESET_TOOLS; groups: typeof PRESET_TOOL_GROUPS } {
    return { tools: PRESET_TOOLS, groups: PRESET_TOOL_GROUPS };
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

  /** 转发 agent 的 ext__ 工具调用到 Extension Host；5 秒超时按工具失败处理。sessionId 透传给 host（recall_memory 等按会话归档定位）。 */
  async invokeTool(namespaced: string, input: Record<string, unknown>, sessionId?: string): Promise<ExtensionToolResult> {
    const match = /^ext__([a-z0-9][a-z0-9-]{1,63})__([a-zA-Z0-9_-]{1,64})$/.exec(namespaced);
    const extensionId = match?.[1] ?? "";
    const tool = match?.[2] ?? "";
    if (!match || !this.extensionTools.get(extensionId)?.has(tool)) throw new Error(`Unknown extension tool: ${namespaced}`);
    if (!this.isEnabled(extensionId)) throw new Error(`Extension ${extensionId} is disabled`);
    const declared = this.extensionTools.get(extensionId)?.get(tool)?.timeoutMs;
    const timeoutMs =
      typeof declared === "number" && Number.isFinite(declared)
        ? Math.min(Math.max(declared, 1000), 120_000)
        : 5000;
    const result = await this.request("tool.invoke", { extensionId, tool, input, ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}) }, timeoutMs);
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
          ...(typeof spec.timeoutMs === "number" && Number.isFinite(spec.timeoutMs) ? { timeoutMs: spec.timeoutMs } : {}),
        });
      }
      if (registered.size > 0) this.extensionTools.set(extensionId, registered);
    }
  }

  /** 用宿主上报的启用钩子集合替换本地视图（非法值忽略；宿主应答缺失时视为无钩子）。 */
  private replaceHostHooks(reported: unknown): void {
    this.hostHooks.clear();
    if (!Array.isArray(reported)) return;
    for (const hook of reported) if (isExtensionHook(hook)) this.hostHooks.add(hook);
  }

  private async hook(hook: ExtensionHook, payload: unknown): Promise<unknown> {
    // 没有启用的处理器时跳过 IPC：context/message 钩子携带完整消息数组，空转的序列化成本随上下文线性增长。
    if (!this.hostHooks.has(hook)) return hook === "prompt.beforeBuild" ? {} : payload;
    try {
      // context 变换钩子可能含模型调用（视觉描述、翻译等），超时放宽到 120s；其余保持 5.5s
      const timeoutMs = hook === "context.beforeBuild" || hook === "message.beforeSend" ? 120_000 : undefined;
      return await this.request("hook", { hook, payload }, timeoutMs);
    } catch (error) {
      this.events?.publish({ source: "server", type: "extension.hook_failed", payload: { hook, message: error instanceof Error ? error.message : String(error) } });
      // prompt 钩子的结果是「覆盖补丁」而非变换后的载荷，失败时回空补丁（回载荷会被误读成 identity/basePrompt）。
      return hook === "prompt.beforeBuild" ? {} : payload;
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
    const params = request.params ?? {};
    // 已注册扩展优先于 dsh 伪扩展：官方扩展 id `dsh-sync` 落在伪 id 前缀 `dsh-` 里，
    // 先按前缀分流会把它误判为 dsh 插件通道，故先查 manifests。
    const manifest = this.manifests.find((item) => item.id === request.extensionId);
    // dsh 兼容模式（M3）：dsh 插件以伪扩展 id 调用宿主能力——不经 manifest 权限表，
    // 只放行 DSH_SERVICE_APIS 白名单（llm/sessions/storage/events.subscribe），存储按伪 id 隔离。
    if (!manifest && request.extensionId.startsWith("dsh-")) {
      return this.dispatchDshApi(request.extensionId, request.api, params);
    }
    if (!manifest) throw new Error(`Unknown extension: ${request.extensionId}`);
    if (!(request.api in API_PERMISSIONS)) throw new Error(`Unsupported extension api: ${request.api}`);
    const required = API_PERMISSIONS[request.api];
    if (required && !manifest.permissions.includes(required)) throw new Error(`Extension ${manifest.id} lacks permission: ${required}`);
    const sessions = this.deps.sessions;
    switch (request.api) {
      case "sessions.list": {
        return this.listSessionMetas();
      }
      case "sessions.get": {
        return this.getSessionDetail(params);
      }
      case "sessions.getLedger": {
        if (!sessions) throw new Error("Session store is not configured");
        const sessionId = String(params.id ?? "");
        // 只校验存在性：getMeta 只读 meta.json，不解析 messages.jsonl（大会话开销差异显著）。
        if (!(await sessions.getMeta(sessionId))) throw new Error("Session not found");
        // 全量账本（含 compacted/compactionHistory）：getLedger 返回深克隆，可安全经 IPC 送出。
        return new ContextManager(sessions.contextRoot(sessionId)).getLedger();
      }
      case "sessions.getSubagent": {
        // 子代理转录（dsh-sync M5a）：<sessionDir>/subagents/<taskId>.json 原样返回；
        // 转录不存在返回 null（面板显示「无转录」而不是报错）。
        if (!sessions) throw new Error("Session store is not configured");
        const sessionId = String(params.sessionId ?? "");
        const taskId = String(params.taskId ?? "");
        if (!(await sessions.getMeta(sessionId))) throw new Error("Session not found");
        // taskId 限定 uuid：转录路径由扩展入参拼出，不校验即可穿越出会话目录
        //（与 routes/sessions-files.ts 的读取侧同一口径）。
        if (!SUBAGENT_TASK_ID_PATTERN.test(taskId)) throw new Error("taskId must be a uuid");
        const transcriptPath = path.join(sessions.contextRoot(sessionId), "subagents", `${taskId}.json`);
        let raw: string;
        try {
          raw = await readFile(transcriptPath, "utf8");
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          throw new Error("子代理转录内容损坏");
        }
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
        if (!(await sessions.getMeta(sessionId))) throw new Error("Session not found");
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        const limit = params.limit === undefined ? 64_000 : Number(params.limit);
        return new ContextManager(sessions.contextRoot(sessionId)).readArtifact(String(params.artifactId ?? ""), offset, limit);
      }
      case "context.readVaultFile": {
        // 只读会话 compact/ 归档目录（路径锁定与配额由 CompactVaultService 把关）
        if (!this.deps.vaultService) throw new Error("Compact vault service is not configured");
        return { content: await this.deps.vaultService.readFile(String(params.sessionId ?? ""), String(params.path ?? "")) };
      }
      case "context.readImageFile": {
        // 视觉工具 path 形态：经 core 沙盒读取工作区图片（png/jpeg/webp/gif ≤5MB 原始字节）
        const core = this.deps.core;
        if (!core) throw new Error("Core client is not configured");
        const sessionId = String(params.sessionId ?? "");
        const imagePath = String(params.path ?? "");
        if (!sessionId || !imagePath) throw new Error("context.readImageFile requires sessionId and path");
        const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
        const mediaType = ext === "png" ? "image/png"
          : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "webp" ? "image/webp"
          : ext === "gif" ? "image/gif"
          : "";
        if (!mediaType) throw new Error("context.readImageFile path must end with .png/.jpg/.jpeg/.webp/.gif");
        if (!core.readFileBase64) throw new Error("Core binary image read support is unavailable");
        const result = await core.readFileBase64({ sessionId, path: imagePath });
        if (result.truncated) throw new Error("context.readImageFile image exceeds the 5MB limit");
        if (!result.base64 || result.base64.length > MAX_IMAGE_BASE64_CHARS) throw new Error("context.readImageFile image data is empty or too large");
        return { mediaType, data: result.base64 };
      }
      case "events.subscribe": {
        return this.subscribeEvents(manifest.id, params);
      }
      case "storage.read": {
        return this.storage(manifest.id).read(String(params.path ?? ""));
      }
      case "storage.write": {
        return this.storage(manifest.id).write(String(params.path ?? ""), params.content);
      }
      case "storage.delete": {
        return this.storage(manifest.id).delete(String(params.path ?? ""));
      }
      case "storage.list": {
        return this.storage(manifest.id).list(typeof params.prefix === "string" ? params.prefix : "");
      }
      case "model.complete": {
        return completeWithFastModel(this.deps.fastModel, params);
      }
      case "model.vision": {
        return describeWithVisionModel(this.deps.providers, params);
      }
      case "models.getCapabilities": {
        const model = typeof params.model === "string" && params.model ? params.model : "";
        if (!model) throw new Error("models.getCapabilities requires a model string");
        // 经 registry 解析（同 id 多 provider 时用户手动声明优先），未命中回落静态元数据；
        // 避免内置兜底能力盖过用户在模型目录的显式声明（如 vision 支持）。
        const capabilities = (this.deps.models?.get(model) ?? getModelProfile(model)).capabilities;
        return {
          vision: capabilities.modalities.includes("image"),
          modalities: [...capabilities.modalities],
          thinking: [...capabilities.thinking],
        };
      }
      case "models.defaultSelection": {
        // dsh-sync 导出补全用：给了 provider 只解析该 provider 的默认模型（provider 原样回传，
        // 不张冠李戴）；未给则走 owc 当前默认链。未接线时回空对象，由调用方按「补不出来」处理。
        const provider = typeof params.provider === "string" && params.provider ? params.provider : undefined;
        return this.deps.resolveModelSelection?.(provider) ?? {};
      }
      case "providers.listProfiles": {
        // 只回脱敏视图（hasApiKey/maskedApiKey），扩展全程拿不到明文 Key。
        const providerProfiles = this.deps.providerProfiles;
        if (!providerProfiles) throw new Error("Provider profiles service is not configured");
        return providerProfiles.view().modelProviders;
      }
      case "providers.upsertProfiles": {
        return upsertProviderProfiles(this.deps, params);
      }
      case "sessions.import": {
        if (!sessions) throw new Error("Session store is not configured");
        return importSession({
          sessions,
          ...(this.deps.resolveModelSelection ? { resolveModelSelection: this.deps.resolveModelSelection } : {}),
        }, params);
      }
    }
  }

  /** sessions.list 的只读投影（manifest 扩展与 dsh 伪扩展共用）。 */
  private async listSessionMetas(): Promise<Array<Record<string, unknown>>> {
    const sessions = this.deps.sessions;
    if (!sessions) throw new Error("Session store is not configured");
    return (await sessions.list()).map((meta) => publicSessionMeta(meta));
  }

  /** sessions.get 的只读投影（元信息白名单 + 消息本体）。 */
  private async getSessionDetail(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessions = this.deps.sessions;
    if (!sessions) throw new Error("Session store is not configured");
    const detail = await sessions.get(String(params.id ?? ""));
    if (!detail) throw new Error("Session not found");
    return publicSessionDetail(detail);
  }

  /** events.subscribe 的并集语义；requireBus 时无事件总线不登记（dsh 伪扩展口径）。 */
  private subscribeEvents(extensionId: string, params: Record<string, unknown>, requireBus = false): { subscribed: string[] } {
    const requested = Array.isArray(params.types) ? params.types.filter((type): type is string => typeof type === "string") : [];
    const allowed = requested.filter(isExtensionEventAllowed);
    if (requireBus && !this.dshEventBus) return { subscribed: allowed };
    // 与 host 侧累加语义对齐：重订阅取并集而非替换
    const existing = this.eventSubscriptions.get(extensionId);
    if (existing) {
      for (const type of allowed) existing.add(type);
    } else if (allowed.length > 0) {
      this.eventSubscriptions.set(extensionId, new Set(allowed));
    }
    this.attachBusListener();
    return { subscribed: allowed };
  }

  /**
   * dsh 伪扩展的能力分发（M3）：白名单 DSH_SERVICE_APIS，不经 manifest 权限表。
   * llm 走模型网关（model.complete/model.vision，不暴露 Key）；sessions 只读元信息白名单；
   * storage 复用扩展私有存储（按伪 id `dsh-<pluginId>` 隔离）；events.subscribe 走 EventBus 白名单。
   */
  private async dispatchDshApi(extensionId: string, api: ExtensionApiMethod, params: Record<string, unknown>): Promise<unknown> {
    const allowed = (DSH_SERVICE_APIS as readonly string[]).includes(api);
    if (!allowed) throw new Error(`dsh plugin lacks api access: ${api}`);
    switch (api) {
      case "model.complete":
        return completeWithFastModel(this.deps.fastModel, params);
      case "model.vision":
        return describeWithVisionModel(this.deps.providers, params);
      case "sessions.list": {
        return this.listSessionMetas();
      }
      case "sessions.get": {
        return this.getSessionDetail(params);
      }
      case "storage.read":
        return this.storage(extensionId).read(String(params.path ?? ""));
      case "storage.write":
        return this.storage(extensionId).write(String(params.path ?? ""), params.content);
      case "storage.delete":
        return this.storage(extensionId).delete(String(params.path ?? ""));
      case "storage.list":
        return this.storage(extensionId).list(typeof params.prefix === "string" ? params.prefix : "");
      case "events.subscribe": {
        return this.subscribeEvents(extensionId, params, true);
      }
    }
    throw new Error(`Unsupported dsh api: ${api}`);
  }

  /**
   * dsh EventBus：显式注入优先（测试可控），缺省回落构造器事件总线。
   * dsh 事件订阅经此推送——宿主进程把 EventMessage 转发到插件的 dshEvents handler。
   */
  private get dshEventBus(): EventBus | undefined {
    return this.deps.events ?? this.events;
  }

  /** 扩展私有存储访问器（根目录与配额在此固定；无状态，按调用创建）。 */
  private storage(extensionId: string): ExtensionStorage {
    return new ExtensionStorage(storageRoot(this.dataDir, extensionId), this.deps.storageQuota);
  }

  /**
   * 扩展私有 HTTP 路由转发（/api/ext/<id><path>）：manifest 路由表精确匹配后经 IPC 转发 host，
   * 超时取 manifest.routes[].timeoutMs（钳制 1000–120000，缺省 5000），host 侧再按同一口径 withTimeout。
   * 扩展未启用/未运行 → 503；路由未声明 → 404。
   */
  async routeHttpRequest(extensionId: string, method: string, requestPath: string, query: Record<string, unknown>, body: unknown): Promise<{ status: number; body: unknown }> {
    const manifest = this.manifests.find((item) => item.id === extensionId);
    if (!manifest) throw new ExtensionRouteError(404, `Unknown extension: ${extensionId}`);
    const route = (manifest.routes ?? []).find((entry) => entry.method === method && entry.path === requestPath);
    if (!route) throw new ExtensionRouteError(404, `Route not declared: ${method} ${requestPath}`);
    if (!this.isEnabled(extensionId)) throw new ExtensionRouteError(503, `Extension ${extensionId} is disabled`);
    if (!this.child?.connected) throw new ExtensionRouteError(503, "Extension Host is not connected");
    const timeoutMs = clampExtensionRouteTimeout(route.timeoutMs);
    let result: unknown;
    try {
      result = await this.request("http.request", { extensionId, method, path: requestPath, query, timeoutMs, ...(body !== undefined ? { body } : {}) }, timeoutMs);
    } catch (error) {
      throw new ExtensionRouteError(504, error instanceof Error ? error.message : String(error));
    }
    if (!result || typeof result !== "object") throw new ExtensionRouteError(502, "Extension returned an invalid route response");
    const value = result as { status?: unknown; body?: unknown };
    const status = typeof value.status === "number" && Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : 200;
    return { status, body: value.body };
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
      // 改名迁移（context-manager → context-saver，1.7.x）：新键缺失时读旧键的 enabled/config；
      // 幂等——下次 saveStates 只写新键，旧键自然消失。
      const value = stored.extensions?.[manifest.id] ?? stored.extensions?.[EXTENSION_ID_MIGRATIONS[manifest.id] ?? ""];
      result[manifest.id] = {
        enabled: typeof value?.enabled === "boolean" ? value.enabled : manifest.defaultEnabled === true,
        config: ExtensionManager.normalizeConfig(manifest.id, value?.config),
      };
    }
    return result;
  }

  /**
   * 存量配置归一：默认值 + 已存值。agent-presets 额外把旧 `persona` 键迁移成 `preset` 并**删除旧键**
   * ——configSchema 是 additionalProperties:false，留着旧键会让扩展配置表单回存时被 400 拒绝。
   */
  private static normalizeConfig(id: string, stored?: Record<string, unknown>): Record<string, unknown> {
    const config = { ...(OFFICIAL_DEFAULT_CONFIG[id] ?? {}), ...(stored ?? {}) };
    if (id !== "agent-presets") return config;
    const legacyPersona = typeof config.persona === "string" ? config.persona : undefined;
    delete config.persona;
    // 默认值里的空串视为「未设置」：旧 persona 有值时补进 preset
    if (typeof config.preset !== "string" || config.preset === "") config.preset = legacyPersona ?? "";
    return config;
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
    // 安装/卸载后同样保持按需启动：没有启用扩展（且未开 dsh 兼容）就不拉起宿主。
    if (this.hasEnabledExtensions() || this.dshSyncEnabled) await this.startHost();
  }

  /**
   * 启动宿主：并发调用合并，且把「启动中」的状态暴露给 dsh 插件同步（`runDshSync`）——
   * 否则宿主 initialize 完成时会清空 dsh 伪扩展状态，把启动期并发下发的加载计划悄悄抹掉。
   */
  private async startHost(): Promise<void> {
    const previous = this.hostStarting;
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => this.startHostProcess());
    this.hostStarting = next;
    try {
      await next;
    } finally {
      if (this.hostStarting === next) this.hostStarting = undefined;
    }
  }

  private async startHostProcess(): Promise<void> {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = fileURLToPath(new URL(`./extension-host-process.${extension}`, import.meta.url));
    // dist 运行直接 fork 编译后的 JS；tsx 开发/测试运行显式安装 loader，确保 NodeNext 的 .js specifier 可解析到 .ts 源文件。
    // env 白名单（与 MCP 子进程同款纪律）：不透传宿主完整 process.env——扩展是可信代码，
    // 但架构边界声明「扩展不得获得全局环境变量」（含 OWC_ACCESS_TOKEN、代理凭据等）。
    // 扩展宿主是独立 Node 进程：既不继承父进程的 --expose-gc，也没有任何堆上限（默认按物理内存
    // 敞开）。显式给 512MB 老生代上限防失控——宿主只跑扩展 IPC 与少量状态，512MB 足够；
    // 不带 --expose-gc：子进程不需要手动触发 GC，父进程的 GC 策略也不该被继承面放大。
    const execArgv = [...(extension === "ts" ? ["--import", "tsx"] : []), "--max-old-space-size=512"];
    this.child = fork(worker, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv, env: minimalChildEnv() });
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
      const initialized = await this.request("initialize", { states: this.states, manifests: this.manifests }) as { errors?: Record<string, string>; tools?: Record<string, ExtensionToolSpec[]>; hooks?: unknown };
      this.hostErrors = initialized.errors ?? {};
      this.replaceTools(initialized.tools);
      this.replaceHostHooks(initialized.hooks);
      this.hostRestartCount = 0;
      // 宿主重启（崩溃退避重启 / 安装扩展后的 restart）后重放 dsh 加载计划。
      await this.resyncDsh();
      this.events?.publish({ source: "server", type: "extension.host_started", payload: { extensions: this.list().length } });
    } catch (error) {
      this.handleHostFailure(child, asError(error));
      throw error;
    }
  }

  /** 宿主进程当前 RSS（字节）。无宿主/超时/失败 → null（仅性能面板展示用，不参与权限与恢复链路）。 */
  async hostMemory(): Promise<{ rss: number } | null> {
    if (!this.child?.connected) return null;
    try {
      return (await this.request("stats", undefined, 2000)) as { rss: number };
    } catch {
      return null;
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
    // host 断线：工具注册表、事件订阅与钩子集合全部失效（重启后由 initialize/activate 重建）。
    this.extensionTools.clear();
    this.eventSubscriptions.clear();
    this.hostHooks.clear();
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
