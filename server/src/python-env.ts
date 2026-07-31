import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PythonEnv, ShellBackend } from "./sessions/types.js";

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
 * bash 命令包装：venv 的 Scripts/bin 前置 PATH。不走 activate 脚本——
 * cmd/pwsh/sh 三种 shell 语法一致且避开 pwsh 执行策略问题。
 */
export function wrapCommandWithVenv(cmd: string, venvDir: string, shellBackend: ShellBackend, platform: NodeJS.Platform = process.platform): string {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform === "win32") {
    const scripts = join(venvDir, "Scripts");
    if (shellBackend === "pwsh") return `$env:Path = '${scripts.replace(/'/g, "''")};' + $env:Path; ${cmd}`;
    return `set "PATH=${scripts};%PATH%" && ${cmd}`;
  }
  const bin = join(venvDir, "bin");
  return `export PATH='${bin.replace(/'/g, `'\\''`)}':$PATH; ${cmd}`;
}

/**
 * uv 不可用/建环境失败时的回退包装：命令仍在本机环境执行，输出前置一行说明。
 * note 可能含 uv stderr 摘录（非 server 生成），拼进三种 shell 的命令行前必须
 * 剥离 shell 元字符（$ ` & | ; < > " ' % 换行等），防注入与语法破坏。
 */
function sanitizeNote(note: string): string {
  const cleaned = note.replace(/[^A-Za-z0-9 _.,:/\\()[\]+\-]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "uv environment unavailable, using the host python environment";
}

export function wrapCommandWithNote(cmd: string, note: string): string {
  return `echo [openwebcode] ${sanitizeNote(note)} && ${cmd}`;
}

export interface UvEnsureResult {
  ok: boolean;
  note?: string;
}

function runHost(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
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
 * uv 虚拟环境的懒创建（host 侧 spawn；命令完全由 server 生成，不含模型输入，
 * 与 hooks 同级可信）。同一目录并发共享一次创建；成功缓存，失败下次重试。
 */
export class UvPythonEnvironments {
  private readonly pending = new Map<string, Promise<UvEnsureResult>>();
  private readonly readyDirs = new Set<string>();

  async ensure(venvDir: string): Promise<UvEnsureResult> {
    if (this.readyDirs.has(venvDir)) return { ok: true };
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
    const version = await runHost("uv", ["--version"], 15_000);
    if (version.code !== 0) return { ok: false, note: "uv is not available on PATH, using the host python environment" };
    const scriptsDir = process.platform === "win32" ? "Scripts" : "bin";
    const pythonExe = process.platform === "win32" ? "python.exe" : "python";
    if (existsSync(path.join(venvDir, scriptsDir, pythonExe))) return { ok: true };
    const created = await runHost("uv", ["venv", venvDir], 120_000);
    if (created.code !== 0 || !existsSync(path.join(venvDir, scriptsDir, pythonExe))) {
      return { ok: false, note: `uv venv failed${created.stderr ? ` (${created.stderr.slice(0, 200)})` : ""}, using the host python environment` };
    }
    return { ok: true };
  }
}
