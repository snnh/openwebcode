/**
 * dsh 兼容层 · 宿主运行时（M2）
 *
 * 在 Extension Host 子进程内运行（`extension-host-process.ts` 在 dsh 启用时动态 import）：
 * 1. `module.register()` 安装 ESM 解析钩子，把插件代码里的 `@deepseek-ai/cordis` /
 *    `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 重定向到本目录的垫片；
 *    其它 `@deepseek-ai/*` 包一律抛错（翻译层未提供对应服务缝，如实报错而非静默降级）。
 *    插件自带的第三方依赖走 Node 默认解析（自带 node_modules 即可用），不做拦截。
 * 2. 建一个 root `Context`，提供 `tools` 服务与日志 sink。
 * 3. 逐个激活插件（`ctx.plugin(module, config)` + `fiber.await()`）：单插件 try/catch 隔离；
 *    依赖缺失（inject 的服务无人提供）保持 pending → status=missing-services；
 *    插件工具注册挂在插件 fiber 的 effect 上，任何原因导致 fiber 回滚都会摘除工具。
 * 4. 工具经伪扩展 id `dsh-<pluginId>` 上报宿主工具表（agent 侧 `ext__dsh-<pluginId>__<tool>`），
 *    执行链路 agent → 宿主 `tool.invoke` → 本模块（结果经 `output.render` 文本化）。
 *
 * 未覆盖（M4 按需补）：agent/compact/fs/shell 等服务缝、`presentCall`/`presentResult` 卡片、
 * client 入口（M4 的 `/plugins` 路由）。M3 已接入：llm/sessions/storage/timer/dshEvents
 * 服务缝（services.ts）与 tools/pre-execute、tools/post-execute agent 钩子桥。
 * 服务缝的 llm/sessions/storage 按插件绑定（`dsh-<插件id>` 来源 id），所以激活窗口之外的调用
 * （timer 回调、工具执行、事件 handler）仍落到调用方插件自己的隔离目录。
 */
import * as nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "./cordis-shim.js";
import type { Fiber, LoggerMessage, LoggerSink, Plugin } from "./cordis-shim.js";
import type { ToolDefinition, ToolRenderBlock } from "./dsh-tools-shim.js";
import type { DshHostCall } from "./services.js";
import { provideDshServices, pluginServiceViews, pluginTimerView, runDshPostExecute, runDshPreExecute } from "./services.js";
import type { DshPostToolOutcome, DshPreToolOutcome } from "./services.js";
import { dshToolSourceId, type DshPluginReport, type DshSyncItem } from "./loader.js";
import type { ExtensionToolResult, ExtensionToolSpec } from "../extensions/types.js";

/** 宿主工具表条目（handler 由 extension-host-process 的 tool.invoke 通道调用）。 */
interface DshToolEntry {
  spec: ExtensionToolSpec;
  handler: (input: Record<string, unknown>, config: Record<string, unknown>, sessionId?: string) => unknown | Promise<unknown>;
}

/** 插件在宿主侧的发布状态；state 传 undefined = 清空该伪扩展的工具与启用态。 */
interface DshHostState {
  enabled: boolean;
  config: Record<string, unknown>;
  tools: DshToolEntry[];
}

/** 宿主侧能力回调（由 extension-host-process 提供）。 */
export interface DshHostBridge {
  log(message: string): void;
  publish(sourceId: string, state: DshHostState | undefined): void;
  /** M3 服务缝：宿主能力调用（绑定到具体伪扩展 id → server dispatchApi）。 */
  call?: DshHostCall;
  /** M3 审计日志（ask 降级等）。 */
  audit?: (message: string) => void;
}

