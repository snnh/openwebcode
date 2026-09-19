/**
 * dsh 兼容层 · 服务缝桥接（M3）
 *
 * 把上游插件面的能力投影到 Extension Host 既有宿主通道（callApi → server dispatchApi），
 * 并作为 root Context 的内建服务激活后绑定到每个插件 ctx（Fiber.activate 的 prepare 扩展点）：
 * - `llm`：model.complete / model.vision（经 model 网关，不暴露 API Key；prompt/maxTokens 由 server 强制上限）
 * - `sessions`：list / get（只读，server 侧已滤元信息白名单）
 * - `storage`：read/write/delete/list（server 按伪扩展 id 隔离到 `<dataDir>/extensions-data/dsh-<pluginId>/`）
 * - `timer`：timeout/interval/throttle/debounce（上游 cordis timer 语义子集，全部为 fiber effect，卸载自动清理）
 * - `dshEvents`：EventBus 白名单订阅（宿主面命名为 dshEvents，避免与 cordis `ctx.events` 事件总线冲突）
 *
 * 同时提供 agent 钩子桥：上游 `tools/pre-execute`（waterfall）与 `tools/post-execute`（waterfall）
 * 经根 context 的同名事件经根 context 的同名事件投影执行，决策判别式与上游
 * `packages/core/tools/src/index.ts` 逐字对齐（本地钉版核对：PreToolDecision/PostToolDecision）。
 *
 * 边界（与计划一致）：shell/fs/subagents/jobs/sandbox 不提供服务缝——插件 inject 这些则
 * 不激活并如实报 missing-services。
 */
import { Context, DshServiceError } from "./cordis-shim.js";

