/** dsh 垫片集成冒烟（M1）：三垫片协同承载一个典型 dsh Host 插件（tool-cordis 式写法）。 */
import { describe, expect, it, vi } from "vitest";
import { Context as CordisContext, type Context } from "../src/dsh/cordis-shim.js";
import { defineTool, type ToolDefinition } from "../src/dsh/dsh-tools-shim.js";
import Schema from "../src/dsh/schemastery-shim.js";

/** 模拟真实 dsh 插件模块的 named exports 形态。 */
const helloToolModule = {
  name: "hello-tool",
  inject: ["tools"],
  Config: Schema.object({ greeting: Schema.string().default("hello"), strict: Schema.boolean().default(false) }),
  apply(ctx: Context, config: { greeting: string; strict: boolean }) {
    ctx.get("tools").register(defineTool({
      name: "hello_greet",
      description: "打招呼",
      parameters: { who: { type: "string", required: true, description: "对象" } },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: String((value as { text: string }).text) }],
      },
      execute: async (args) => ({ text: `${config.greeting}, ${args.who}${config.strict ? "!" : "."}` }),
    }));
    // pre-step 瀑布：命中关键词时短路（不调用 next 即否决）
    ctx.on("agent/pre-step", async (payload: { text: string }, next: () => Promise<string>) =>
      payload.text === "block" ? "blocked-by-plugin" : next());
    ctx.effect(() => () => ctx.get("tools").unregister("hello_greet"), "hello-tool: cleanup");
  },
};

function host() {
  const registered = new Map<string, ToolDefinition>();
  const ctx = new CordisContext({ logger: { export: () => {} } });
  ctx.provide("tools", {
    register: (tool: ToolDefinition) => registered.set(tool.name, tool),
    unregister: (name: string) => registered.delete(name),
  });
  return { ctx, registered };
}

describe("dsh 垫片集成冒烟", () => {
  it("安装 → Config 默认值 → 工具注入与参数校验 → 瀑布钩子 → 卸载回滚", async () => {
    const { ctx, registered } = host();
    const fiber = ctx.plugin(helloToolModule as never);
    await vi.waitFor(() => expect(fiber.state).toBe("active"));

    const tool = registered.get("hello_greet");
    expect(tool).toBeDefined();
    const call = (args: Record<string, unknown>) => tool!.execute(args, { signal: new AbortController().signal });
    await expect(call({ who: "owc" })).resolves.toEqual({ text: "hello, owc." }); // Config 默认值生效
    await expect(call({})).rejects.toThrow(/who/); // 参数校验先于 execute

    const waterfall = (text: string) => ctx.waterfall("agent/pre-step", { text }, () => Promise.resolve("built-in"));
    await expect(waterfall("go")).resolves.toBe("built-in"); // 放行走内建
    await expect(waterfall("block")).resolves.toBe("blocked-by-plugin"); // 短路否决

    await fiber.dispose(); // effect 回滚清空工具表，监听器随 fiber 移除
    expect(registered.size).toBe(0);
    await expect(waterfall("block")).resolves.toBe("built-in");
  });

  it("Config 校验失败 → 插件不激活、工具不注入", async () => {
    const { ctx, registered } = host();
    await expect(ctx.plugin({ ...helloToolModule, Config: Schema.object({ greeting: Schema.number().required() }) } as never))
      .rejects.toThrow(/config validation failed/);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(registered.size).toBe(0);
  });
});