export interface DshHostRuntime {
  /** 同步加载计划：卸载不再需要的插件、激活新增/变更的插件，返回逐插件状态。 */
  sync(plugins: readonly DshSyncItem[]): Promise<DshPluginReport[]>;
  /** dsh 工具执行（宿主 tool.invoke 通道）。 */
  invoke(sourceId: string, tool: string, input: Record<string, unknown>, sessionId?: string): Promise<ExtensionToolResult>;
  /**
   * M3 agent 钩子桥：tools/pre-execute waterfall → owc beforeTool 语义。
   * 任一插件监听 tools/pre-execute 时按上游判别式取 deny/ask/cancel；无监听快速返回放行。
   */
  beforeTool(payload: { sessionId: string; cwd: string; tool: string; input: Record<string, unknown> }): Promise<DshPreToolOutcome>;
  /** M3：tools/post-execute waterfall → 结果变换（accept 替换内容 / block 转错误）。 */
  afterTool(payload: { sessionId: string; cwd: string; tool: string; input: Record<string, unknown> }, result: { content: string; isError?: boolean }): Promise<DshPostToolOutcome | undefined>;
  /** M3：把 server EventBus 白名单事件派发到订阅的插件 ctx（handler 抛错由宿主隔离）。 */
  dispatchEvent(sourceId: string, event: { type: string; sessionId?: string; payload: unknown }): void;
  /** 关闭：卸载全部插件并释放 root context。 */
  dispose(): Promise<void>;
}

/** 垫片重定向表（specifier → 同目录模块文件名）。 */
const DSH_SHIM_MODULES: Readonly<Record<string, string>> = {
  "@deepseek-ai/cordis": "cordis-shim",
  "@deepseek-ai/dsh-tools": "dsh-tools-shim",
  "@deepseek-ai/schemastery": "schemastery-shim",
};

/**
 * 解析钩子源码（在 hooks 线程内执行）：只做 specifier → URL 重写，不 import 任何模块。
 * 用 data: URL 注册，避免开发期（tsx）与发行版（dist）各需一份钩子文件。
 */
const SHIM_HOOK_SOURCE = `export function initialize(data) {
  globalThis.__owcDshShims = data.shims;
}
export function resolve(specifier, context, nextResolve) {
  const shims = globalThis.__owcDshShims;
  if (shims !== undefined && Object.prototype.hasOwnProperty.call(shims, specifier)) {
    return { url: shims[specifier], shortCircuit: true };
  }
  if (specifier.startsWith("@deepseek-ai/")) {
    throw new Error("dsh 兼容层未提供该包：" + specifier);
  }
  return nextResolve(specifier, context);
}
`;

let shimsInstalled = false;

/** 安装 ESM 垫片解析钩子（进程级一次；Node < 20.6 无 register() → 明确报错）。 */
function installDshShims(log: (message: string) => void): void {
  if (shimsInstalled) return;
  const register = nodeModule.register as typeof nodeModule.register | undefined;
  if (typeof register !== "function") {
    throw new Error("dsh 兼容模式需要 Node ≥ 20.6（node:module 的 register() 不可用）");
  }
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const shims: Record<string, string> = {};
  for (const [specifier, file] of Object.entries(DSH_SHIM_MODULES)) {
    shims[specifier] = new URL(`./${file}.${extension}`, import.meta.url).href;
  }
  register(`data:text/javascript;base64,${Buffer.from(SHIM_HOOK_SOURCE, "utf8").toString("base64")}`, import.meta.url, { data: { shims } });
  shimsInstalled = true;
  log(`垫片解析钩子已注册（${Object.keys(shims).join("、")}）`);
}

/**
 * 插件 ctx 派生：`get(name)` 命中宿主为插件绑定的视图时返回该插件专属实例（其余转发原 ctx）。
 *
 * 派生 ctx 与原 ctx 共享同一 fiber（服务归属与 effect 归属不变），所以插件经它注册的工具/定时器
 * 仍随插件卸载回滚。绑定内容是：`tools` façade + 各服务缝（llm/sessions/storage）的按插件实例——
 * 后者的意义是让激活窗口之外的调用（timer 回调、工具执行、事件 handler）仍带正确来源 id。
 */
function bindPluginContext(ctx: Context, views: ReadonlyMap<string, unknown>): Context {
  const bound = ctx.extend({});
  Object.defineProperty(bound, "get", {
    value: (name: string) => (views.has(name) ? views.get(name) : ctx.get(name)),
    configurable: true,
  });
  return bound;
}

