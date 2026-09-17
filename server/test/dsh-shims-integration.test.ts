/** dsh 垫片集成冒烟（M1）：三垫片协同承载一个典型 dsh Host 插件（tool-cordis 式写法） */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "../src/dsh/cordis-shim.js";
import { Context as CordisContext } from "../src/dsh/cordis-shim.js";
import { defineTool } from "../src/dsh/dsh-tools-shim.js";
import type { ToolDefinition } from "../src/dsh/dsh-tools-shim.js";
import Schema from "../src/dsh/schemastery-shim.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** 模拟一个真实 dsh 插件模块的 named exports 形态。 */
const helloToolModule = {
  name: "hello-tool",
  inject: ["tools"],
  Config: Schema.object({
    greeting: Schema.string().default("hello"),
    strict: Schema.boolean().default(false),
  }),
  apply(ctx: Context, config: { greeting: string; strict: boolean }) {
    const tool: ToolDefinition = defineTool({
      name: "hello_greet",
      description: "打招呼",
      parameters: {
        who: { type: "string", required: true, description: "对象" },
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: String((value as { text: string }).text) }],
      },
      execute: async args => ({ text: `${config.greeting}, ${args.who}${config.strict ? "!" : "."}` }),
    });
    ctx.get("tools").register(tool);

    // pre-step 瀑布：命中关键词时短路（不调用 next 即否决）
    ctx.on("agent/pre-step", async (payload: { text: string }, next: () => Promise<string>) => {
      if (payload.text === "block") return "blocked-by-plugin";
      return next();
    });

    ctx.effect(() => () => {
      ctx.get("tools").unregister("hello_greet");
    }, "hello-tool: cleanup");
  },
};

describe("dsh 垫片集成冒烟", () => {
  it("安装 → Config 默认值 → 工具注入 → 瀑布钩子 → 卸载回滚", async () => {
    const registered = new Map<string, ToolDefinition>();
    const ctx = new CordisContext({ logger: { export: () => {} } });
    ctx.provide("tools", {
      register: (tool: ToolDefinition) => registered.set(tool.name, tool),
      unregister: (name: string) => registered.delete(name),
    });

    const fiber = ctx.plugin(helloToolModule as never);
    await vi.waitFor(() => expect(fiber.state).toBe("active"));

    // Config 默认值生效
    const tool = registered.get("hello_greet");
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ who: "owc" }, { signal: new AbortController().signal })) as { text: string };
    expect(result.text).toBe("hello, owc.");

    // 参数校验先于 execute
    await expect(tool!.execute({}, { signal: new AbortController().signal })).rejects.toThrow(/who/);

    // 瀑布钩子：放行走内建，命中关键词短路
    const pass = await ctx.waterfall("agent/pre-step", { text: "go" }, () => Promise.resolve("built-in"));
    expect(pass).toBe("built-in");
    const blocked = await ctx.waterfall("agent/pre-step", { text: "block" }, () => Promise.resolve("built-in"));
    expect(blocked).toBe("blocked-by-plugin");

    // 卸载：effect 回滚清空工具表，监听器随 fiber 移除
    await fiber.dispose();
    expect(registered.size).toBe(0);
    const after = await ctx.waterfall("agent/pre-step", { text: "block" }, () => Promise.resolve("built-in"));
    expect(after).toBe("built-in");
  });

  it("Config 校验失败 → 插件不激活、工具不注入", async () => {
    const registered = new Map<string, ToolDefinition>();
    const ctx = new CordisContext({ logger: { export: () => {} } });
    ctx.provide("tools", {
      register: (tool: ToolDefinition) => registered.set(tool.name, tool),
      unregister: (name: string) => registered.delete(name),
    });
    await expect(ctx.plugin({ ...helloToolModule, Config: Schema.object({ greeting: Schema.number().required() }) } as never))
      .rejects.toThrow(/config validation failed/);
    await flush();
    expect(registered.size).toBe(0);
  });
});