/*
 * oxlint/typescript-eslint 豁免说明：timer 服务（timeout/interval/throttle/debounce）刻意
 * 使用 any——上游 cordis timer.ts 的 API 形态即「回调元组擦除」（generic callback tuples +
 * async-iterator 返回值不窄化），为保持与上游逐字对齐的公开 API，这里保留 any（上游源文件
 * 同款 oxlint-disable typescript/no-explicit-any 注释）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// 宿主能力调用（经 extension-host-process 的 callApi 通道）
// ---------------------------------------------------------------------------

/** 一次宿主调用的句柄：伪扩展 id + api 名 + 参数 + 可覆盖的超时（扩展 id 由宿主运行时解析传入）。 */
export interface DshHostCall {
  (extensionId: string, api: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** server dispatchApi 的 api 名；dsh 伪扩展 id 的白名单分支在 extension-manager 的 dispatchDshApi 实现。 */
export const DSH_SERVICE_APIS = ["model.complete", "model.vision", "sessions.list", "sessions.get", "storage.read", "storage.write", "storage.delete", "storage.list", "events.subscribe"] as const;

/** model.complete / model.vision 的缺省宿主超时（模型调用远超扩展 IPC 的 5s 缺省）。 */
const MODEL_CALL_TIMEOUT_MS = 60_000;

/** 归一为非空字符串；空/非字符串抛 DshServiceError（上游 LlmError 风格的 HarnessError）。 */
function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new DshServiceError(`${what} must be a non-empty string`, "INVALID_ARGS");
  return value;
}

// ---------------------------------------------------------------------------
// llm 服务（ctx.llm）
// ---------------------------------------------------------------------------

interface DshLlmService {
  /** 快速补全（模型网关；prompt ≤32 KiB、maxTokens ≤4096 由 server 强制）。 */
  complete(input: { prompt: string; maxTokens?: number }): Promise<{ text: string }>;
  /** 视觉通道：图片经指定 provider/model 生成描述。 */
  vision(input: {
    provider: string;
    model: string;
    prompt: string;
    thinking?: boolean;
    maxTokens?: number;
    images: Array<{ mediaType: string; data: string }>;
  }): Promise<{ text: string }>;
}

function createLlmService(resolveExtensionId: () => string, call: DshHostCall): DshLlmService {
  return {
    async complete(input) {
      const prompt = requireString(input?.prompt, "llm.complete prompt");
      const result = await call(resolveExtensionId(), "model.complete", { prompt, ...(typeof input?.maxTokens === "number" ? { maxTokens: input.maxTokens } : {}) }, MODEL_CALL_TIMEOUT_MS);
      return { text: typeof (result as { text?: unknown })?.text === "string" ? (result as { text: string }).text : String(result ?? "") };
    },
    async vision(input) {
      const provider = requireString(input?.provider, "llm.vision provider");
      const model = requireString(input?.model, "llm.vision model");
      const prompt = requireString(input?.prompt, "llm.vision prompt");
      if (!Array.isArray(input?.images) || input.images.length < 1) {
        throw new DshServiceError("llm.vision requires at least one image", "INVALID_ARGS");
      }
      const images: Array<{ mediaType: string; data: string }> = [];
      for (const image of input.images) {
        images.push({
          mediaType: requireString(image?.mediaType, "llm.vision image mediaType"),
          data: requireString(image?.data, "llm.vision image data"),
        });
      }
      const result = await call(
        resolveExtensionId(),
        "model.vision",
        { provider, model, prompt, thinking: input?.thinking !== false, images, ...(typeof input?.maxTokens === "number" ? { maxTokens: input.maxTokens } : {}) },
        MODEL_CALL_TIMEOUT_MS,
      );
      return { text: typeof (result as { text?: unknown })?.text === "string" ? (result as { text: string }).text : String(result ?? "") };
    },
  };
}

// ---------------------------------------------------------------------------
// sessions 服务（ctx.sessions，只读）
// ---------------------------------------------------------------------------

interface DshSessionsService {
  list(): Promise<unknown[]>;
  get(id: string): Promise<unknown>;
}

function createSessionsService(resolveExtensionId: () => string, call: DshHostCall): DshSessionsService {
  return {
    async list() {
      const result = await call(resolveExtensionId(), "sessions.list");
      return Array.isArray(result) ? result : [];
    },
    async get(id) {
      return call(resolveExtensionId(), "sessions.get", { id: requireString(id, "sessions.get id") });
    },
  };
}

// ---------------------------------------------------------------------------
// storage 服务（ctx.storage；server 按伪扩展 id 隔离到私有目录）
// ---------------------------------------------------------------------------

interface DshStorageService {
  read(relativePath: string): Promise<{ content: string | null }>;
  write(relativePath: string, content: string): Promise<{ bytes: number }>;
  delete(relativePath: string): Promise<{ deleted: boolean }>;
  list(prefix?: string): Promise<{ files: string[] }>;
}

function createStorageService(resolveExtensionId: () => string, call: DshHostCall): DshStorageService {
  return {
    read(relativePath) {
      return call(resolveExtensionId(), "storage.read", { path: requireString(relativePath, "storage.read path") }) as Promise<{ content: string | null }>;
    },
    write(relativePath, content) {
      return call(resolveExtensionId(), "storage.write", { path: requireString(relativePath, "storage.write path"), content: String(content ?? "") }) as Promise<{ bytes: number }>;
    },
    delete(relativePath) {
      return call(resolveExtensionId(), "storage.delete", { path: requireString(relativePath, "storage.delete path") }) as Promise<{ deleted: boolean }>;
    },
    list(prefix) {
      return call(resolveExtensionId(), "storage.list", ...(prefix !== undefined ? [{ prefix: requireString(prefix, "storage.list prefix") }] : [])) as Promise<{ files: string[] }>;
    },
  };
}

// ---------------------------------------------------------------------------
// dshEvents：EventBus 白名单事件订阅（宿主面命名，避开 cordis ctx.events 总线）
// ---------------------------------------------------------------------------

interface DshEventSubscription {
  /** 解除订阅（幂等）。 */
  dispose(): void;
}

/** 订阅登记（宿主侧记表用；解除订阅返回 disposer）。 */
type DshEventSubscribe = (types: string[], handler: (event: { type: string; sessionId?: string; payload: unknown }) => void) => () => void;

interface DshEventsService {
  /**
   * 订阅 server EventBus 白名单事件；handler 收 `{type, sessionId?, payload}`。
   * handler 抛错由宿主隔离（写 stderr，不阻断其它订阅者与宿主自身）。
   */
  subscribe(types: string[], handler: (event: { type: string; sessionId?: string; payload: unknown }) => void): DshEventSubscription;
}

// ---------------------------------------------------------------------------
// timer 服务（上游 cordis timer 语义子集：timeout/interval/throttle/debounce）
// ---------------------------------------------------------------------------

interface DshTimerService {
  /** 单次：回调版返回 disposer；纯延迟版返回 Promise（ctx 卸载时以 Context has been disposed 拒绝）。 */
  timeout(callback: () => void, delay: number): () => void;
  timeout(delay: number): Promise<void>;
  /** 周期：回调版返回 disposer；纯延迟版返回 tick 的 async iterator。 */
  interval(callback: () => void, delay: number): () => void;
  interval(delay: number): AsyncIterableIterator<void>;
  /** 节流（最小间隔 delay ms）；noTrailing 抑制尾随调用。返回的包装函数带 dispose。 */
  throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): F & { dispose: () => void };
  /** 防抖（静默 delay ms 后执行）。返回的包装函数带 dispose。 */
  debounce<F extends (...args: any[]) => void>(callback: F, delay: number): F & { dispose: () => void };
  /** @deprecated 上游同义别名：等价 timeout(callback, delay)。 */
  setTimeout(callback: () => void, delay: number): () => void;
  /** @deprecated 上游同义别名：等价 interval(callback, delay)。 */
  setInterval(callback: () => void, delay: number): () => void;
}

