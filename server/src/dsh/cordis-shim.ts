/**
 * dsh 兼容层 · cordis 垫片（M1）
 *
 * 对 `@deepseek-ai/cordis`（上游 vendor/cordis，Koishi cordis 4.0.2 fork）的子集复刻，
 * 供 dsh 插件经 ESM 垫片 import 使用（M2 由 module.register() 解析钩子重定向）。
 *
 * 语义对齐钉版 0d1f50007f：
 * - 插件三形态：函数 / 类 / `{ apply }` 对象（含模块级 named exports `name`/`inject`/`Config`）；
 * - `inject` 硬依赖：缺失时 fiber 保持 pending 不激活；服务 provide/remove 触发重算；
 * - 事件：`emit`（同步不等待）/ `parallel`（全并发，失败聚合为 AggregateError）/ `serial`
 *   （依序 await 至首个 bail）/ `bail`（同步版 serial）/ `waterfall`（最后一参为内层 next，
 *   不调用即否决后续链与内建行为）；bail 判定 = 返回值非 null/false/undefined（isBailed）；
 * - `ctx.effect(execute, label?)`：execute 立即执行，产出的 disposer（函数 / Promise /
 *   同步或异步迭代器）在 effect 自身释放或所属 fiber 卸载时逆序回滚；已卸载 fiber 上
 *   注册抛 INACTIVE_EFFECT（CordisError）；
 * - `ctx.provide/get/set`：provide 归属当前 fiber（卸载自动移除并唤醒等待者）；set 仅限
 *   本 fiber 提供的服务；属性读取未命中返回 undefined（与上游非严格读取一致）；
 * - `Config`：Standard Schema V1 同步校验（schemastery 垫片已实现 `~standard`），
 *   异步校验拒绝（上游同款 TypeError）。
 *
 * 未覆盖（fail loud 或直接缺失）：isolate/intercept/accessor/mixin、`@Inject` 装饰器、
 * HMR（internal/update 瀑布）、`fiber.update/restart`、跨 isolate 作用域、
 * `Service.invoke` 可调用实例、`internal/*` 核心事件的拦截语义、
 * `ctx.reflect`/`ctx.registry` 子服务（属性读取返回 undefined）与 cordis timer 服务
 * （timeout/interval/throttle/debounce，M3 按需补）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-namespace -- 垫片忠实复刻上游 cordis 的宽松类型面（any/Function/namespace 均为上游公开 API 形态），逐行 disable 会淹没移植代码的可读性 */

/** 可逆效果的清理函数。 */
export type Disposable = () => unknown;
/** effect 体允许的返回形态（函数 / Promise / 同步或异步迭代器 / 空值）。 */
export type Effect = Disposable | Promise<Disposable> | Iterable<Disposable> | AsyncIterable<Disposable> | void | null | undefined;

/** 事件监听选项（boolean 为 prepend 简写，对齐上游）。 */
export interface EventOptions {
  prepend?: boolean;
  global?: boolean;
}

export interface Hook extends EventOptions {
  ctx: Context;
  callback: (...args: any[]) => any;
}

export type DispatchMode = "emit" | "parallel" | "serial" | "bail" | "waterfall";

/** 与上游一致的 fiber 生命周期状态。 */
export type FiberState = "pending" | "loading" | "active" | "unloading" | "failed" | "disposed";

/** 上游 symbols 的最小复刻（Symbol.for 保证跨副本可用）。 */
export const symbols = {
  effect: Symbol.for("cordis.effect"),
  filter: Symbol.for("cordis.filter"),
  isolate: Symbol.for("cordis.isolate"),
  intercept: Symbol.for("cordis.intercept"),
  init: Symbol.for("cordis.init"),
  check: Symbol.for("cordis.check"),
  config: Symbol.for("cordis.config"),
  invoke: Symbol.for("cordis.invoke"),
} as const;

/** 返回值非 null/false/undefined 即 bail（上游同款判定）。 */
export function isBailed(value: unknown): boolean {
  return value !== null && value !== false && value !== undefined;
}

