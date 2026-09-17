/** dsh 垫片单测 · cordis 子集（M1）：插件三形态 / inject 等待 / effect 回滚 / 事件五派发 */
import { describe, expect, it, vi } from "vitest";
import type { LoggerMessage } from "../src/dsh/cordis-shim.js";
import { Context, CordisError, Service, createLogger, isBailed } from "../src/dsh/cordis-shim.js";
import Schema from "../src/dsh/schemastery-shim.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function createRoot() {
  const messages: LoggerMessage[] = [];
  const ctx = new Context({ logger: { export: message => messages.push(message) } });
  return { ctx, messages };
}

describe("cordis-shim 插件规范化与生命周期", () => {
  it("函数插件：apply 收到独立子 context 与校验后的 config", async () => {
    const { ctx } = createRoot();
    const seen: unknown[] = [];
    await ctx.plugin((inner, config) => {
      seen.push(Context.is(inner), inner !== ctx, config);
    }, { value: 1 });
    expect(seen).toEqual([true, true, { value: 1 }]);
  });

  it("对象插件与类插件形态", async () => {
    const { ctx } = createRoot();
    const objectPlugin = {
      name: "obj-plugin",
      apply(inner: Context) {
        inner.provide("marker-obj", "obj");
      },
    };
    await ctx.plugin(objectPlugin);
    expect(ctx.get("marker-obj")).toBe("obj");

    class ClassPlugin {
      static name = "cls-plugin";
      constructor(inner: Context) {
        inner.provide("marker-cls", "cls");
      }
    }
    await ctx.plugin(ClassPlugin as unknown as (ctx: Context) => void);
    expect(ctx.get("marker-cls")).toBe("cls");
  });

  it("模块命名导出形态（name/inject/Config/apply）", async () => {
    const { ctx } = createRoot();
    const module: Record<string, unknown> = {
      name: "named-plugin",
      inject: ["logger"],
      apply(inner: Context) {
        expect(inner.logger.info).toBeTypeOf("function");
        inner.provide("used", true);
      },
    };
    await ctx.plugin(module as never);
    expect(ctx.get("used")).toBe(true);
  });

  it("非法插件形态 fail loud", () => {
    const { ctx } = createRoot();
    expect(() => ctx.plugin({ noApply: true } as never)).toThrow(/invalid plugin/);
  });

  it("Config 校验失败：await 上抛，fiber 进入 failed", async () => {
    const { ctx } = createRoot();
    const fiber = ctx.plugin({
      Config: Schema.object({ level: Schema.number().required() }),
      apply() {},
    });
    await expect(fiber).rejects.toThrow(/config validation failed/);
    const unwrapped = fiber as unknown as { state: string };
    await flush();
    expect(unwrapped.state).toBe("failed");
  });

  it("异步 Config 校验拒绝（上游同款 TypeError）", async () => {
    const { ctx } = createRoot();
    const asyncConfig = {
      "~standard": {
        version: 1 as const,
        validate: () => Promise.resolve({ value: 1 }),
      },
    };
    await expect(ctx.plugin({ Config: asyncConfig, apply() {} })).rejects.toThrow(/Async config validation/);
  });

  it("插件体返回的 thenable 会被 await（异步 apply 的注册先于激活完成，异步抛错落 failed）", async () => {
    const { ctx } = createRoot();
    const order: string[] = [];
    const fiber = ctx.plugin(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      order.push("apply done");
    });
    await fiber;
    expect(order).toEqual(["apply done"]);
    expect((fiber as unknown as { state: string }).state).toBe("active");

    const failing = ctx.plugin(async () => {
      await Promise.resolve();
      throw new Error("async apply boom");
    });
    await expect(failing).rejects.toThrow("async apply boom");
    expect((failing as unknown as { state: string }).state).toBe("failed");
  });
});

