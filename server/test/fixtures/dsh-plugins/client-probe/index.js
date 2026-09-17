// dsh 兼容层 fixture：双面包的 host 半边（client 半边由 M4 的 /plugins 路由投递，本里程碑只解析入口）。
export const name = "client-probe";

export function apply(ctx) {
  ctx.effect(() => () => {}, "client-probe");
}