/** 上游 CordisError（INACTIVE_EFFECT、config 校验失败等框架错误）。 */
export class CordisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CordisError";
  }
}

/** Standard Schema V1 最小接口（schemastery 垫片的 `~standard` 即此形态）。 */
export interface StandardSchemaV1 {
  readonly "~standard": {
    readonly version: 1;
    validate: (value: unknown) => { value: unknown } | { issues: { message: string }[] } | PromiseLike<unknown>;
  };
}

/** 插件入口形态（函数 / 类 / 对象；模块命名导出即对象形态）。 */
export interface Plugin<T = any> {
  name?: string;
  Config?: StandardSchemaV1;
  inject?: string[] | Record<string, unknown>;
  apply?: (ctx: Context, config: T) => any;
}

interface PluginRuntime {
  name?: string | undefined;
  callback: Function;
  Config?: StandardSchemaV1 | undefined;
  fibers: Set<Fiber>;
}

interface ServiceImpl {
  name: string;
  value: unknown;
  /** null = 内建服务（不随任何插件卸载）。 */
  fiber: Fiber | null;
}

/** 与上游一致的 effect 错误文案。 */
const INACTIVE_EFFECT = "cannot create effect on inactive context";

function isApplicable(object: unknown): object is { apply: (ctx: Context, config: any) => any } {
  return typeof object === "object" && object !== null && typeof (object as any).apply === "function";
}

/** 类/构造函数判定：async/箭头/绑定函数无 prototype，排除之（近似上游 isConstructor）。 */
function isConstructor(value: unknown): value is new (...args: any[]) => any {
  if (typeof value !== "function") return false;
  const proto = (value as { prototype?: unknown }).prototype;
  if (!proto || typeof proto !== "object") return false;
  return (proto as { constructor?: unknown }).constructor === value;
}

/** effect 体返回形态 → disposer 收集（对齐上游 _execute 的五种形态）。 */
function materializeEffect(result: Effect, collect: (dispose: Disposable) => void): void | Promise<void> {
  if (typeof result === "function") {
    collect(result);
    return;
  }
  if (result === null || result === undefined) return;
  if (typeof (result as Promise<Disposable>).then === "function") {
    return (result as Promise<Disposable>).then(dispose => {
      if (typeof dispose === "function") collect(dispose);
      else if (dispose !== null && dispose !== undefined) throw new TypeError("Invalid effect");
    });
  }
  if (Symbol.iterator in (result as object)) {
    for (const dispose of result as Iterable<Disposable>) {
      if (typeof dispose !== "function") throw new TypeError("Invalid effect");
      collect(dispose);
    }
    return;
  }
  if (Symbol.asyncIterator in (result as object)) {
    return (async () => {
      for await (const dispose of result as AsyncIterable<Disposable>) {
        if (typeof dispose !== "function") throw new TypeError("Invalid effect");
        collect(dispose);
      }
    })();
  }
  throw new TypeError("Invalid effect");
}

// ---------------------------------------------------------------------------
// 日志服务（上游 LoggerService 门面子集）
// ---------------------------------------------------------------------------

export interface LoggerMessage {
  sn: number;
  ts: number;
  type: string;
  level: number;
  name: string;
  args: unknown[];
}

export interface LoggerSink {
  export(message: LoggerMessage): void;
  /** 按	logger 名（或 default）覆盖输出等级，低于等级的消息不输出。 */
  levels?: Record<string, number>;
}

export const LoggerLevel = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 } as const;

export type LoggerMethod = (...args: any[]) => void;

export interface Logger {
  debug: LoggerMethod;
  info: LoggerMethod;
  success: LoggerMethod;
  warn: LoggerMethod;
  error: LoggerMethod;
}

/** 可调用 logger：`ctx.logger()` 取命名实例，`ctx.logger.info(...)` 直接输出。 */
export type LoggerService = ((name?: string) => Logger) & Logger;