describe("cordis-shim inject 硬依赖", () => {
  it("缺失依赖 → pending 不激活；provide 后激活", async () => {
    const { ctx } = createRoot();
    let activated = false;
    const fiber = ctx.plugin({ inject: ["tools"], apply() { activated = true; } });
    await flush();
    expect(activated).toBe(false);
    expect(fiber.state).toBe("pending");
    ctx.provide("tools", { register() {} });
    await vi.waitFor(() => expect(activated).toBe(true));
    expect(fiber.state).toBe("active");
  });

  it("依赖被移除 → 插件卸载（effect 回滚），回到 pending", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const removeService = ctx.provide("svc", {});
    const fiber = ctx.plugin({
      inject: ["svc"],
      apply(inner) {
        log.push("start");
        inner.effect(() => () => log.push("stop"));
      },
    });
    await vi.waitFor(() => expect(fiber.state).toBe("active"));
    expect(log).toEqual(["start"]);
    removeService();
    await vi.waitFor(() => expect(log).toEqual(["start", "stop"]));
    await vi.waitFor(() => expect(fiber.state).toBe("pending"));
  });

  it("插件 A 提供的服务供插件 B 消费；A 卸载 → B 回滚", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const provider = ctx.plugin({
      name: "provider",
      apply(inner) {
        inner.provide("shared", { api: 1 });
        inner.effect(() => () => log.push("provider-stop"));
      },
    });
    const consumer = ctx.plugin({
      name: "consumer",
      inject: ["shared"],
      apply(inner) {
        log.push(`consume:${JSON.stringify(inner.get("shared"))}`);
        inner.effect(() => () => log.push("consumer-stop"));
      },
    });
    await vi.waitFor(() => expect(consumer.state).toBe("active"));
    expect(log).toEqual(['consume:{"api":1}']);
    await provider.dispose();
    // 上游 reflect.provide 语义：provider 自身 effect 先回滚，provide disposer 等依赖者卸载完成
    expect(log).toEqual(['consume:{"api":1}', "provider-stop", "consumer-stop"]);
  });

  it("root 提供的服务可被插件消费", async () => {
    const { ctx } = createRoot();
    ctx.provide("root-svc", "r");
    const fiber = ctx.plugin({ inject: ["root-svc"], apply() {} });
    await vi.waitFor(() => expect(fiber.state).toBe("active"));
  });
});

describe("cordis-shim effect 与 provide 归属", () => {
  it("effect：立即执行；disposer 幂等；fiber 卸载逆序回滚", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const fiber = ctx.plugin((inner) => {
      inner.effect(() => {
        log.push("e1-setup");
        return () => log.push("e1-stop");
      }, "e1");
      inner.effect(() => () => log.push("e2-stop"), "e2");
    });
    await flush();
    // effect 立即执行 setup；disposer 尚未触发
    expect(log).toEqual(["e1-setup"]);
    await fiber.dispose();
    expect(log).toEqual(["e1-setup", "e2-stop", "e1-stop"]);
    // 再 dispose 幂等
    await fiber.dispose();
    expect(log).toEqual(["e1-setup", "e2-stop", "e1-stop"]);
  });

  it("effect：Promise / 迭代器形态", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const fiber = ctx.plugin((inner) => {
      inner.effect(async () => () => log.push("async-stop"));
      inner.effect(() => {
        return [() => log.push("it-1"), () => log.push("it-2")][Symbol.iterator]();
      });
    });
    await flush();
    await fiber.dispose();
    expect(log).toEqual(["it-2", "it-1", "async-stop"]);
  });

  it("effect：非法返回形态 → fiber 启动失败（TypeError Invalid effect）", async () => {
    const { ctx } = createRoot();
    const fiber = ctx.plugin((inner) => {
      inner.effect((() => ({ not: "disposable" })) as never);
    });
    await expect(fiber).rejects.toThrow(TypeError);
    const unwrapped = fiber as unknown as { state: string };
    await flush();
    expect(unwrapped.state).toBe("failed");
  });

  it("已卸载 fiber 上注册 effect 抛 INACTIVE_EFFECT", async () => {
    const { ctx } = createRoot();
    const fiber = ctx.plugin(() => {});
    await flush();
    await fiber.dispose();
    const pluginCtx = fiber.ctx;
    expect(() => pluginCtx.effect(() => () => {})).toThrow(CordisError);
  });

  it("provide 归属当前 fiber；重复注册报错；set 越权报错", () => {
    const { ctx } = createRoot();
    ctx.provide("x", 1);
    expect(() => ctx.provide("x", 2)).toThrow(/has been registered/);
    expect(ctx.get("x")).toBe(1);
    // 内建 logger 不可被 set（非本 fiber 提供）
    expect(() => { (ctx as unknown as { logger: unknown }).logger = 1; }).toThrow(/multiple fibers/);
  });

  it("provide 返回的 disposer 移除服务", () => {
    const { ctx } = createRoot();
    const disposer = ctx.provide("x", 1);
    disposer();
    expect(ctx.get("x")).toBeUndefined();
  });

  it("Service 基类：构造即注册，随插件卸载移除", async () => {
    const { ctx } = createRoot();
    class MyService extends Service {
      value = 42;
    }
    const fiber = ctx.plugin((inner) => {
      void new MyService(inner, "my-svc");
    });
    await flush();
    expect((ctx.get("my-svc") as unknown as MyService).value).toBe(42);
    await fiber.dispose();
    expect(ctx.get("my-svc")).toBeUndefined();
  });
});