/** delay 归一：有限非负毫秒数，否则抛 DshServiceError(INVALID_ARGS)。 */
function requireDelay(delay: unknown): number {
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0) {
    throw new DshServiceError("timer delay must be a non-negative finite number", "INVALID_ARGS");
  }
  return delay;
}

function createTimerService(ctx: Context): DshTimerService {
  return {
    timeout(...args: any[]): any {
      const callback = typeof args[0] === "function" ? args.shift() as () => void : undefined;
      const delay = requireDelay(args[0]);
      if (callback !== undefined) {
        const dispose = ctx.effect(() => {
          const timer = globalThis.setTimeout(() => {
            void dispose();
            callback();
          }, delay);
          return () => globalThis.clearTimeout(timer);
        }, "ctx.timeout()");
        return dispose;
      }
      // 纯延迟版：timer 引用交给 onFulfilled/onRejected 直接 clearTimeout（不调 wrapper——
      // wrapper() 是完整 release 会 reject；上游纯延迟版语义是兑现即静默取消定时器）。
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let resolveTimer!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveTimer = resolve;
      });
      ctx.effect(() => {
        timer = globalThis.setTimeout(() => {
          resolveTimer();
        }, delay);
        return () => {
          if (timer !== undefined) globalThis.clearTimeout(timer);
        };
      }, "ctx.timeout()");
      return promise.then(
        (value) => {
          if (timer !== undefined) globalThis.clearTimeout(timer);
          return value;
        },
        (error: unknown) => {
          if (timer !== undefined) globalThis.clearTimeout(timer);
          throw error instanceof Error ? error : new Error(String(error));
        },
      );
    },
    interval(...args: any[]): any {
      const callback = typeof args[0] === "function" ? args.shift() as () => void : undefined;
      const delay = requireDelay(args[0]);
      if (callback !== undefined) {
        return ctx.effect(() => {
          const timer = globalThis.setInterval(callback, delay);
          return () => globalThis.clearInterval(timer);
        }, "ctx.interval()");
      }
      // async-iterator 形态：卸载/return 时拒绝或结束（上游 timer.ts 同款语义）。
      let settled: { kind: "return" } | { kind: "throw"; reason: unknown } | undefined;
      let nextTask: { promise: Promise<IteratorResult<void>>; resolve(value: IteratorResult<void>): void; reject(reason: unknown): void } | undefined;
      const dispose = ctx.effect(() => {
        const timer = globalThis.setInterval(() => {
          nextTask?.resolve({ done: false, value: undefined });
        }, delay);
        return () => {
          globalThis.clearInterval(timer);
          if (settled !== undefined) return;
          settled = { kind: "throw", reason: new Error("Context has been disposed") };
          nextTask?.reject(settled.reason);
        };
      }, "ctx.interval()");
      return {
        next: () => {
          if (settled === undefined) {
            let resolve!: (value: IteratorResult<void>) => void;
            let reject!: (reason: unknown) => void;
            const promise = new Promise<IteratorResult<void>>((res, rej) => {
              resolve = res;
              reject = rej;
            });
            nextTask = { promise, resolve, reject };
            return promise;
          }
          if (settled.kind === "return") return Promise.resolve({ done: true, value: undefined });
          return Promise.reject(settled.reason);
        },
        return: () => {
          if (settled === undefined) settled = { kind: "return" };
          nextTask?.resolve({ done: true, value: undefined });
          void dispose();
          return Promise.resolve({ done: true, value: undefined });
        },
        throw: (reason: unknown) => {
          if (settled === undefined) settled = { kind: "throw", reason };
          nextTask?.reject(reason);
          void dispose();
          return Promise.resolve({ done: true, value: undefined });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      } satisfies AsyncIterableIterator<void>;
    },
    throttle(callback: any, delay: unknown, noTrailing?: boolean): any {
      if (typeof callback !== "function") throw new DshServiceError("timer.throttle callback must be a function", "INVALID_ARGS");
      const wait = requireDelay(delay);
      let lastCall = -Infinity;
      const execute = (...args: any[]): void => {
        lastCall = Date.now();
        callback(...args);
      };
      return schedule(ctx, "ctx.throttle()", (args, disposed) => {
        const remaining = wait - Date.now() + lastCall;
        if (remaining <= 0) execute(...args);
        else if (!disposed && !noTrailing) return globalThis.setTimeout(execute, remaining, ...args);
      });
    },
    debounce(callback: any, delay: unknown): any {
      if (typeof callback !== "function") throw new DshServiceError("timer.debounce callback must be a function", "INVALID_ARGS");
      const wait = requireDelay(delay);
      return schedule(ctx, "ctx.debounce()", (args, disposed) => {
        if (disposed) return;
        return globalThis.setTimeout(callback, wait, ...args);
      });
    },
    setTimeout(callback: () => void, delay: number): () => void {
      return (this.timeout as (...args: any[]) => any)(callback, delay);
    },
    setInterval(callback: () => void, delay: number): () => void {
      return (this.interval as (...args: any[]) => any)(callback, delay);
    },
  };
}

