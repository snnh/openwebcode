import { existsSync } from "node:fs";
import path from "node:path";
import type { CoreShellBackend, ShellBackend } from "../sessions/types.js";

/**
 * Shell 探测与解析（单一来源）：会话存的 shellBackend 是用户意图（default/pwsh/bash/cmd），
 * 本模块把它解析成具体解释器。Windows 顺序 pwsh > Git Bash > cmd（cmd 仅兜底）；
 * POSIX 顺序 bash > pwsh > $SHELL（/bin/sh 兜底）。进程级一次探测并缓存。
 *
 * Git Bash 必须解析为 bash.exe 绝对路径：PATH 里的裸 "bash" 可能命中
 * System32\bash.exe（WSL 启动器），语义完全不同。
 */

/** 语法族：持久 shell 的 sentinel/init/venv 语法与一次性包装都按族生成。 */
export type ShellFlavor = "pwsh" | "cmd" | "sh";
/** 实际选中的解释器种类（工具描述与展示用）。 */
export type ShellKind = "pwsh" | "git-bash" | "cmd" | "bash" | "sh";

export interface ResolvedShell {
  kind: ShellKind;
  flavor: ShellFlavor;
  /** pty 直接 spawn 的可执行文件（Git Bash 为绝对路径，pwsh/cmd 可为 PATH 名）。 */
  executable: string;
  /** 下发 core exec.run / job.start 的 shellBackend。 */
  coreBackend: CoreShellBackend;
  /** coreBackend="bash" 且探测到绝对路径时随请求下发（core 不再自行 PATH 搜索）。 */
  shellPath?: string;
}

/** 宿主探测结果：值为绝对路径。 */
export interface HostShellProbe {
  pwsh?: string;
  /** Windows Git Bash（已排除 WSL）。 */
  gitBash?: string;
  /** POSIX bash。 */
  posixBash?: string;
}

type EnvLike = Record<string, string | undefined>;
type ExistsFn = (path: string) => boolean;

/** PATH 变量名在 Windows 上大小写不定（Path/PATH），与 sanitizedCoreEnv 同款处理。 */
function pathValue(env: EnvLike): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return (key ? env[key] : undefined) ?? "";
}

function findOnPath(env: EnvLike, executable: string, exists: ExistsFn, platform: NodeJS.Platform, skip?: (fullPath: string) => boolean): string | undefined {
  const separator = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  for (const dir of pathValue(env).split(separator)) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    if (skip?.(candidate)) continue;
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Git Bash 探测：PATH 中的 bash.exe（排除 System32 的 WSL 启动器），再查常见安装路径。 */
function detectGitBash(env: EnvLike, exists: ExistsFn): string | undefined {
  const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  const wslDir = path.win32.join(systemRoot, "System32").toLowerCase();
  const onPath = findOnPath(env, "bash.exe", exists, "win32", (candidate) =>
    path.win32.dirname(candidate).replace(/\//g, "\\").toLowerCase() === wslDir);
  if (onPath) return onPath;
  const candidates = ["C:\\Program Files\\Git\\bin\\bash.exe"];
  if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** 纯探测（可注入 env/exists 供单测）。 */
export function detectHostShells(platform: NodeJS.Platform, env: EnvLike, exists: ExistsFn): HostShellProbe {
  if (platform === "win32") {
    const pwsh = findOnPath(env, "pwsh.exe", exists, platform);
    const gitBash = detectGitBash(env, exists);
    return { ...(pwsh ? { pwsh } : {}), ...(gitBash ? { gitBash } : {}) };
  }
  const posixBash = findOnPath(env, "bash", exists, platform) ?? (exists("/bin/bash") ? "/bin/bash" : undefined);
  const pwsh = findOnPath(env, "pwsh", exists, platform);
  return { ...(posixBash ? { posixBash } : {}), ...(pwsh ? { pwsh } : {}) };
}

let cachedProbe: HostShellProbe | undefined;

/** 进程级探测缓存：shell 安装在进程生命周期内不变。 */
function hostShells(): HostShellProbe {
  cachedProbe ??= detectHostShells(process.platform, process.env, existsSync);
  return cachedProbe;
}

function windowsShell(backend: ShellBackend, probe: HostShellProbe): ResolvedShell {
  const pwsh: ResolvedShell = { kind: "pwsh", flavor: "pwsh", executable: probe.pwsh ?? "pwsh", coreBackend: "pwsh" };
  const cmd: ResolvedShell = { kind: "cmd", flavor: "cmd", executable: "cmd.exe", coreBackend: "default" };
  const gitBash = (): ResolvedShell => ({
    kind: "git-bash",
    flavor: "sh",
    executable: probe.gitBash ?? "bash",
    coreBackend: "bash",
    ...(probe.gitBash ? { shellPath: probe.gitBash } : {}),
  });
  if (backend === "pwsh") return pwsh;
  if (backend === "bash") return gitBash();
  if (backend === "cmd") return cmd;
  // default：pwsh > Git Bash > cmd（cmd 仅兜底）
  if (probe.pwsh) return pwsh;
  if (probe.gitBash) return gitBash();
  return cmd;
}

function posixShell(backend: ShellBackend, probe: HostShellProbe, env: EnvLike): ResolvedShell {
  const bash: ResolvedShell = { kind: "bash", flavor: "sh", executable: probe.posixBash ?? "bash", coreBackend: "bash" };
  const pwsh: ResolvedShell = { kind: "pwsh", flavor: "pwsh", executable: probe.pwsh ?? "pwsh", coreBackend: "pwsh" };
  const fallback = env.SHELL?.trim() ? env.SHELL.trim() : "/bin/sh";
  const sh: ResolvedShell = { kind: "sh", flavor: "sh", executable: fallback, coreBackend: "default" };
  if (backend === "pwsh") return pwsh;
  if (backend === "bash") return bash;
  if (backend === "cmd") return sh; // cmd 仅 Windows 存在；POSIX 上按平台兜底处理
  // default：bash > pwsh > $SHELL（/bin/sh 兜底）
  if (probe.posixBash) return bash;
  if (probe.pwsh) return pwsh;
  return sh;
}

/** 纯解析（可注入 probe/platform/env 供单测）。 */
export function resolveShellFrom(
  backend: ShellBackend,
  probe: HostShellProbe,
  platform: NodeJS.Platform,
  env: EnvLike,
): ResolvedShell {
  return platform === "win32" ? windowsShell(backend, probe) : posixShell(backend, probe, env);
}

/** 会话 shellBackend → 实际解释器（进程级缓存探测）。 */
export function resolveShell(backend: ShellBackend): ResolvedShell {
  return resolveShellFrom(backend, hostShells(), process.platform, process.env);
}

/** exec.run / job.start 的 shell 字段（可直接展开进请求）。 */
export function coreExecShell(backend: ShellBackend): { shellBackend: CoreShellBackend; shellPath?: string } {
  const shell = resolveShell(backend);
  return { shellBackend: shell.coreBackend, ...(shell.shellPath ? { shellPath: shell.shellPath } : {}) };
}