/** 工具 schema 投影（对齐上游 guard.ts 沙箱 façade 的 schemas()/get() 形状）。 */
interface DshToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 插件侧工具注册面（上游 guard.ts 沙箱 façade 子集：register/unregister/schemas/get）。 */
interface DshToolsFacade {
  register(definition: ToolDefinition): () => void;
  unregister(name: string): void;
  schemas(): DshToolSchema[];
  get(name: string): DshToolSchema | undefined;
}

interface RegisteredDshTool {
  definition: ToolDefinition;
}

interface LoadedDshPlugin {
  key: string;
  item: DshSyncItem;
  fiber: Fiber;
}

/** 工具名须同时满足 dsh 约定与 owc 扩展工具命名空间正则（`ext__<id>__<name>`）。 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** 未声明超时预算时的宿主假定值（与服务端扩展工具 IPC 缺省超时一致）。 */
const DEFAULT_TOOL_BUDGET_MS = 5000;
/** 协作式预算相对服务端 IPC 超时的余量：先中止 signal，让工具能协作退出。 */
const TOOL_BUDGET_MARGIN_MS = 250;

function toolRegistryKey(sourceId: string, name: string): string {
  return `${sourceId}\u0000${name}`;
}

/** 加载计划项的变更键：目录 / 入口 / 配置任一变化即重载。 */
function pluginKey(item: DshSyncItem): string {
  return `${item.directory}\u0000${item.entry}\u0000${JSON.stringify(item.config)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 插件模块 → cordis 插件值（`{apply}` 对象 / 函数 / 类；含 CJS 互操作的 default 回落）。 */
function normalizeDshPlugin(namespace: Record<string, unknown>): Plugin | ((ctx: Context, config: unknown) => unknown) | undefined {
  if (typeof (namespace as { apply?: unknown }).apply === "function") return namespace as unknown as Plugin;
  const fallback = namespace.default;
  if (typeof fallback === "function") return fallback as (ctx: Context, config: unknown) => unknown;
  if (fallback && typeof fallback === "object" && typeof (fallback as { apply?: unknown }).apply === "function") return fallback as Plugin;
  return undefined;
}

/** 宿主强制的协作式超时预算（毫秒）。 */
function toolBudgetMs(definition: ToolDefinition): number {
  const declared = typeof definition.timeoutMs === "number" && Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0
    ? definition.timeoutMs
    : DEFAULT_TOOL_BUDGET_MS;
  return Math.max(500, Math.min(declared, 120_000) - TOOL_BUDGET_MARGIN_MS);
}

/** `output.render` 的块序列 → 模型可见文本（非文本块退化为其 JSON 形态）。 */
function renderBlocks(blocks: ToolRenderBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : safeJson(block)))
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 日志 sink：插件日志（ctx.logger 等）带 logger 名写宿主 stderr。 */
function logSink(log: (message: string) => void): LoggerSink {
  return {
    export(message: LoggerMessage) {
      const line = message.args
        .map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : typeof arg === "string" ? arg : safeJson(arg)))
        .join(" ");
      log(`[${message.name}] ${line}`);
    },
  };
}

class DshRuntime implements DshHostRuntime {
  private readonly root: Context;
  private readonly loaded = new Map<string, LoadedDshPlugin>();
  private readonly registry = new Map<string, RegisteredDshTool>();
  /** 插件 dshEvents 订阅（pluginId → 订阅集）；插件卸载/宿主关闭时统一解除。 */
  private readonly eventSubscriptions = new Map<string, Set<{ types: string[]; dispatch: (event: { type: string; sessionId?: string; payload: unknown }) => void }>>();
  /** 当前正在激活的插件 id（激活窗口内 dshEvents.subscribe 的归属判定）。 */
  private currentActivatingPluginId = "";
  /** dshEvents server 订阅是否已注册（首个插件激活后一次性注册；pull 失败逐事件空转）。 */
  private dshEventsRegistered = false;
  private disposed = false;

  constructor(private readonly bridge: DshHostBridge) {
    this.root = new Context({ logger: logSink((message) => this.bridge.log(message)) });
    // root 上的 tools 服务：插件经派生 ctx 拿到各自绑定的 façade；这里只用于解析 `inject: ['tools']`。
    this.root.provide("tools", this.createFacade(undefined));
    // M3 服务缝：llm/sessions/storage/timer/dshEvents（宿主提供能力调用时绑定；插件卸载不移除）。
    if (this.bridge.call) {
      provideDshServices(this.root, () => this.resolveCallSourceId(), {
        call: this.bridge.call,
        subscribeEvents: () => (types, dispatch) => this.subscribePluginEvents(types, dispatch),
        ...(this.bridge.audit ? { audit: this.bridge.audit } : {}),
      });
    }
  }

  /** 首个插件激活后注册 server 侧 EventBus 白名单订阅（pull 模型：server 按白名单推全量事件）。 */
  private ensureDshEventsRegistered(): void {
    if (this.dshEventsRegistered || !this.bridge.call) return;
    this.dshEventsRegistered = true;
    void this.bridge.call(this.resolveCallSourceId(), "events.subscribe", { types: ["agent.state", "tool.start", "tool.end", "context.", "checkpoint.", "subagent."] })
      .catch((error: unknown) => this.bridge.log(`dshEvents server 订阅注册失败：${errorMessage(error)}`));
  }

  /** 插件 dshEvents 订阅登记（归属当前激活插件）；返回解除订阅 disposer。 */
  private subscribePluginEvents(types: string[], dispatch: (event: { type: string; sessionId?: string; payload: unknown }) => void): () => void {
    this.ensureDshEventsRegistered();
    // 键口径与卸载/派发一致：都用伪扩展 id（`dsh-<pluginId>`），否则 unload 删错键 →
    // 订阅残留 + 重激活叠加 handler（同一事件被触发多次）
    const key = this.currentSubscriptionKey();
    const set = this.eventSubscriptions.get(key) ?? new Set();
    const entry = { types: [...types], dispatch };
    set.add(entry);
    this.eventSubscriptions.set(key, set);
    return () => set.delete(entry);
  }

  /** 当前激活插件对应的订阅键（伪扩展 id）；激活窗口外为空串（root 级订阅）。 */
  private currentSubscriptionKey(): string {
    return this.currentActivatingPluginId === "" ? "" : dshToolSourceId(this.currentActivatingPluginId);
  }

  async sync(plugins: readonly DshSyncItem[]): Promise<DshPluginReport[]> {
    if (this.disposed) throw new Error("dsh 宿主运行时已关闭");
    try {
      installDshShims((message) => this.bridge.log(message));
    } catch (error) {
      const message = errorMessage(error);
      return plugins.map((item) => ({ id: item.id, status: "error", error: message }));
    }
    const desired = new Map(plugins.map((item) => [item.id, item]));
    for (const [id, loaded] of [...this.loaded]) {
      const item = desired.get(id);
      if (item && pluginKey(item) === loaded.key) continue;
      await this.unload(id);
    }
    const reports: DshPluginReport[] = [];
    for (const item of plugins) {
      const loaded = this.loaded.get(item.id);
      const report = loaded ? this.reportFor(item, loaded.fiber) : await this.activate(item);
      this.publish(item, report);
      reports.push(report);
    }
    return reports;
  }

  async invoke(sourceId: string, tool: string, input: Record<string, unknown>, sessionId?: string): Promise<ExtensionToolResult> {
    const registered = this.registry.get(toolRegistryKey(sourceId, tool));
    if (!registered) throw new Error(`未知的 dsh 工具：${sourceId}/${tool}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), toolBudgetMs(registered.definition));
    try {
      const value = await registered.definition.execute(input, {
        signal: controller.signal,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return { content: this.renderResult(registered.definition, input, value) };
    } catch (error) {
      // 工具体抛错（含垫片抛出的 ToolArgsError(INVALID_ARGS)）→ isError，文案与上游一致。
      return { content: errorMessage(error), isError: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * root 级服务实例的来源 id（伪扩展 id）。
   *
   * 逐插件绑定后（见 bindPluginCtx），插件 ctx 上的 llm/sessions/storage 都是自己的实例，
   * 不再走这里；本函数只剩两条路径：激活窗口内 root 兜底、以及激活窗口外的 root 级调用
   * （此时取第一个已加载插件，仅为「有值可用」，插件代码不该走这条路径）。
   */
  private resolveCallSourceId(): string {
    if (this.currentActivatingPluginId) return dshToolSourceId(this.currentActivatingPluginId);
    const first = this.loaded.keys().next().value;
    return first !== undefined ? dshToolSourceId(first) : "";
  }

  async beforeTool(payload: { sessionId: string; cwd: string; tool: string; input: Record<string, unknown> }): Promise<DshPreToolOutcome> {
    try {
      return await runDshPreExecute(this.root, payload, this.bridge.audit);
    } catch (error) {
      // 钩子失败不阻断工具执行（与 owc beforeTool 失败降级一致），记审计日志。
      this.bridge.log(`dsh tools/pre-execute 执行失败：${errorMessage(error)}`);
      return { blocked: false };
    }
  }

  async afterTool(payload: { sessionId: string; cwd: string; tool: string; input: Record<string, unknown> }, result: { content: string; isError?: boolean }): Promise<DshPostToolOutcome | undefined> {
    try {
      return await runDshPostExecute(this.root, payload, result, this.bridge.audit);
    } catch (error) {
      // post-execute 失败只记录、不变换结果（计划：失败只记录不阻断）。
      this.bridge.log(`dsh tools/post-execute 执行失败：${errorMessage(error)}`);
      return undefined;
    }
  }

  /** server EventBus 白名单事件 → 订阅插件的 ctx（按当前激活插件过滤；handler 抛错隔离到本插件）。 */
  dispatchEvent(sourceId: string, event: { type: string; sessionId?: string; payload: unknown }): void {
    // sourceId 为伪扩展 id（dsh-<pluginId>），订阅表按键同口径（激活窗口内的 subscribe 已归一）
    const target = this.currentSubscriptionKey() || sourceId;
    const subscriptions = this.eventSubscriptions.get(target);
    if (!subscriptions) return;
    for (const subscription of [...subscriptions]) {
      if (!subscription.types.includes(event.type)) continue;
      try {
        subscription.dispatch(event);
      } catch (error) {
        this.bridge.log(`dsh 插件 ${target} 事件 handler 抛错：${errorMessage(error)}`);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const id of [...this.loaded.keys()]) await this.unload(id);
    this.disposed = true;
    await this.root.dispose();
  }

  /** 单插件激活（隔离 try/catch；失败时垫片已回滚该 fiber 的全部 effect）。 */
  private async activate(item: DshSyncItem): Promise<DshPluginReport> {
    const sourceId = dshToolSourceId(item.id);
    let namespace: Record<string, unknown>;
    try {
      namespace = await import(pathToFileURL(path.join(item.directory, item.entry)).href) as Record<string, unknown>;
    } catch (error) {
      return { id: item.id, status: "error", error: `加载插件入口失败：${errorMessage(error)}` };
    }
    const plugin = normalizeDshPlugin(namespace);
    if (!plugin) return { id: item.id, status: "error", error: "插件入口未导出 apply() 或默认插件函数/类" };
    let fiber: Fiber;
    this.currentActivatingPluginId = item.id;
    try {
      // prepare：插件 ctx 的 tools 与各服务缝指向本插件专属视图（注册归属插件 fiber + 卸载自动回滚）
      fiber = this.root.plugin(plugin, item.config, { prepare: (ctx) => this.bindPluginCtx(ctx, sourceId) });
      await fiber.await();
    } catch (error) {
      // effect 已由垫片回滚，但 fiber 仍登记在 root 的插件表里（依赖变化会自行重试、
      // 且与 this.loaded 记账不同步）：显式释放，避免反复 resync 时累积 + 依赖后来齐备时重复激活
      await fiber!.dispose().catch(() => undefined);
      return { id: item.id, status: "error", error: `插件激活失败：${errorMessage(error)}` };
    } finally {
      this.currentActivatingPluginId = "";
    }
    this.loaded.set(item.id, { key: pluginKey(item), item, fiber });
    return this.reportFor(item, fiber);
  }

  /** 插件 ctx 的服务视图绑定（tools façade + 服务缝按插件实例）。 */
  private bindPluginCtx(ctx: Context, sourceId: string): Context {
    const views = new Map<string, unknown>();
    views.set("tools", this.createFacade(sourceId, ctx));
    // timer 必须绑到插件 fiber：root 实例的定时器挂在 root 上，插件卸载后不会停
    views.set("timer", pluginTimerView(ctx));
    const call = this.bridge.call;
    if (call !== undefined) {
      for (const [name, view] of Object.entries(pluginServiceViews(sourceId, call))) views.set(name, view);
    }
    return bindPluginContext(ctx, views);
  }

  private async unload(id: string): Promise<void> {
    const loaded = this.loaded.get(id);
    if (!loaded) return;
    this.loaded.delete(id);
    const sourceId = dshToolSourceId(id);
    try {
      // fiber 回滚会摘除该插件注册的全部工具（注册时挂在插件 fiber 的 effect 上）。
      await loaded.fiber.dispose();
    } catch (error) {
      this.bridge.log(`卸载插件 ${id} 失败：${errorMessage(error)}`);
    }
    this.purgeTools(sourceId);
    this.eventSubscriptions.delete(sourceId);
    this.bridge.publish(sourceId, undefined);
  }

  /** 兜底摘除：fiber 回滚异常等未清干净时按 sourceId 全清。 */
  private purgeTools(sourceId: string): void {
    for (const key of [...this.registry.keys()]) {
      if (key.startsWith(`${sourceId}\u0000`)) this.registry.delete(key);
    }
  }

  /** 由 fiber 状态推导回报（每次同步现算，不缓存过期状态）。 */
  private reportFor(item: DshSyncItem, fiber: Fiber): DshPluginReport {
    const sourceId = dshToolSourceId(item.id);
    if (fiber.state === "pending") {
      return {
        id: item.id,
        status: "missing-services",
        missing: Object.keys(fiber.inject).filter((name) => this.root.get(name) === undefined),
      };
    }
    if (fiber.state !== "active") {
      return { id: item.id, status: "error", error: `插件未激活（fiber 状态：${fiber.state}）` };
    }
    return { id: item.id, status: "running", tools: this.toolNames(sourceId) };
  }

  /**
   * tools 服务 façade。
   * sourceId 为 undefined = root 上的只读版本（`inject: ['tools']` 解析用；注册须经插件 ctx）。
   * ctx 非空时注册挂在插件 fiber 的 effect 上，返回值即上游语义的「反注册 disposer」。
   */
  private createFacade(sourceId: string | undefined, ctx?: Context): DshToolsFacade {
    const own = (): RegisteredDshTool[] =>
      sourceId === undefined ? [] : [...this.registry.entries()].filter(([key]) => key.startsWith(`${sourceId}\u0000`)).map(([, value]) => value);
    const lookup = (name: string): RegisteredDshTool | undefined =>
      sourceId === undefined ? undefined : this.registry.get(toolRegistryKey(sourceId, name));
    return {
      register: (definition: ToolDefinition): (() => void) => {
        if (sourceId === undefined || ctx === undefined) {
          throw new Error("dsh 兼容层：ctx.tools.register() 只能经插件 ctx 调用");
        }
        const name = definition?.name;
        if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
          throw new Error(`dsh 工具名不合法：${String(name ?? "")}（需匹配 [a-zA-Z0-9_-]{1,64}）`);
        }
        const key = toolRegistryKey(sourceId, name);
        if (this.registry.has(key)) throw new Error(`dsh 工具已注册：${name}`);
        const effect = ctx.effect(() => {
          this.registry.set(key, { definition });
          this.publishLoaded(sourceId);
          return () => {
            this.registry.delete(key);
            this.publishLoaded(sourceId);
          };
        }, `tools.register(${name})`);
        return () => void effect();
      },
      unregister: (name: string): void => {
        if (sourceId === undefined) return;
        if (this.registry.delete(toolRegistryKey(sourceId, name))) this.publishLoaded(sourceId);
      },
      schemas: () => own().map((entry) => this.schemaOf(entry.definition)),
      get: (name: string) => {
        const entry = lookup(name);
        return entry ? this.schemaOf(entry.definition) : undefined;
      },
    };
  }

  private schemaOf(definition: ToolDefinition): DshToolSchema {
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as Record<string, unknown>,
    };
  }

  private toolNames(sourceId: string): string[] {
    return [...this.registry.keys()]
      .filter((key) => key.startsWith(`${sourceId}\u0000`))
      .map((key) => key.slice(sourceId.length + 1))
      .sort();
  }

  private renderResult(definition: ToolDefinition, input: Record<string, unknown>, value: unknown): string {
    try {
      const blocks = definition.output.render(input, value);
      // 空块序列是合法的「无内容」结果（渲染回调抛错/形状非法才回落 JSON，避免丢工具输出）。
      if (Array.isArray(blocks)) return renderBlocks(blocks);
    } catch (error) {
      this.bridge.log(`工具 ${definition.name} 的 output.render 抛错：${errorMessage(error)}`);
    }
    return value === undefined ? "" : safeJson(value);
  }

  /** 同步末尾按状态发布：非 running 时 enabled=false（服务端 invokeTool 直接拒绝）。 */
  private publish(item: DshSyncItem, report: DshPluginReport): void {
    const sourceId = dshToolSourceId(item.id);
    this.bridge.publish(sourceId, {
      enabled: report.status === "running",
      config: item.config,
      tools: report.status === "running" ? this.toolEntries(sourceId) : [],
    });
  }

  /** 运行期工具表变更（插件自行注册/注销）后的重发。 */
  private publishLoaded(sourceId: string): void {
    const loaded = [...this.loaded.values()].find((entry) => dshToolSourceId(entry.item.id) === sourceId);
    if (!loaded) return; // 激活期间：本轮 sync 结束时会统一发布
    const entries = [...this.registry.keys()].filter((key) => key.startsWith(`${sourceId}\u0000`));
    this.bridge.publish(sourceId, { enabled: true, config: loaded.item.config, tools: entries.map((key) => this.toolEntriesFor(key)) });
  }

  private toolEntries(sourceId: string): DshToolEntry[] {
    return [...this.registry.keys()]
      .filter((key) => key.startsWith(`${sourceId}\u0000`))
      .map((key) => this.toolEntriesFor(key));
  }

  private toolEntriesFor(key: string): DshToolEntry {
    const registered = this.registry.get(key)!;
    const sourceId = key.slice(0, key.indexOf("\u0000"));
    const name = registered.definition.name;
    return {
      spec: this.specOf(registered.definition),
      handler: (input: Record<string, unknown>, _config: Record<string, unknown>, sessionId?: string) =>
        this.invoke(sourceId, name, input, sessionId),
    };
  }

  private specOf(definition: ToolDefinition): ExtensionToolSpec {
    return {
      name: definition.name,
      description: definition.description || definition.name,
      inputSchema: definition.parameters as Record<string, unknown>,
      ...(typeof definition.timeoutMs === "number" && Number.isFinite(definition.timeoutMs) ? { timeoutMs: definition.timeoutMs } : {}),
    };
  }
}

/** 创建宿主运行时（Extension Host 子进程内单实例）。 */
export function createDshHostRuntime(bridge: DshHostBridge): DshHostRuntime {
  return new DshRuntime(bridge);
}
