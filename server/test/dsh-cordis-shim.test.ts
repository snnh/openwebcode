/** dsh 垫片单测 · cordis 子集（M1）：插件形态 / inject 等待 / effect 回滚 / 事件五派发。 */
import { describe, expect, it, vi } from "vitest";
import type { LoggerMessage } from "../src/dsh/cordis-shim.js";
import { Context, CordisError, Service, createLogger, isBailed } from "../src/dsh/cordis-shim.js";
import Schema from "../src/dsh/schemastery-shim.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
function createRoot(): { ctx: Context; messages: LoggerMessage[] } {
  const messages: LoggerMessage[] = [];
  return { ctx: new Context({ logger: { export: (message) => messages.push(message) } }), messages };
}

describe("cordis-shim 插件规范化与生命周期", () => {
  it("插件四形态（函数/对象/类/模块命名导出）都在独立子 context 上激活并注册服务", async () => {
    const forms: Array<[string, unknown]> = [
      ["函数插件", (ctx: Context) => { ctx.provide("marker", "fn"); }],
      ["对象插件", { name: "obj-plugin", apply: (ctx: Context) => { ctx.provide("marker", "obj"); } }],
      ["类插件", class { constructor(ctx: Context) { ctx.provide("marker", "cls"); } }],
      ["模块命名导出", { name: "named-plugin", inject: ["logger"], apply(ctx: Context) { expect(ctx.logger.info).toBeTypeOf("function"); ctx.provide("marker", "module"); } }],
    ];
    for (const [name, plugin] of forms) {
      const { ctx } = createRoot();
      const fiber = await ctx.plugin(plugin as never); expect([Context.is(fiber.ctx), fiber.ctx !== ctx, ctx.get("marker")], name).toEqual([true, true, expect.any(String)]);
    }
  });

  it("函数插件：config 校验后原样传给 apply", async () => {
    const { ctx } = createRoot();
    const seen: unknown[] = [];
    await ctx.plugin((inner) => { seen.push(inner !== ctx); }, { value: 1 }); expect(seen).toEqual([true]);
    await ctx.plugin((_inner, config) => { seen.push(config); }, { value: 2 }); expect(seen).toEqual([true, { value: 2 }]);
  });

  it("非法插件形态与 Config 校验失败 fail loud：await 上抛且 fiber 落 failed", async () => {
    const { ctx } = createRoot(); expect(() => ctx.plugin({ noApply: true } as never)).toThrow(/invalid plugin/);
    const failed = ctx.plugin({ Config: Schema.object({ level: Schema.number().required() }), apply() {} });
    await expect(failed).rejects.toThrow(/config validation failed/);
    const asyncConfig = { "~standard": { version: 1 as const, validate: () => Promise.resolve({ value: 1 }) } };
    await expect(ctx.plugin({ Config: asyncConfig, apply() {} })).rejects.toThrow(/Async config validation/);
    await flush(); expect((failed as unknown as { state: string }).state).toBe("failed");
  });

  it("插件体返回的 thenable 会被 await：异步注册先于激活完成，异步抛错落 failed", async () => {
    const { ctx } = createRoot();
    const order: string[] = [];
    const fiber = ctx.plugin(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 1)); order.push("apply done"); });
    await fiber; expect([order, fiber.state]).toEqual([["apply done"], "active"]);
    const failing = ctx.plugin(async () => { await Promise.resolve(); throw new Error("async apply boom"); });
    await expect(failing).rejects.toThrow("async apply boom"); expect((failing as unknown as { state: string }).state).toBe("failed");
  });

  it("inject 硬依赖：缺失时 pending 不激活，provide 后激活，依赖移除则卸载回滚并回到 pending", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const waiting = ctx.plugin({ inject: ["tools"], apply() { log.push("tools-apply"); } });
    await flush(); expect([waiting.state, log]).toEqual(["pending", []]);
    ctx.provide("tools", { register() {} });
    await vi.waitFor(() => expect(waiting.state).toBe("active")); expect(log).toEqual(["tools-apply"]);
    const removeService = ctx.provide("svc", {});
    const fiber = ctx.plugin({ inject: ["svc"], apply(inner) { log.push("start"); inner.effect(() => () => log.push("stop")); } });
    await vi.waitFor(() => expect(fiber.state).toBe("active"));
    removeService();
    await vi.waitFor(() => expect(log).toEqual(["tools-apply", "start", "stop"]));
    await vi.waitFor(() => expect(fiber.state).toBe("pending"));
  });

  it("服务可见性：插件 A 提供的服务供 B 消费，root 也能提供；A 卸载时先自身回滚再等依赖者卸载", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const provider = ctx.plugin({ name: "provider", apply(inner) { inner.provide("shared", { api: 1 }); inner.effect(() => () => log.push("provider-stop")); } });
    const consumer = ctx.plugin({ name: "consumer", inject: ["shared"], apply(inner) { log.push(`consume:${JSON.stringify(inner.get("shared"))}`); inner.effect(() => () => log.push("consumer-stop")); } });
    await vi.waitFor(() => expect(consumer.state).toBe("active")); expect(log).toEqual(['consume:{"api":1}']);
    await provider.dispose();
    // 上游 reflect.provide 语义：provider 自身 effect 先回滚，provide disposer 等依赖者卸载完成
    expect(log).toEqual(['consume:{"api":1}', "provider-stop", "consumer-stop"]);
    ctx.provide("root-svc", "r");
    const rootConsumer = ctx.plugin({ inject: ["root-svc"], apply() {} }); // root 提供的服务对插件可见
    await vi.waitFor(() => expect(rootConsumer.state).toBe("active"));
  });

  it("effect：立即执行 setup；fiber 卸载逆序回滚且幂等；已卸载 fiber 上注册抛 CordisError", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const fiber = ctx.plugin((inner) => {
      inner.effect(() => { log.push("e1-setup"); return () => log.push("e1-stop"); }, "e1");
      inner.effect(() => () => log.push("e2-stop"), "e2");
    });
    await flush(); expect(log).toEqual(["e1-setup"]);
    await fiber.dispose();
    await fiber.dispose(); expect(log).toEqual(["e1-setup", "e2-stop", "e1-stop"]); expect(() => fiber.ctx.effect(() => () => {})).toThrow(CordisError);
  });

  it("effect：接受 Promise 与迭代器形态；非法返回形态让 fiber 启动失败（TypeError）", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const fiber = ctx.plugin((inner) => {
      inner.effect(async () => () => log.push("async-stop"));
      inner.effect(() => [() => log.push("it-1"), () => log.push("it-2")][Symbol.iterator]());
    });
    await flush();
    await fiber.dispose(); expect(log).toEqual(["it-2", "it-1", "async-stop"]);
    const broken = ctx.plugin((inner) => { inner.effect((() => ({ not: "disposable" })) as never); });
    await expect(broken).rejects.toThrow(TypeError);
    await flush(); expect((broken as unknown as { state: string }).state).toBe("failed");
  });

  it("provide 归属当前 fiber：重复注册与越权 set 报错、disposer 移除服务、Service 子类随卸载移除", async () => {
    const { ctx } = createRoot();
    ctx.provide("x", 1); expect(() => ctx.provide("x", 2)).toThrow(/has been registered/); expect(ctx.get("x")).toBe(1);
    // disposer 移除服务本身
    const dispose = ctx.provide("y", 3);
    dispose(); expect(ctx.get("y")).toBeUndefined();
    // 内建 logger 非本 fiber 提供，不可 set
    expect(() => { (ctx as unknown as { logger: unknown }).logger = 1; }).toThrow(/multiple fibers/);
    class MyService extends Service { value = 42; }
    const fiber = ctx.plugin((inner) => { void new MyService(inner, "my-svc"); });
    await flush(); expect((ctx.get("my-svc") as unknown as MyService).value).toBe(42);
    await fiber.dispose(); expect(ctx.get("my-svc")).toBeUndefined();
  });
});

