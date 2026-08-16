import type { SessionMeta } from "../sessions/types.js";
import type { ShellFlavor } from "./shell-detect.js";

/**
 * 会话元数据环境变量（参照 pi 的 environment variables 设计）：注入 agent bash 工具的执行环境，
 * 使脚本/hooks 能感知会话上下文。core 的 exec.run 协议无 env 字段，故与 python venv/node env
 * 一样走 shell 包装：持久 shell 开启时激活一次，一次性 exec 回退路径作为最内层包装逐命令拼上。
 * 值全部由 server 生成（可信），仍按三种语法族严格转义（与 wrapCommandWithVenv 同款）。
 */

/** 会话元数据环境变量清单（顺序固定，便于测试与文档对齐）。 */
function sessionEnvVars(meta: Pick<SessionMeta, "id" | "cwd" | "sandboxMode" | "agentMode">, platform: NodeJS.Platform = process.platform): Array<[string, string]> {
  return [
    ["OWC_SESSION_ID", meta.id],
    ["OWC_WORKSPACE", meta.cwd],
    // 缺省按平台分流：win32 缺省 jobobject，POSIX 缺省 landlock 档（与 UI/policyFor 的缺省语义一致）
    ["OWC_SANDBOX_MODE", meta.sandboxMode ?? (platform === "win32" ? "jobobject" : "landlock")],
    ["OWC_AGENT_MODE", meta.agentMode ?? "code"],
  ];
}

/**
 * 会话元数据环境变量的 shell 激活片段（不含用户命令）：
 * pwsh `$env:VAR = '...'`、cmd `set "VAR=..."`（`&` 串联）、sh `export VAR='...'`（单条 export 多赋值）。
 * 单引号转义与 wrapCommandWithVenv 对齐（pwsh `''`、sh `'\''`）；win32 下 sh（Git Bash）反斜杠换正斜杠。
 */
export function sessionEnvActivationCommand(
  meta: Pick<SessionMeta, "id" | "cwd" | "sandboxMode" | "agentMode">,
  flavor: ShellFlavor,
  platform: NodeJS.Platform = process.platform,
): string {
  const vars = sessionEnvVars(meta, platform);
  if (flavor === "pwsh") {
    return vars.map(([key, value]) => `$env:${key} = '${value.replace(/'/g, "''")}'`).join("; ");
  }
  if (flavor === "cmd") {
    return vars.map(([key, value]) => `set "${key}=${value}"`).join(" & ");
  }
  // sh：win32（Git Bash）下值内反斜杠换正斜杠（bash 里 \ 是转义符）
  const assignments = vars.map(([key, value]) => {
    const normalized = platform === "win32" ? value.replace(/\\/g, "/") : value;
    return `${key}='${normalized.replace(/'/g, `'\\''`)}'`;
  });
  return `export ${assignments.join(" ")}`;
}

/**
 * bash 命令包装：会话元数据激活片段前置（一次性 exec 回退路径的最内层包装，
 * 随后再被 node/python 环境包装包住）。cmd 无 `;` 语句分隔符，set 之后用 && 串联。
 */
export function wrapCommandWithSessionEnv(
  cmd: string,
  meta: Pick<SessionMeta, "id" | "cwd" | "sandboxMode" | "agentMode">,
  flavor: ShellFlavor,
  platform: NodeJS.Platform = process.platform,
): string {
  const activation = sessionEnvActivationCommand(meta, flavor, platform);
  return flavor === "cmd" ? `${activation} && ${cmd}` : `${activation}; ${cmd}`;
}