describe("cordis-shim 事件系统", () => {
  it("emit：同步派发，返回值被忽略", () => {
    const { ctx } = createRoot();
    const log: number[] = [];
    ctx.on("e", () => log.push(1));
    ctx.on("e", () => log.push(2));
    ctx.emit("e");
    expect(log).toEqual([1, 2]);
  });

  it("parallel：全并发等待；失败聚合为 AggregateError", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("e", async () => { await flush(); log.push("a"); });
    ctx.on("e", async () => { log.push("b"); });
    await ctx.parallel("e");
    expect(log).toEqual(["b", "a"]);
    ctx.on("boom", () => { throw new Error("x"); });
    await expect(ctx.parallel("boom")).rejects.toBeInstanceOf(AggregateError);
  });

  it("serial：依序 await，bail 即停（null/false 继续）", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("e", async () => { await flush(); log.push("a"); return null; });
    ctx.on("e", async () => { log.push("b"); return undefined; });
    ctx.on("e", () => { log.push("c"); return 42; });
    ctx.on("e", () => { log.push("d"); });
    expect(await ctx.serial("e")).toBe(42);
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("bail：serial 的同步版本", () => {
    const { ctx } = createRoot();
    ctx.on("e", () => undefined);
    ctx.on("e", () => "hit");
    ctx.on("e", () => "unreached");
    expect(ctx.bail("e")).toBe("hit");
  });

  it("waterfall：外层包裹内层 next；无监听器直达内建", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("wf", async (payload: { value: number }, next: () => Promise<{ value: number }>) => {
      log.push("outer");
      const result = await next();
      return { value: result.value + 1 };
    });
    ctx.on("wf", (payload: { value: number }, next: () => Promise<{ value: number }>) => {
      log.push("inner");
      return next();
    });
    const result = await ctx.waterfall("wf", { value: 1 }, () => Promise.resolve({ value: 10 }));
    expect(log).toEqual(["outer", "inner"]);
    expect(result).toEqual({ value: 11 });
    expect(ctx.waterfall("empty", 1, 2, () => "built-in")).toBe("built-in");
  });

  it("waterfall：不调用 next 即否决后续链与内建行为", async () => {
    const { ctx } = createRoot();
    ctx.on("veto", (payload: { ok: boolean }, next: () => unknown) => {
      if (payload.ok) return next();
      return { vetoed: true };
    });
    ctx.on("veto", (payload: { ok: boolean }, next: () => unknown) => next());
    expect(await ctx.waterfall("veto", { ok: false }, () => {
      throw new Error("must be vetoed");
    })).toEqual({ vetoed: true });
    expect(await ctx.waterfall("veto", { ok: true }, () => "built-in")).toBe("built-in");
  });

  it("on 返回 boolean 型 disposer；prepend 生效；once 只触发一次", () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    ctx.on("e", () => log.push("tail"));
    const disposeHead = ctx.on("e", () => log.push("head"), true);
    ctx.emit("e");
    expect(log).toEqual(["head", "tail"]);
    expect(disposeHead()).toBe(true);
    expect(disposeHead()).toBe(false);
    ctx.emit("e");
    expect(log).toEqual(["head", "tail", "tail"]);

    let onceCount = 0;
    ctx.once("o", () => onceCount++);
    ctx.emit("o");
    ctx.emit("o");
    expect(onceCount).toBe(1);
  });

  it("插件卸载自动移除其监听器", async () => {
    const { ctx } = createRoot();
    let calls = 0;
    const fiber = ctx.plugin((inner) => {
      inner.on("evt", () => calls++);
    });
    await flush();
    ctx.emit("evt");
    expect(calls).toBe(1);
    await fiber.dispose();
    ctx.emit("evt");
    expect(calls).toBe(1);
  });

  it("isBailed：非 null/false/undefined 即 bail", () => {
    expect(isBailed(0)).toBe(true);
    expect(isBailed("")).toBe(true);
    expect(isBailed(null)).toBe(false);
    expect(isBailed(false)).toBe(false);
    expect(isBailed(undefined)).toBe(false);
  });
});