describe("cordis-shim 事件系统", () => {
  it("emit 同步派发（返回值忽略）；parallel 全并发等待且失败聚合为 AggregateError", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("e", () => log.push("sync-1"));
    ctx.on("e", () => log.push("sync-2"));
    ctx.on("e", async () => { await flush(); log.push("slow"); });
    ctx.on("e", async () => { log.push("fast"); });
    ctx.emit("e"); expect(log).toEqual(["sync-1", "sync-2", "fast"]);
    await ctx.parallel("e"); expect(log.at(-1)).toBe("slow");
    ctx.on("boom", () => { throw new Error("x"); });
    await expect(ctx.parallel("boom")).rejects.toBeInstanceOf(AggregateError);
  });

  it("serial 依序 await 且 bail 即停；bail 为同步版；isBailed 只在 null/false/undefined 时视为继续", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("e", async () => { await flush(); log.push("a"); return null; });
    ctx.on("e", async () => { log.push("b"); return undefined; });     // null/undefined 不 bail
    ctx.on("e", () => { log.push("c"); return 42; });                  // 非 null/false 即 bail
    ctx.on("e", () => { log.push("d"); }); expect(await ctx.serial("e")).toBe(42); expect(log).toEqual(["a", "b", "c"]);
    ctx.on("bail", () => undefined);
    ctx.on("bail", () => "hit"); expect(ctx.bail("bail")).toBe("hit"); expect([isBailed(0), isBailed(""), isBailed(null), isBailed(false), isBailed(undefined)]).toEqual([true, true, false, false, false]);
  });

  it("waterfall：外层包裹内层 next、无监听器直达内建；不调用 next 即否决后续链与内建", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("wf", async (payload: { value: number }, next: () => Promise<{ value: number }>) => { log.push("outer"); return { value: (await next()).value + 1 }; });
    ctx.on("wf", (_payload: { value: number }, next: () => Promise<{ value: number }>) => { log.push("inner"); return next(); });
    expect([await ctx.waterfall("wf", { value: 1 }, () => Promise.resolve({ value: 10 })), log]).toEqual([{ value: 11 }, ["outer", "inner"]]); expect(ctx.waterfall("empty", 1, 2, () => "built-in")).toBe("built-in");
    ctx.on("veto", (payload: { ok: boolean }, next: () => unknown) => (payload.ok ? next() : { vetoed: true }));
    ctx.on("veto", (_payload: { ok: boolean }, next: () => unknown) => next()); expect(await ctx.waterfall("veto", { ok: false }, () => { throw new Error("must be vetoed"); })).toEqual({ vetoed: true });
    expect(await ctx.waterfall("veto", { ok: true }, () => "built-in")).toBe("built-in");
  });

  it("on 返回布尔型 disposer、prepend 生效、once 只触发一次；插件卸载自动移除其监听器", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("e", () => log.push("tail"));
    const disposeHead = ctx.on("e", () => log.push("head"), true);
    ctx.emit("e"); expect([log, disposeHead(), disposeHead()]).toEqual([["head", "tail"], true, false]);
    ctx.emit("e"); expect(log).toEqual(["head", "tail", "tail"]);
    let once = 0;
    ctx.once("o", () => once++);
    ctx.emit("o");
    ctx.emit("o");
    let calls = 0;
    const fiber = ctx.plugin((inner) => { inner.on("evt", () => calls++); });
    await flush();
    ctx.emit("evt");
    await fiber.dispose();
    ctx.emit("evt"); expect([once, calls]).toEqual([1, 1]);
  });
});

