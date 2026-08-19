import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ShellFlavor } from "./agent/shell-detect.js";
import { wellKnownBinPaths } from "./host-env.js";
import type { PythonEnv } from "./sessions/types.js";

/** 会话值优先，全局默认其次，最终回退本机环境。 */
export function effectivePythonEnv(sessionValue: PythonEnv | undefined, globalDefault: PythonEnv | undefined): PythonEnv {
  return sessionValue ?? globalDefault ?? "global";
}

/** uv 模式的 venv 目录：uv-workspace 在项目工作区，uv-config 在数据目录（按工作区路径哈希隔离）。 */
export function uvVenvDir(mode: PythonEnv, cwd: string, dataDir: string | undefined): string | undefined {
  if (mode === "uv-workspace") return path.join(cwd, ".owc", "venv");
  if (mode === "uv-config" && dataDir) {
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    return path.join(dataDir, "venvs", hash);
  }
  return undefined;
}

/**
 * 非本机 python 环境的读写挂载目录（POSIX 沙盒经 allowPaths 下发；bwrap rw-bind /
 * Landlock 完整访问集。Windows 无文件系统隔离，不追加）：仅 uv-config 的 venv 目录——
 * 它在数据目录下，沙盒只挂载工作区与系统树，不挂载则激活静默失效；读写权限限定在
 * venv 自身（pip install 落在 venv 内；系统 site-packages 只读，全局安装不可能）。
 * uv-workspace 的 venv 在工作区内（随 writeRoots 可写可见），global 无挂载。
 */
export function pythonEnvWritePaths(mode: PythonEnv, cwd: string | undefined, dataDir: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32" || !cwd || mode !== "uv-config") return [];
  const venv = uvVenvDir(mode, cwd, dataDir);
  return venv ? [venv] : [];
}

/**
 * bash 命令包装：venv 的 Scripts/bin 前置 PATH。不走 activate 脚本——
 * cmd/pwsh/sh 三种语法族一致且避开 pwsh 执行策略问题。
 */
export function wrapCommandWithVenv(cmd: string, venvDir: string, flavor: ShellFlavor, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const scripts = path.win32.join(venvDir, "Scripts");
    if (flavor === "pwsh") return `$env:Path = '${scripts.replace(/'/g, "''")};' + $env:Path; ${cmd}`;
    if (flavor === "cmd") return `set "PATH=${scripts};%PATH%" && ${cmd}`;
    // Git Bash：反斜杠换正斜杠（bash 里 \ 是转义符）
    return `export PATH='${scripts.replace(/\\/g, "/").replace(/'/g, `'\\''`)}':$PATH; ${cmd}`;
  }
  const bin = path.posix.join(venvDir, "bin");
  return `export PATH='${bin.replace(/'/g, `'\\''`)}':$PATH; ${cmd}`;
}

/**
 * uv 不可用/建环境失败时的回退包装：命令仍在本机环境执行，输出前置一行说明。
 * note 可能含 uv stderr 摘录（非 server 生成），拼进三种 shell 的命令行前必须
 * 剥离 shell 元字符（$ ` & | ; < > " ' % 换行等），防注入与语法破坏。
 */
function sanitizeNote(note: string): string {
  const cleaned = note.replace(/[^A-Za-z0-9 _.,:/\\()[\]+-]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "uv environment unavailable, using the host python environment";
}

export function wrapCommandWithNote(cmd: string, note: string): string {
  const prefix = "echo [openwebcode] ";
  // 叠加多个环境回退说明（如 nodeEnv + pythonEnv 同时不可用）时合并进同一条 echo，避免 echo && echo 串联
  if (cmd.startsWith(prefix)) return `${prefix}${sanitizeNote(note)}; ${cmd.slice(prefix.length)}`;
  return `${prefix}${sanitizeNote(note)} && ${cmd}`;
}

/** venv 内 python 可执行文件路径（存在性探测共用）。 */
function pythonExePath(venvDir: string): string {
  return path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
}

interface UvEnsureResult {
  ok: boolean;
  note?: string;
}

/** host 侧命令探测（uv/fnm 等版本管理器可用性检测共用；命令完全由 server 生成，不含模型输入）。 */
export function runHost(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, stderr: string): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr });
    };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      finish(null, "spawn failed");
      return;
    }
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(null, "timed out");
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      finish(null, "spawn failed");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code, stderr.trim());
    });
  });
}

/**
 * 带常见安装位置回退的宿主探测：systemd/Docker 等最小环境的 PATH 不含用户级
 * bin（uv/fnm 常装在 ~/.local/bin），PATH 查找 spawn 失败时按序尝试绝对路径候选
 *（host-env.ts 的 wellKnownBinPaths）。spawn 成功（code 非 null，无论退出码）即返回。
 */
export async function runHostResolving(
  command: string,
  args: string[],
  timeoutMs: number,
  candidates: string[] = wellKnownBinPaths(command),
): Promise<{ code: number | null; stderr: string }> {
  const first = await runHost(command, args, timeoutMs);
  if (first.code !== null) return first;
  for (const candidate of candidates) {
    const result = await runHost(candidate, args, timeoutMs);
    if (result.code !== null) return result;
  }
  return first;
}

/**
 * uv 虚拟环境的懒创建（host 侧 spawn；命令完全由 server 生成，不含模型输入，
 * 与 hooks 同级可信）。同一目录并发共享一次创建；成功缓存，失败下次重试。
 */
export class UvPythonEnvironments {
  private readonly pending = new Map<string, Promise<UvEnsureResult>>();
  private readonly readyDirs = new Set<string>();

  async ensure(venvDir: string): Promise<UvEnsureResult> {
    // 成功缓存命中也复查 python 可执行文件仍在（用户可能手动删了 venv；每次建壳仅多一次 stat）
    if (this.readyDirs.has(venvDir) && existsSync(pythonExePath(venvDir))) return { ok: true };
    this.readyDirs.delete(venvDir);
    let pending = this.pending.get(venvDir);
    if (!pending) {
      pending = this.doEnsure(venvDir);
      this.pending.set(venvDir, pending);
    }
    try {
      const result = await pending;
      if (result.ok) this.readyDirs.add(venvDir);
      return result;
    } finally {
      this.pending.delete(venvDir);
    }
  }

  private async doEnsure(venvDir: string): Promise<UvEnsureResult> {
    const version = await runHostResolving("uv", ["--version"], 15_000);
    if (version.code !== 0) return { ok: false, note: "uv is not available on PATH, using the host python environment" };
    if (existsSync(pythonExePath(venvDir))) return { ok: true };
    const created = await runHostResolving("uv", ["venv", venvDir], 120_000);
    if (created.code !== 0 || !existsSync(pythonExePath(venvDir))) {
      return { ok: false, note: `uv venv failed${created.stderr ? ` (${created.stderr.slice(0, 200)})` : ""}, using the host python environment` };
    }
    return { ok: true };
  }
}
