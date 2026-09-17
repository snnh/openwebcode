// dsh 兼容层 fixture：硬依赖未提供的服务（fs 服务缝不在 v1 范围）→ 插件保持 pending 不激活。
export const name = "missing-service";
export const inject = ["fs"];

export function apply() {
  throw new Error("本插件不应被激活");
}
