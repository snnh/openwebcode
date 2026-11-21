// dsh 兼容层 M3 fixture：cordis timer 服务——ctx.timeout 纯延迟等待（fiber effect，卸载自动清理）。
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "timer-user";
export const inject = ["tools", "timer"];

export function apply(ctx) {
  ctx.get("tools").register(defineTool({
    name: "timer_wait",
    description: "经 cordis timer 等待指定毫秒",
    parameters: { ms: { type: "integer", required: true } },
    output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
    execute: async (args) => {
      await ctx.get("timer").timeout(args.ms);
      return { waited: args.ms };
    },
  }));
}
