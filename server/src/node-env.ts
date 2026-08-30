import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShellFlavor } from "./agent/shell-detect.js";
import { runHostResolving } from "./python-env.js";
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
  /** POSIX 缺省 $NVM_DIR ?? ~/.nvm；win32 缺省 $NVM_HOME ?? %APPDATA%\nvm。 */
  nvmDir?: string;
  /** 缺省 $FNM_DIR 优先于内置候选（POSIX ~/.local/share/fnm、~/.fnm；win32 %LOCALAPPDATA%\fnm）。 */
  fnmDir?: string;
  exists?: (target: string) => boolean;
  realpath?: (target: string) => string;
}

/**
 * 与 nodeEnv 选择绑定的工具链只读挂载目录（bwrap/Landlock 经 readOnlyPaths 放行，
 * fs.* 工具的路径策略不含 readOnlyPaths，工具层读不到内容。Windows 是否挂载由调用方
 * 按生效沙盒模式门禁——仅 AppContainer 档需要，Job Object 无文件隔离）：
 * 仅服务 global（本机环境，保持既有行为）：解析宿主 PATH 上实际生效的 node/npm 所在 bin
 * 目录（realpath 跟随软链），挂载其工具链根（<root>/bin → <root>，npm 软链到
 * lib/node_modules 仍可解析）；落在系统树内的跳过（已放行）。用户的"全局" node 实为
 * nvm/fnm 安装时由此获得可见性。
 * fnm/nvm 走读写层（见 nodeToolchainWritePaths）；project 为空（node_modules/.bin 在工作区内）。
 */
export function nodeToolchainReadOnlyPaths(mode: NodeEnv, deps: NodeToolchainMountDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? ((target: string) => realpathSync(target));
  if (mode !== "global") return [];
  if (platform === "win32") {
    // win32：PATH 按 ; 分隔、node.exe/npm.cmd 判定。AppContainer 的不可见区是用户 profile——
    // 系统级安装（Program Files 等）本就可见，无需挂载；只放行 profile 下的工具链根
    // （fnm/nvm 管理的 node 与全局安装）。条目本身（fnm multishell 等 junction）也并入：
    // core 侧对 reparse point 同时授权链接本体与 target 树（sandbox_win.c grant_read_only_paths）。
    const home = (deps.home ?? os.homedir()).toLowerCase();
    const roots: string[] = [];
    for (const dir of (deps.pathEnv ?? process.env.PATH ?? "").split(";").filter(Boolean)) {
      if (!exists(path.win32.join(dir, "node.exe")) && !exists(path.win32.join(dir, "npm.cmd"))) continue;
      let binDir = dir;
      try { binDir = realpath(dir); } catch { /* 目录不可解析时按原样尽力挂载 */ }
      const root = path.win32.basename(binDir) === "bin" ? path.win32.dirname(binDir) : binDir;
      const lower = root.toLowerCase();
      // 盘根（C:\）排除：全盘只读授权会把用户 profile 一并打开
      if (lower !== home && !lower.startsWith(`${home}\\`)) continue;
      if (!roots.includes(root)) roots.push(root);
      if (dir !== root && !roots.includes(dir)) roots.push(dir);
    }
    return roots;
  }
  // 本函数其余部分只服务 POSIX 沙盒：PATH 与目录拼接一律按 POSIX 语义（path.posix），
  // 与平台无关、可注入确定性测试；os.homedir()/env 提供的目录在 POSIX 宿主上本来就是 POSIX 路径。
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

/**
 * 显式选择的非本机 node 环境的工具链读写挂载目录（bwrap rw-bind / Landlock 完整
 * 访问集，经 allowPaths 下发。Windows 是否挂载由调用方按生效沙盒模式门禁——仅 AppContainer
 * 档需要，用户 profile 对沙盒不可见；Job Object 无文件隔离）：
 * 读写与安装权限严格限定在版本管理器自身目录——npm i -g / fnm install / nvm install
 * 都落在该目录内；系统树只读、HOME 不挂载，整机全局安装在沙盒内不可能。
 * - nvm：$NVM_DIR（nvm.sh + versions 全量读写，激活前缀 source nvm.sh 才能工作）；
 *   win32（nvm-windows）：$NVM_HOME 或 %APPDATA%\nvm（nvm.exe + settings.txt + versions）。
 * - fnm：$FNM_DIR 或内置候选（POSIX ~/.local/share/fnm 含 fnm 二进制与版本、~/.fnm；
 *   win32 %LOCALAPPDATA%\fnm）；
 * - global/project：空（global 走只读层；project 的 node_modules/.bin 在工作区内）。
 */
export function nodeToolchainWritePaths(mode: NodeEnv, deps: NodeToolchainMountDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const exists = deps.exists ?? existsSync;
  if (platform === "win32") {
    if (mode === "fnm") {
      const candidates = [deps.fnmDir ?? process.env.FNM_DIR, path.win32.join(home, "AppData", "Local", "fnm")]
        .filter((dir): dir is string => typeof dir === "string" && dir !== "");
      const result: string[] = [];
      for (const candidate of candidates) {
        if (!result.includes(candidate) && exists(candidate)) result.push(candidate);
      }
      return result;
    }
    if (mode === "nvm") {
      const nvmDir = deps.nvmDir ?? process.env.NVM_HOME ?? path.win32.join(home, "AppData", "Roaming", "nvm");
      return exists(path.win32.join(nvmDir, "nvm.exe")) ? [nvmDir] : [];
    }
    return [];
  }
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
  return [];
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

interface NodeEnvEnsureResult {
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
    private readonly runHostCommand: typeof runHostResolving = runHostResolving,
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