describe("cordis-shim 服务仓库与 context", () => {
  it("属性读取走服务仓库（未注册即 undefined），root 可自由挂属性；extend 继承服务并遮蔽 meta", () => {
    const { ctx } = createRoot();
    ctx.provide("demo", { hello: 1 });
    const asRecord = ctx as unknown as Record<string, unknown>; expect([ctx.get("demo"), asRecord.demo, asRecord.missing]).toEqual([{ hello: 1 }, { hello: 1 }, undefined]);
    asRecord.arbitrary = 1; expect(asRecord.arbitrary).toBe(1);
    ctx.provide("svc", "base");
    const child = ctx.extend({ marker: "child" }) as unknown as Record<string, unknown>; expect([child.svc, child.marker, Context.is(child), Context.is({})]).toEqual(["base", "child", true, false]);
  });

  it("内建 logger：命名实例 + 等级过滤 + sink 落消息", () => {
    const { ctx, messages } = createRoot();
    ctx.logger.info("hello");
    ctx.logger.error("oops");
    const named: LoggerMessage[] = [];
    createLogger("plugin-a", { export: (message) => named.push(message) }).warn("careful"); expect([messages.map((message) => `${message.name}:${message.type}`), named.map((message) => `${message.name}:${message.type}`)])
      .toEqual([["app:info", "app:error"], ["plugin-a:warn"]]);
    // 等级阈值之下的消息不进 sink（sink 抛错即可证明未被调用）
    const muted = createLogger("muted", { export: () => { throw new Error("must not export"); }, levels: { default: 30 } });
    muted.debug("suppressed");
  });

  it("卸载级联：root dispose 与父插件卸载都逆序回收插件（root 卸载后 plugin() 报错）", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    await ctx.plugin((inner) => { inner.effect(() => () => log.push("p1-stop")); });
    await ctx.plugin((inner) => { inner.effect(() => () => log.push("p2-stop")); });
    await ctx.dispose(); expect(log).toEqual(["p2-stop", "p1-stop"]); expect(() => ctx.plugin(() => {})).toThrow(CordisError);
    const { ctx: other } = createRoot();
    const parent = other.plugin((inner) => {
      inner.plugin((child) => { child.effect(() => () => log.push("child-stop")); });
      inner.effect(() => () => log.push("parent-stop"));
    });
    await flush();
    await parent.dispose(); expect(log.slice(-2)).toEqual(["parent-stop", "child-stop"]);
  });
});
