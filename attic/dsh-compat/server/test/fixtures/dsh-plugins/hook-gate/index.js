// dsh 兼容层 fixture：事件监听——拦截 tools/pre-execute 瀑布（deny 短路），并暴露一个自检工具。
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "hook-gate";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec?.name === "blocked_tool") return { kind: "deny", reason: "该工具在本插件中被禁止" };
    return next();
  });

  ctx.get("tools").register(defineTool({
    name: "gate_check",
    description: "触发 tools/pre-execute 瀑布并回报裁决",
    parameters: {
      tool: { type: "string", required: true, description: "被检查的工具名" },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const verdict = await ctx.waterfall("tools/pre-execute", { name: args.tool }, async () => ({ kind: "allow" }));
      return { kind: verdict?.kind ?? "allow", reason: verdict?.reason ?? "" };
    },
  }));
}
