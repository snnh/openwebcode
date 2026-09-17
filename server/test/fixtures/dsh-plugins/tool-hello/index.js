// dsh 兼容层 fixture：工具注册——正常结果、抛错结果、参数校验、超时预算、配置消费。
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "tool-hello";
export const inject = ["tools"];

// 异步 apply：fiber 激活前会 await 插件体（上游同款），因此注册后的工具在首次同步即可见。
export async function apply(ctx, config) {
  const suffix = typeof config.suffix === "string" ? config.suffix : ".";
  await Promise.resolve();

  ctx.get("tools").register(defineTool({
    name: "hello_greet",
    description: "按插件配置打招呼",
    timeoutMs: 7000,
    parameters: {
      who: { type: "string", required: true, description: "打招呼对象" },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: (args) => ({ text: `hello, ${args.who}${suffix}` }),
  }));

  ctx.get("tools").register(defineTool({
    name: "hello_fail",
    description: "总是抛错（isError 链路）",
    parameters: {},
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: () => {
      throw new Error("boom from fixture");
    },
  }));
}