describe("cordis-shim 服务仓库与 context", () => {
  it("属性读取走服务仓库；root 可自由挂属性", () => {
    const { ctx } = createRoot();
    ctx.provide("demo", { hello: 1 });
    expect(ctx.get("demo")).toEqual({ hello: 1 });
    expect((ctx as unknown as Record<string, unknown>).demo).toEqual({ hello: 1 });
    expect((ctx as unknown as Record<string, unknown>).missing).toBeUndefined();
    (ctx as unknown as Record<string, unknown>).arbitrary = 1;
    expect((ctx as unknown as Record<string, unknown>).arbitrary).toBe(1);
  });

  it("extend：子 context 继承服务，meta 遮蔽", () => {
    const { ctx } = createRoot();
    ctx.provide("svc", "base");
    const child = ctx.extend({ marker: "child" });
    expect((child as unknown as Record<string, unknown>).svc).toBe("base");
    expect((child as unknown as Record<string, unknown>).marker).toBe("child");
    expect(Context.is(child)).toBe(true);
    expect(Context.is({})).toBe(false);
  });

  it("内建 logger：命名实例 + 等级过滤 + sink 落消息", () => {
    const { ctx, messages } = createRoot();
    ctx.logger.info("hello");
    ctx.logger.error("oops");
    const named: LoggerMessage[] = [];
    createLogger("plugin-a", { export: message => named.push(message) }).warn("careful");
    expect(messages.map(message => `${message.name}:${message.type}`)).toEqual(["app:info", "app:error"]);
    expect(named.map(message => `${message.name}:${message.type}`)).toEqual(["plugin-a:warn"]);
    const levels = createLogger("muted", { export: () => { throw new Error("must not export"); }, levels: { default: 30 } });
    levels.debug("suppressed");
  });

  it("root dispose 级联卸载全部插件；卸载后 plugin() 报错", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    await ctx.plugin((inner) => {
      inner.effect(() => () => log.push("p1-stop"));
    });
    await ctx.plugin((inner) => {
      inner.effect(() => () => log.push("p2-stop"));
    });
    await ctx.dispose();
    expect(log).toEqual(["p2-stop", "p1-stop"]);
    expect(() => ctx.plugin(() => {})).toThrow(CordisError);
  });

  it("插件内再加载插件：父插件卸载级联子插件（逆注册序，上游同款）", async () => {
    const { ctx } = createRoot();
    const log: string[] = [];
    const parent = ctx.plugin((inner) => {
      inner.plugin((child) => {
        child.effect(() => () => log.push("child-stop"));
      });
      inner.effect(() => () => log.push("parent-stop"));
    });
    await flush();
    await parent.dispose();
    expect(log).toEqual(["parent-stop", "child-stop"]);
  });
});
