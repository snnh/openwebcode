// dsh 兼容层 fixture：Config 校验——端口必须是数字，测试用 dsh.json 喂入非法值。
import Schema from "@deepseek-ai/schemastery";

export const name = "config-fail";
export const Config = Schema.object({
  port: Schema.number().required(),
});

export function apply(ctx) {
  ctx.effect(() => () => {}, "config-fail");
}