/** throttle/debounce 的共享调度：包装函数的 timer 归属调用 fiber，dispose 幂等。 */
function schedule(ctx: Context, label: string, trigger: (args: any[], disposed: boolean) => ReturnType<typeof globalThis.setTimeout> | undefined): any {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;
  const dispose = ctx.effect(() => () => {
    disposed = true;
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }, label);
  const wrapper: any = (...args: any[]): void => {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timer = trigger(args, disposed);
  };
  wrapper.dispose = dispose;
  return wrapper;
}

// ---------------------------------------------------------------------------
// 根服务表：激活后在 root context 上 provide（插件经 inject / ctx.* 解析）
// ---------------------------------------------------------------------------

export interface DshServicesOptions {
  /** 宿主能力调用（绑定到具体伪扩展 id）。 */
  call: DshHostCall;
  /** EventBus 订阅注册惰性求值（首个插件激活后）：返回真正的 subscribe 实现。 */
  subscribeEvents: () => DshEventSubscribe;
  /** 宿主审计日志（ask 降级等）；可选。 */
  audit?: (message: string) => void;
}

/** 在 root context 上 provide M3 服务缝（root fiber；插件卸载不移除，宿主关闭时随 root 回收）。 */
export function provideDshServices(root: Context, resolveExtensionId: () => string, options: DshServicesOptions): void {
  const { call } = options;
  root.provide("llm", createLlmService(resolveExtensionId, call));
  root.provide("sessions", createSessionsService(resolveExtensionId, call));
  root.provide("storage", createStorageService(resolveExtensionId, call));
  root.provide("timer", createTimerService(root));
  // dshEvents 直接对象（root provide）：subscribe 校验后调 subscribeEvents()（首个激活插件触发注册）。
  const subscribeEventsLazy = options.subscribeEvents;
  root.provide("dshEvents", {
    subscribe: (types, handler) => {
      if (!Array.isArray(types) || types.some((type) => typeof type !== "string" || type.length === 0)) {
        throw new DshServiceError("dshEvents.subscribe requires an array of event type strings", "INVALID_ARGS");
      }
      if (typeof handler !== "function") throw new DshServiceError("dshEvents.subscribe requires a handler function", "INVALID_ARGS");
      return { dispose: subscribeEventsLazy()(types, handler) };
    },
  } satisfies DshEventsService);
}

// ---------------------------------------------------------------------------
// tools/pre-execute → 映射决策（上游 PreToolDecision 判别式，逐字对齐）
// ---------------------------------------------------------------------------

type DshPreToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "cancel" }
  | { kind: "ask"; reason?: string };

export interface DshPreToolOutcome {
  blocked: boolean;
  reason?: string;
  /** ask 降级为放行时的审计备注（由宿主写审计日志）。 */
  audit?: string;
}

function normalizePreDecision(value: unknown): DshPreToolDecision {
  if (!value || typeof value !== "object") return { kind: "allow" };
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "deny") {
    const reason = (value as { reason?: unknown }).reason;
    return { kind: "deny", reason: typeof reason === "string" && reason ? reason : "denied by dsh plugin" };
  }
  if (kind === "cancel") return { kind: "cancel" };
  if (kind === "ask") {
    const reason = (value as { reason?: unknown }).reason;
    return { kind: "ask", ...(typeof reason === "string" && reason ? { reason } : {}) };
  }
  return { kind: "allow" };
}

