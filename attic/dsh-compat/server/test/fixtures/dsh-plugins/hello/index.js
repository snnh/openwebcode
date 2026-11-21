// dsh 兼容层 fixture：最小插件——Config 默认值、cordis Context 形态、可逆 effect。
import { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";

export const name = "hello";
export const Config = Schema.object({
  greeting: Schema.string().default("hello"),
});

export function apply(ctx, config) {
  if (!Context.is(ctx)) throw new Error("插件 ctx 不是 cordis Context");
  ctx.logger.info(`hello fixture 已挂载：${config.greeting}`);
  ctx.effect(() => () => {}, "hello: cleanup");
}
