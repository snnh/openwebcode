import path from "node:path";
import type { SandboxPolicy } from "./types.js";

/** 默认沙盒拒绝清单：见 defaultSandboxPolicy 注释。 */
function defaultSandboxDenyPaths(cwd: string): string[] {
  return [
    path.join(cwd, ".env"),
    path.join(cwd, ".owc", "hooks.json"),
    path.join(cwd, ".owc", "mcp.json"),
  ];
}

/**
 * 默认沙盒策略：工作区可读写，但拒绝覆盖宿主执行入口配置——
 * .env（凭据）、.owc/hooks.json 与 .owc/mcp.json（hooks/MCP 配置每次事件现读
 * 并在宿主执行，被 agent 覆写即沙盒逃逸 RCE）。
 * Windows 文件系统大小写不敏感，core 侧 deny 匹配需按平台语义处理大小写，
 * 这里只列规范小写路径。
 */
export function defaultSandboxPolicy(cwd: string): SandboxPolicy {
  return {
    enabled: true,
    readRoots: [cwd],
    writeRoots: [cwd],
    denyPaths: defaultSandboxDenyPaths(cwd),
    network: "allow",
  };
}
