// dsh 兼容层 fixture：本插件不应被加载（依赖 @deepseek-ai/dsh-session，翻译层未提供该服务缝）。
export const name = "incompatible-dep";

export function apply() {
  throw new Error("本插件不应被激活");
}
