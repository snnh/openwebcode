// dsh 兼容层 M3 fixture：tools/pre-execute 与 tools/post-execute 瀑布（经 root ctx 的 agent 钩子桥投影）。
// - pre-execute：deny_tool → deny；ask_tool → ask（v1 降级为放行 + 审计）；其余 → next()（allow）
// - post-execute：变换_tool → accept 替换内容；block_tool → block 转错误；其余保持原样
export const name = "hook-prepost";
export const inject = [];

export function apply(ctx) {
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec?.name === "deny_tool") return { kind: "deny", reason: "被 hook-prepost 禁止" };
    if (exec?.name === "ask_tool") return { kind: "ask", reason: "需要人工确认（测试 ask 降级）" };
    return next();
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    if (exec?.name === "transform_tool") return { kind: "accept", content: "已被 post-execute 变换" };
    if (exec?.name === "block_tool") return { kind: "block", feedback: "结果被 post-execute 否决" };
    return next();
  });
}
