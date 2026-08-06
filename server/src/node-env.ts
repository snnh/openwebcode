import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShellFlavor } from "./agent/shell-detect.js";
import { runHost } from "./python-env.js";
import type { NodeEnv } from "./sessions/types.js";

/** 会话值优先，全局默认其次，最终回退本机环境。 */
export function effectiveNodeEnv(sessionValue: NodeEnv | undefined, globalDefault: NodeEnv | undefined): NodeEnv {
  return sessionValue ?? globalDefault ?? "global";
}

/** project 模式的 bin 目录：项目工作区 node_modules/.bin；其余模式无目录前置。 */
export function nodeBinDir(mode: NodeEnv, cwd: string): string | undefined {
  if (mode === "project") return path.join(cwd, "node_modules", ".bin");
  return undefined;
}

/**
 * nodeEnv 的 shell 激活片段（不含用户命令）；null = 该 shell/平台组合不支持。
 * project = node_modules/.bin 前置 PATH（语法与 python-env.ts 的 wrapCommandWithVenv 对齐）；
 * fnm/nvm = 版本管理器激活前缀（fnm 不支持 cmd；nvm 仅 POSIX bash/sh）。
 */
export function nodeEnvActivationCommand(
  flavor: ShellFlavor,
  mode: NodeEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (mode === "global") return null;
  if (mode === "project") {
    if (flavor === "pwsh") {
      const join = platform === "win32" ? path.win32.join : path.posix.join;
      const dir = join(cwd, "node_modules", ".bin");
      const separator = platform === "win32" ? ";" : ":";
      return `$env:Path = '${dir.replace(/'/g, "''")}${separator}' + $env:Path`;
    }
    if (flavor === "cmd") return `set "PATH=${path.win32.join(cwd, "node_modules", ".bin")};%PATH%"`;
    // sh：Windows Git Bash 下反斜杠须换为正斜杠（bash 里 \ 是转义符）
    const dir = platform === "win32"
      ? path.win32.join(cwd, "node_modules", ".bin").replace(/\\/g, "/")
      : path.posix.join(cwd, "node_modules", ".bin");
    return `export PATH='${dir.replace(/'/g, `'\\''`)}':$PATH`;
  }
  if (mode === "fnm") {
    if (flavor === "cmd") return null;
    if (flavor === "pwsh") return "fnm env --shell powershell | Out-String | Invoke-Expression; fnm use 2>$null | Out-Null";
    return 'eval "$(fnm env --shell bash)"; fnm use >/dev/null 2>&1';
  }
  // nvm：仅 POSIX bash/sh（Windows/pwsh/cmd 无 nvm.sh 可 source）
  if (platform === "win32" || flavor !== "sh") return null;
  return 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use >/dev/null 2>&1';
}

/**
 * bash 命令包装：global 原样返回；其余模式前置激活片段。
 * 返回 null = 当前 shell/平台不支持该模式，由调用方走 wrapCommandWithNote 回退。
 */
export function wrapCommandWithNodeEnv(
  cmd: string,
  mode: NodeEnv,
  cwd: string,
  flavor: ShellFlavor,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (mode === "global") return cmd;
  const activation = nodeEnvActivationCommand(flavor, mode, cwd, platform);
  if (activation === null) return null;
  // cmd 无 `;` 语句分隔符，PATH 设置后用 && 串联（与 wrapCommandWithVenv 对齐）
  return flavor === "cmd" ? `${activation} && ${cmd}` : `${activation}; ${cmd}`;
}

export interface NodeEnvEnsureResult {
  ok: boolean;
  note?: string;
}

/**
 * Node 版本管理器的懒检测（host 侧 spawn/查文件，与 hooks 同级可信）。
 * 同一模式并发共享一次检测；成功缓存，失败下次重试。
 * runHostCommand/nvmScriptPath 可注入，便于测试。
 */
export class NodeEnvManagers {
  private readonly pending = new Map<string, Promise<NodeEnvEnsureResult>>();
  private readonly readyModes = new Set<string>();

  constructor(
    private readonly runHostCommand: typeof runHost = runHost,
    private readonly nvmScriptPath: string = path.join(os.homedir(), ".nvm", "nvm.sh"),
  ) {}

  async ensure(mode: NodeEnv, flavor: ShellFlavor, platform: NodeJS.Platform = process.platform): Promise<NodeEnvEnsureResult> {
    if (mode === "global" || mode === "project") return { ok: true };
    if (mode === "fnm" && flavor === "cmd") {
      return { ok: false, note: "fnm activation is not supported for cmd, using the host node environment" };
    }
    if (mode === "nvm" && (platform === "win32" || flavor !== "sh")) {
      return { ok: false, note: "nvm is only supported in POSIX bash/sh shells, using the host node environment" };
    }
    if (this.readyModes.has(mode)) return { ok: true };
    let pending = this.pending.get(mode);
    if (!pending) {
      pending = this.doEnsure(mode);
      this.pending.set(mode, pending);
    }
    try {
      const result = await pending;
      if (result.ok) this.readyModes.add(mode);
      return result;
    } finally {
      this.pending.delete(mode);
    }
  }

  private async doEnsure(mode: NodeEnv): Promise<NodeEnvEnsureResult> {
    if (mode === "fnm") {
      const version = await this.runHostCommand("fnm", ["--version"], 15_000);
      if (version.code !== 0) return { ok: false, note: "fnm is not available on PATH, using the host node environment" };
      return { ok: true };
    }
    // nvm
    if (!existsSync(this.nvmScriptPath)) {
      return { ok: false, note: "nvm is not installed (~/.nvm/nvm.sh not found), using the host node environment" };
    }
    return { ok: true };
  }
}