/**
 * `tools/pre-execute` waterfall → owc beforeTool 语义。
 * - 无监听 / allow → 放行；
 * - deny → blocked + reason（上游落地为 `Error: <reason>` 的错误结果）；
 * - cancel → blocked + 上游 canonical 中止文案；
 * - ask → v1 降级为放行 + 审计日志（计划明示；上游审批服务由 owc 权限链覆盖，重复审批会死锁）。
 */
export async function runDshPreExecute(ctx: Context, exec: { tool: string; input: Record<string, unknown>; sessionId?: string; cwd: string }, audit?: (message: string) => void): Promise<DshPreToolOutcome> {
  if (ctx.events.hooksFor("tools/pre-execute").length === 0) return { blocked: false };
  const decision = normalizePreDecision(
    await ctx.waterfall("tools/pre-execute", { name: exec.tool, arguments: exec.input, ...(exec.sessionId !== undefined ? { sessionId: exec.sessionId } : {}), cwd: exec.cwd }, () => ({ kind: "allow" } satisfies DshPreToolDecision)),
  );
  switch (decision.kind) {
    case "allow":
      return { blocked: false };
    case "deny":
      return { blocked: true, reason: `Error: ${decision.reason}` };
    case "cancel":
      return { blocked: true, reason: "Error: tool call aborted before dispatch" };
    case "ask": {
      const note = `dsh tools/pre-execute ask 降级为放行${decision.reason ? `：${decision.reason}` : ""}（tool=${exec.tool}${exec.sessionId ? `, session=${exec.sessionId}` : ""}）`;
      audit?.(note);
      return { blocked: false, audit: note };
    }
  }
}

// ---------------------------------------------------------------------------
// tools/post-execute → 结果变换（上游 PostToolDecision：accept 变换 / block 否决）
// ---------------------------------------------------------------------------

export interface DshPostToolOutcome {
  content?: string;
  isError?: boolean;
}

function normalizePostDecision(value: unknown): { kind: "accept"; content?: string } | { kind: "block"; feedback: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "block") {
    const feedback = (value as { feedback?: unknown }).feedback;
    if (typeof feedback === "string") return { kind: "block", feedback };
    if (Array.isArray(feedback)) {
      // 上游 block.feedback 为 ContentBlock[]：取文本块拼接（非文本块降级为 [type] 占位）。
      const text = feedback
        .map((block: unknown) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : `[${(block as { type?: unknown })?.type ?? "unknown"} content]`))
        .join("\n");
      return { kind: "block", feedback: text || "tool result blocked by post-execute policy" };
    }
    return { kind: "block", feedback: "tool result blocked by post-execute policy" };
  }
  if (kind === "accept") {
    const content = (value as { content?: unknown }).content;
    if (typeof content === "string") return { kind: "accept", content };
    if (Array.isArray(content)) {
      const text = content
        .map((block: unknown) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : `[${(block as { type?: unknown })?.type ?? "unknown"} content]`))
        .join("\n");
      return { kind: "accept", content: text };
    }
    return undefined; // 无 content 的 accept = 保持原样
  }
  return undefined;
}

/**
 * `tools/post-execute` waterfall → 工具结果变换。
 * - accept{content} → 替换模型可见文本；
 * - block{feedback} → 转为错误结果（错误文案 = feedback）；
 * - 无决策 / 无 content 的 accept → 保持原样；
 * - value 形态（upstream JsonValue 替换）与 additionalContexts v1 不支持（日志明示）。
 */
export async function runDshPostExecute(ctx: Context, exec: { tool: string; input: Record<string, unknown>; sessionId?: string; cwd: string }, result: { content: string; isError?: boolean }, _audit?: (message: string) => void): Promise<DshPostToolOutcome | undefined> {
  if (ctx.events.hooksFor("tools/post-execute").length === 0) return undefined;
  const upstreamResult = { isError: result.isError === true, content: [{ type: "text" as const, text: result.content }] };
  const decision = normalizePostDecision(
    await ctx.waterfall("tools/post-execute", { name: exec.tool, arguments: exec.input, ...(exec.sessionId !== undefined ? { sessionId: exec.sessionId } : {}), cwd: exec.cwd }, upstreamResult, () => ({ kind: "accept" })),
  );
  if (!decision) return undefined;
  if (decision.kind === "block") return { content: decision.feedback, isError: true };
  return decision.content !== undefined ? { content: decision.content } : undefined;
}