const consoleSink: LoggerSink = {
  export(message) {
    const line = message.args.map(arg => (arg instanceof Error ? arg.stack ?? arg.message : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    if (message.level >= LoggerLevel.ERROR) console.error(`[cordis:${message.name}] ${line}`);
    else console.log(`[cordis:${message.name}] ${line}`);
  },
};

export function createLogger(name: string, sink: LoggerSink = consoleSink): LoggerService {
  const method = (level: number, type: string): LoggerMethod => (...args: any[]) => {
    const targetLevel = sink.levels?.[name] ?? sink.levels?.default ?? LoggerLevel.INFO;
    if (level < targetLevel) return;
    sink.export({ sn: ++snCounter, ts: Date.now(), type, level, name, args });
  };
  const self = ((name2?: string) => createLogger(name2 ?? name, sink)) as unknown as LoggerService;
  self.debug = method(LoggerLevel.DEBUG, "debug");
  self.info = method(LoggerLevel.INFO, "info");
  self.success = method(LoggerLevel.INFO, "success");
  self.warn = method(LoggerLevel.WARN, "warn");
  self.error = method(LoggerLevel.ERROR, "error");
  return self;
}

let snCounter = 0;

// ---------------------------------------------------------------------------
// 事件服务
// ---------------------------------------------------------------------------

/** 事件总线：hooks 存储与五种派发模式。监听器登记入口在 Context.on（挂调用方 fiber）。 */
export class EventService {
  _hooks: Map<string, Hook[]> = new Map();

  /** 取（或建）某事件的监听器列表（供 Context.on 登记使用）。 */
  hooksFor(name: string): Hook[] {
    let hooks = this._hooks.get(name);
    if (!hooks) {
      hooks = [];
      this._hooks.set(name, hooks);
    }
    return hooks;
  }

  /** 解析一次派发的监听器：支持前置 thisArg（对象/函数即移位），对齐上游 dispatch。 */
  dispatch(type: string, args: any[]): Function[] {
    const thisArg: unknown = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
    const name: string = args.shift();
    void type; // 子集：internal/dispatch 诊断事件未支持
    return (this._hooks.get(name) ?? []).map(hook => hook.callback.bind(thisArg));
  }

  emit(...args: any[]) {
    for (const callback of this.dispatch("emit", args)) callback(...args);
  }

  async parallel(...args: any[]) {
    const results = await Promise.allSettled(this.dispatch("emit", args).map(async callback => callback(...args)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(error => error.reason));
  }

  async serial(...args: any[]) {
    for (const callback of this.dispatch("serial", args)) {
      const result = await callback(...args);
      if (isBailed(result)) return result;
    }
  }

  bail(...args: any[]) {
    for (const callback of this.dispatch("bail", args)) {
      const result = callback(...args);
      if (isBailed(result)) return result;
    }
  }

  waterfall(...args: any[]) {
    const callbacks = this.dispatch("waterfall", args);
    const inner = args.pop();
    const next = () => {
      const callback = callbacks.shift() ?? inner;
      return callback(...args);
    };
    args.push(next);
    return next();
  }
}

// ---------------------------------------------------------------------------
// Fiber
// ---------------------------------------------------------------------------

let fiberCounter = 0;

/** root → 插件 fiber 注册表（服务变更时全量 refresh，O(n) 但 n 为插件数，可接受）。 */
const fibersByRoot = new WeakMap<Context, Set<Fiber>>();

function registerFiber(root: Context, fiber: Fiber) {
  let set = fibersByRoot.get(root);
  if (!set) {
    set = new Set();
    fibersByRoot.set(root, set);
  }
  set.add(fiber);
}

function unregisterFiber(root: Context, fiber: Fiber) {
  fibersByRoot.get(root)?.delete(fiber);
}

/**
 * 服务变更后唤醒依赖重算（上游 reflect.notify 子集）：
 * 给定服务名时只唤醒 inject 该名字的 fiber，返回被唤醒者供卸载路径 await。
 */
function notifyDependents(root: Context, name?: string): Fiber[] {
  const fibers = fibersByRoot.get(root);
  if (!fibers) return [];
  const woken: Fiber[] = [];
  for (const fiber of [...fibers]) {
    if (name !== undefined && !(name in fiber.inject)) continue;
    fiber.refresh();
    woken.push(fiber);
  }
  return woken;
}

/**
 * 插件生命周期载体（上游 Fiber 子集）：
 * 依赖齐备 → 校验 Config → 执行插件体并收集 effect；依赖缺失/卸载 → 逆序回滚。
 * 状态迁移收敛在单个异步循环里，refresh 只更新目标 epoch 并确保循环在跑。
 */
export class Fiber {
  uid: number | null;
  readonly ctx: Context;
  readonly parent: Context;
  /** 已校验的插件配置（激活时更新，上游 fiber.config）。 */
  config: any;
  /** 原始配置（每次激活前重新校验，上游 fiber._config）。 */
  private readonly _config: any;
  state: FiberState = "pending";
  /** 激活期间依赖实现的快照（上游 fiber.store）。 */
  store: Record<string, ServiceImpl> | undefined;
  readonly dispose: () => Promise<void>;
  private disposables: Disposable[] = [];
  private disposing = false;
  private _error: unknown;
  private epoch: string | false = false;
  private inertia: Promise<void> | undefined;
  private disposed = false;
  private readonly runtime: PluginRuntime | null;
  private readonly isRoot: boolean;
  /** 声明的依赖表（名称 → 注记）；服务变更时按此判定是否唤醒本 fiber。 */
  readonly inject: Record<string, unknown>;
  private readonly effectLabels = new Set<string>();

  constructor(parent: Context, config: any, inject: Record<string, unknown>, runtime: PluginRuntime | null) {
    this.parent = parent;
    this.runtime = runtime;
    this.inject = inject;
    this._config = config;
    this.isRoot = runtime === null;
    this.uid = this.isRoot ? 0 : ++fiberCounter;
    this.ctx = parent.extend({ fiber: this });

    if (this.isRoot) {
      this.dispose = () => this.unloadAll();
    } else {
      const runtimeRef = runtime!;
      this.dispose = this.parent.fiber.effect(() => {
        runtimeRef.fibers.add(this);
        registerFiber(this.parent.root, this);
        return async () => {
          this.disposed = true;
          this.uid = null;
          runtimeRef.fibers.delete(this);
          unregisterFiber(this.parent.root, this);
          this.epoch = false;
          while (this.inertia) await this.inertia;
          this.state = "disposed";
          await this.unloadDisposables();
        };
      }, `plugin(${runtimeRef.name ?? "anonymous"})`) as () => Promise<void>;
    }
    this.refresh();
  }

  assertActive() {
    if (this.uid !== null) return;
    throw new CordisError(INACTIVE_EFFECT);
  }

  /**
   * 在当前 fiber 上登记可逆 effect：立即执行；返回的 disposer 触发本 effect 的
   * 逆序回滚（幂等，可 await）；fiber 卸载时同样回滚。
   */
  effect(execute: () => Effect, label = "anonymous"): Disposable & PromiseLike<() => unknown> {
    this.assertActive();
    if (this.state === "unloading" || this.disposed) throw new CordisError(INACTIVE_EFFECT);

    const collected: Disposable[] = [];
    let releasing = false;
    const release = (): unknown => {
      if (releasing) return false; // 幂等：重复释放返回「已不存活」
      releasing = true;
      this.effectLabels.delete(label);
      let task: unknown;
      for (const entry of collected.reverse()) {
        if (task && typeof (task as PromiseLike<unknown>).then === "function") {
          task = (task as PromiseLike<unknown>).then(() => entry());
        } else {
          task = entry();
        }
      }
      collected.length = 0;
      return task;
    };
    const meta = { label };
    Object.defineProperty(release, symbols.effect, { value: meta });

    const wrapper = (() => release()) as Disposable & PromiseLike<() => unknown>;
    wrapper.then = (onFulfilled: any, onRejected: any) =>
      Promise.resolve().then(() => release()).then(onFulfilled, onRejected);

    this.disposables.push(wrapper);
    this.effectLabels.add(label);
    try {
      materializeEffect(execute(), entry => collected.push(entry));
    } catch (reason) {
      // 同步 setup 失败：先回滚已收集的 disposer，再原样上抛（上游 setupFailed 语义）。
      release();
      throw reason;
    }
    return wrapper;
  }

  /** 等待当前迁移完成；启动错误 settle 时上抛（上游 await 语义）。 */
  async await(): Promise<Fiber> {
    while (this.inertia) {
      await this.inertia;
    }
    if (this._error) throw this._error;
    return this;
  }

  /** 依赖重算：依赖齐备（epoch 为提供者 uid 串）→ 激活；缺失（false）→ 卸载。 */
  refresh() {
    if (this.disposed) return;
    let epoch: string | false;
    if (this.isRoot) {
      epoch = "root";
    } else {
      epoch = "";
      for (const name of Object.keys(this.inject)) {
        const impl = this.lookupImpl(name);
        if (!impl) {
          epoch = false;
          break;
        }
        epoch += `:${impl.fiber?.uid ?? "?"}`;
      }
    }
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    this.scheduleTransition();
  }

  /** 依赖实现查找：仅取「提供 fiber 处于 active」的实现（上游 strict 语义）。 */
  private lookupImpl(name: string): ServiceImpl | undefined {
    const impl = this.parent.serviceStore.get(name);
    if (!impl) return undefined;
    if (impl.fiber && impl.fiber.state !== "active") return undefined;
    return impl;
  }

  private scheduleTransition() {
    if (this.inertia) return; // 迁移循环每轮读取最新 epoch，无需重入
    this.inertia = this.transitionLoop();
  }

  /** epoch 是否已被并发 refresh 改写（方法内读取，避开属性收窄误报）。 */
  private epochChanged(target: string | false): boolean {
    return (this.epoch as string | false) !== target;
  }

  private async transitionLoop() {
    try {
      while (true) {
        const target = this.epoch;
        if (target === false) {
          if (this.disposables.length > 0) {
            this.state = "unloading";
            await this.unloadDisposables();
            // 本 fiber 提供的服务已随回滚移除，唤醒等待者重算依赖。
            notifyDependents(this.parent.root);
          }
          if (this.epochChanged(target)) continue;
          if (!this.disposed) this.state = this._error ? "failed" : "pending";
          return;
        }
        if (this.isRoot) {
          this.state = "active";
          return;
        }
        this.state = "loading";
        await Promise.resolve(); // 上游同款 checkpoint：让卸载竞态先落地
        if (this.epochChanged(target)) continue;
        const snapshot: Record<string, ServiceImpl> = {};
        for (const name of Object.keys(this.inject)) {
          const impl = this.lookupImpl(name);
          if (!impl) break; // 竞态：依赖又被移除，下一轮按 epoch 走卸载
          snapshot[name] = impl;
        }
        if (this.epochChanged(target)) continue;
        try {
          this.store = snapshot;
          this.config = this.resolveConfig();
          this.runPlugin();
          if (this.epochChanged(target)) continue;
          this._error = undefined;
          this.state = "active";
          // 提供者在 apply 期间注册的服务此刻才对等待者可见，唤醒其重算。
          notifyDependents(this.parent.root);
          return;
        } catch (reason) {
          this.ctx.logger.error(reason);
          this._error = reason;
          this.epoch = false;
          this.state = "failed";
          await this.unloadDisposables();
          notifyDependents(this.parent.root);
          if (this.epochChanged(target)) continue;
          return;
        }
      }
    } finally {
      this.inertia = undefined;
    }
  }

  private resolveConfig() {
    const schema = this.runtime?.Config;
    if (!schema) return this._config;
    const result = schema["~standard"].validate(this._config);
    if (typeof (result as PromiseLike<unknown>).then === "function") {
      throw new TypeError("Async config validation is not supported");
    }
    if ("issues" in result) {
      const messages = result.issues.map(issue => issue.message).join("; ");
      throw new CordisError(`config validation failed: ${messages}`);
    }
    return (result as { value: unknown }).value;
  }

  private runPlugin() {
    const callback = this.runtime!.callback;
    const collect = (entry: Disposable) => this.disposables.push(entry);
    if (isConstructor(callback)) {
      // 类插件：构造后执行 [Service.init] 钩子，其返回值作为 effect（上游同款）。
      const instance = new callback(this.ctx, this.config);
      const init = (instance as any)?.[symbols.init];
      materializeEffect(typeof init === "function" ? init.call(instance) : undefined, collect);
    } else {
      materializeEffect(callback(this.ctx, this.config), collect);
    }
  }

  /** fiber 卸载：逆序回滚全部 effect（错误进 logger，不阻断后续回滚）。 */
  private async unloadDisposables() {
    if (this.disposing) return;
    this.disposing = true;
    const entries = this.disposables.reverse();
    this.disposables = [];
    for (const dispose of entries) {
      try {
        await Promise.resolve(dispose());
      } catch (reason) {
        this.ctx.logger.error(reason);
      }
    }
    this.disposing = false;
  }

  private async unloadAll() {
    // root 卸载：全部插件 fiber 的 dispose 都挂在 root fiber 上，统一逆序回滚。
    this.disposed = true;
    this.uid = null;
    this.state = "disposed";
    await this.unloadDisposables();
    this.state = "disposed";
  }

  /** 诊断：当前存活的 effect 标签。 */
  getEffects(): string[] {
    return [...this.effectLabels];
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ContextOptions {
  /** 日志 sink（M3 接 extension host stderr；默认 console）。 */
  logger?: LoggerSink;
}

/**
 * 依赖容器。root 与插件 fiber 的 ctx 都是 Proxy：
 * 属性读取走服务仓库（未命中返回 undefined），写入仅限本 fiber 提供的服务。
 */
export class Context {
  static readonly effect: symbol = symbols.effect;
  static readonly filter: symbol = symbols.filter;
  static readonly isolate: symbol = symbols.isolate;
  static readonly intercept: symbol = symbols.intercept;

  /** root context（插件 ctx 沿原型链共享）。 */
  root!: Context;
  /** 当前 context 归属的 fiber（插件 ctx 为插件 fiber，root 为 root fiber）。 */
  fiber!: Fiber;
  /** 事件总线（hooks 由全部 context 共享）。 */
  readonly events: EventService;
  /** 内建日志服务（经服务仓库读取，get logger 即 ctx.logger）。 */
  get logger(): LoggerService {
    return this.get("logger") as LoggerService;
  }
  /** 服务仓库（root 与其子 context 共享同一张表）。 */
  readonly serviceStore: Map<string, ServiceImpl>;

  /** 跨副本可靠的 context 判定（上游 Context.is 语义，经品牌 Symbol 实现）。 */
  static is(value: any): value is Context {
    return !!value?.[Context.is as any];
  }

  constructor(options: ContextOptions = {}) {
    this.serviceStore = new Map();
    this.events = new EventService();
    const proxied = new Proxy(this, contextHandler) as Context;
    this.root = proxied;
    this.fiber = new Fiber(proxied, undefined, Object.create(null), null);
    // 内建 logger 服务：不归属任何插件 fiber（fiber=null，不随插件卸载）。
    this.serviceStore.set("logger", {
      name: "logger",
      value: createLogger("app", options.logger),
      fiber: null,
    });
    return proxied;
  }

  /** 子 context：继承服务与事件，meta 自有属性遮蔽（上游 extend 子集）。 */
  extend(meta: Record<string | symbol, unknown> = {}): Context {
    const child = Object.create(null) as Context;
    Object.setPrototypeOf(child, Context.prototype);
    (child as any).serviceStore = this.serviceStore;
    (child as any).events = this.events;
    (child as any).root = this.root;
    (child as any).fiber = this.fiber;
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(child, prop, Object.getOwnPropertyDescriptor(meta, prop)!);
    }
    return new Proxy(child, contextHandler) as Context;
  }

  /** 读取服务（未命中或提供者未激活返回 undefined，不抛错）。 */
  get(name: string): any {
    const impl = this.serviceStore.get(name);
    if (!impl) return undefined;
    if (impl.fiber && impl.fiber.state !== "active") return undefined;
    return impl.value;
  }

  /**
   * 注册服务实现，归属当前 fiber（卸载自动移除并唤醒等待者）。
   * 上游 reflect.provide 语义：disposer 等依赖者卸载完成后再结束。
   */
  provide(name: string, value?: unknown, check?: () => boolean): () => void {
    void check; // 子集：可用性谓词未支持
    const fiber = this.fiber;
    fiber.assertActive();
    if (this.serviceStore.has(name)) {
      throw new Error(`service "${name}" has been registered`);
    }
    // 归属当前 fiber 的可逆 effect：fiber 卸载时服务随之移除（上游 reflect.provide 语义）。
    return this.fiber.effect(() => {
      const impl: ServiceImpl = { name, value, fiber };
      this.serviceStore.set(name, impl);
      notifyDependents(this.root, name);
      return () => {
        if (this.serviceStore.get(name) !== impl) return;
        this.serviceStore.delete(name);
        const dependents = notifyDependents(this.root, name);
        return Promise.allSettled(dependents.map(dependent => dependent.await()));
      };
    }, `provide(${name})`) as () => void;
  }

  /** 覆写本 fiber 提供的服务值（上游 set 语义）。 */
  set(name: string, value: unknown) {
    const impl = this.serviceStore.get(name);
    if (!impl) throw new Error(`cannot set property "${name}" without provide`);
    if (impl.fiber !== this.fiber) throw new Error(`cannot set property "${name}" in multiple fibers`);
    impl.value = value;
  }

  /** 在当前 fiber 上登记事件监听器（fiber 卸载自动移除），返回 `() => boolean` 型 disposer。 */
  on(name: string, listener: (...args: any) => any, options?: boolean | EventOptions): () => boolean {
    this.fiber.assertActive();
    const hooks = this.events.hooksFor(name);
    const prepend = typeof options === "object" && options !== null ? options.prepend === true : options === true;
    const global = typeof options === "object" && options !== null ? options.global === true : false;
    const method = prepend ? "unshift" : "push";
    return this.fiber.effect(() => {
      const hook: Hook = { ctx: this, callback: listener };
      if (prepend) hook.prepend = true;
      if (global) hook.global = true;
      hooks[method](hook);
      return () => {
        const index = hooks.indexOf(hook);
        if (index >= 0) {
          hooks.splice(index, 1);
          return true;
        }
        return false;
      };
    }, `ctx.on(${JSON.stringify(name)})`) as () => boolean;
  }

  /** 一次性监听（首次派发后自移除）。 */
  once(name: string, listener: (...args: any) => any, options?: boolean | EventOptions): () => boolean {
    const dispose = this.on(name, function (this: unknown, ...args: any[]) {
      dispose();
      return listener.apply(this, args);
    }, options);
    return dispose;
  }

  emit(...args: any[]) {
    this.events.emit(...args);
  }

  parallel(...args: any[]): Promise<void> {
    return this.events.parallel(...args);
  }

  serial(...args: any[]): Promise<unknown> {
    return this.events.serial(...args);
  }

  bail(...args: any[]): unknown {
    return this.events.bail(...args);
  }

  waterfall(...args: any[]): unknown {
    return this.events.waterfall(...args);
  }

  /** 声明依赖并加载回调插件（上游 ctx.inject 简写）。 */
  inject(deps: string[] | Record<string, unknown>, callback: (ctx: Context, config: any) => any): Fiber & PromiseLike<Fiber> {
    return this.plugin({ inject: deps, apply: callback, name: callback.name } as Plugin, undefined);
  }

  /** 加载插件（函数 / 类 / `{apply}` 对象），返回可 await 的 fiber。 */
  plugin(pluginValue: Plugin | Function, config?: any): Fiber & PromiseLike<Fiber> {
    let callback: Function | undefined;
    if (typeof pluginValue === "function") callback = pluginValue as Function;
    else if (isApplicable(pluginValue)) callback = pluginValue.apply;
    if (!callback) {
      throw new Error(`invalid plugin, expect function or object with an "apply" method, received ${typeof pluginValue}`);
    }
    this.fiber.assertActive();
    const meta = pluginValue as Plugin;
    let name = (pluginValue as { name?: string }).name;
    if (name === "apply") name = undefined;
    const runtime: PluginRuntime = { name, callback, Config: meta.Config, fibers: new Set() };
    const fiber = new Fiber(this, config, Inject.resolve(meta.inject), runtime);
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>;
    wrapped.then = (onFulfilled: any, onRejected: any) => fiber.await().then(onFulfilled, onRejected);
    return wrapped;
  }

  /** 在当前 fiber 上登记可逆 effect（卸载全回滚）。 */
  effect(execute: () => Effect, label?: string): Disposable & PromiseLike<() => unknown> {
    return this.fiber.effect(execute, label);
  }

  /** 卸载当前 context 归属的插件（root fiber 则级联卸载全部插件）。 */
  async dispose(): Promise<void> {
    await this.fiber.dispose();
  }
}

Object.defineProperty(Context.prototype, Symbol.for("cordis.is"), { value: true });
// 上游同款品牌技巧：`Context.is` 静态方法经 Symbol.toPrimitive 充当品牌键。
(Context.is as any)[Symbol.toPrimitive] = () => Symbol.for("cordis.is");

/** 依赖声明规范化（上游 Inject.resolve 子集）：数组 / 名称映射 → 名称表。 */
export namespace Inject {
  export function resolve(inject: string[] | Record<string, unknown> | null | undefined): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    if (!inject) return result;
    if (Array.isArray(inject)) {
      for (const name of inject) result[name] = null;
    } else {
      for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
    }
    return result;
  }
}

const contextHandler: ProxyHandler<Context> = {
  get(target, prop, receiver) {
    if (prop in target) return Reflect.get(target, prop, receiver);
    if (typeof prop === "symbol") return undefined;
    return target.get(prop);
  },
  set(target, prop, value, receiver) {
    if (typeof prop === "symbol") return Reflect.set(target, prop, value, receiver);
    // 服务优先（含内建 logger 的只读保护），再走普通属性
    if (target.serviceStore.has(prop)) {
      target.set(prop, value);
      return true;
    }
    if (prop in target) return Reflect.set(target, prop, value, receiver);
    // root context 允许自由挂属性（上游 root 非 runtime 场景同款）；插件 ctx 必须先 provide。
    if (target.fiber === target.root.fiber) {
      return Reflect.set(target, prop, value, receiver);
    }
    target.set(prop, value);
    return true;
  },
  has(target, prop) {
    if (prop in target) return true;
    if (typeof prop !== "symbol") return target.serviceStore.has(prop);
    return false;
  },
};

// ---------------------------------------------------------------------------
// Service 基类（子集）
// ---------------------------------------------------------------------------

/**
 * 服务基类（上游 Service 子集）：子类构造时 `super(ctx, name)` 即完成注册，
 * 随所属 fiber 卸载自动移除。`Service.invoke` 可调用实例、check 谓词未支持。
 */
export abstract class Service {
  static readonly init: symbol = symbols.init;
  static readonly check: symbol = symbols.check;
  static readonly config: symbol = symbols.config;
  static readonly invoke: symbol = symbols.invoke;

  name!: string;

  constructor(ctx: Context, name: string) {
    ctx.provide(name, this);
    this.name = name;
  }
}
