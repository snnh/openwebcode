import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShellFlavor } from "./agent/shell-detect.js";
import { runHost } from "./python-env.js";
import type { NodeEnv } from "./sessions/types.js";

/** 会话值优先，全局默认其次，最终回退本机环境。 */
export function effectiveNodeEnv(sessionValue: NodeEnv | undefined, globalDefault: NodeEnv | undefined): NodeEnv {
  return sessionValue ?? globalDefault ?? "global";
}

/** 沙盒系统树（bwrap ro-bind / Landlock read-exec 已放行）：落在这些前缀下的工具链无需额外挂载。 */
const SYSTEM_TOOLCHAIN_PREFIXES = ["/usr", "/bin", "/lib", "/lib64", "/etc", "/sys"];

export interface NodeToolchainMountDeps {
  platform?: NodeJS.Platform;
  home?: string;
  /** 宿主 PATH（缺省 process.env.PATH）。 */
  pathEnv?: string;
  /** 缺省 $NVM_DIR ?? ~/.nvm。 */
  nvmDir?: string;
  /** 缺省 $FNM_DIR 优先于内置候选。 */
  fnmDir?: string;
  exists?: (target: string) => boolean;
  realpath?: (target: string) => string;
}

/**
 * 与 nodeEnv 选择绑定的工具链只读挂载目录（POSIX；bwrap/Landlock 经 readOnlyPaths 放行，
 * fs.* 工具的路径策略不含 readOnlyPaths，工具层读不到内容。Windows 无文件系统隔离，不追加）：
 * - global：解析宿主 PATH 上实际生效的 node/npm 所在 bin 目录（realpath 跟随软链），
 *   挂载其工具链根（<root>/bin → <root>，npm 软链到 lib/node_modules 仍可解析）；
 *   落在系统树内的跳过（已放行）。用户的"全局" node 实为 nvm/fnm 安装时由此获得可见性；
 * - nvm：$NVM_DIR（nvm.sh + versions 全量只读，激活前缀 source nvm.sh 才能工作）；
 * - fnm：$FNM_DIR 或内置候选（~/.local/share/fnm 含 fnm 二进制与版本、~/.fnm）；
 * - project：空（node_modules/.bin 在工作区内，随 writeRoots 可见）。
 */
export function nodeToolchainReadOnlyPaths(mode: NodeEnv, deps: NodeToolchainMountDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return [];
  const home = deps.home ?? os.homedir();
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? ((target: string) => realpathSync(target));
  // 本函数只服务 POSIX 沙盒（win32 已早退）：PATH 与目录拼接一律按 POSIX 语义（path.posix），
  // 与平台无关、可注入确定性测试；os.homedir()/env 提供的目录在 POSIX 宿主上本来就是 POSIX 路径。
  if (mode === "project") return [];
  if (mode === "nvm") {
    const nvmDir = deps.nvmDir ?? process.env.NVM_DIR ?? path.posix.join(home, ".nvm");
    return exists(path.posix.join(nvmDir, "nvm.sh")) ? [nvmDir] : [];
  }
  if (mode === "fnm") {
    const candidates = [deps.fnmDir ?? process.env.FNM_DIR, path.posix.join(home, ".local", "share", "fnm"), path.posix.join(home, ".fnm")]
      .filter((dir): dir is string => typeof dir === "string" && dir !== "");
    const result: string[] = [];
    for (const candidate of candidates) {
      if (!result.includes(candidate) && exists(candidate)) result.push(candidate);
    }
    return result;
  }
  // global：PATH 上首个含 node 或 npm 的 bin 目录即 shell 实际生效的工具链
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  const roots: string[] = [];
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    if (!exists(path.posix.join(dir, "node")) && !exists(path.posix.join(dir, "npm"))) continue;
    let binDir = dir;
    try { binDir = realpath(dir); } catch { /* 目录不可解析时按原样尽力挂载 */ }
    const root = path.posix.basename(binDir) === "bin" ? path.posix.dirname(binDir) : binDir;
    // /bin 等目录的"根"会算成 /：挂载 / 等于全盘只读，必须排除（系统树本已放行）
    if (root === "/" || SYSTEM_TOOLCHAIN_PREFIXES.some((prefix) => root === prefix || root.startsWith(`${prefix}/`))) continue;
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
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
