import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * 聊天模式 Python 环境：uv 管理的独立 venv（默认 <dataDir>/chat-python-env）。
 * ensure() 幂等且并发安全（复用同一 Promise）；失败时重置，下次调用可重试。
 */
export class ChatPythonEnv {
  /** 默认 venv 目录名（与 AGENTS.md 对齐）。 */
  static readonly DEFAULT_DIR_NAME = "chat-python-env";

  /** 按数据目录构造默认实例。 */
  static forDataDir(dataDir: string, libraries: string[] | (() => Promise<string[]>)): ChatPythonEnv {
    return new ChatPythonEnv(path.join(dataDir, ChatPythonEnv.DEFAULT_DIR_NAME), libraries);
  }

  private ready: Promise<void> | null = null;

  constructor(
    private readonly venvPath: string,
    /** 预装库清单：数组直接用；函数在 ensure() 首次建环境时才求值（惰性读取配置）。 */
    private readonly libraries: string[] | (() => Promise<string[]>),
  ) {}

  async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = this.create().catch((error) => {
        // 失败不留缓存，下次 ensure 重新尝试（如 uv 刚装好、网络恢复）
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private async create(): Promise<void> {
    const python = this.pythonPath();
    // venv 复用：解释器存在且可运行则跳过 uv venv/pip install；损坏则整体重建
    if (await this.isUsable(python)) return;
    const libraries = typeof this.libraries === "function" ? await this.libraries() : this.libraries;
    await rm(this.venvPath, { recursive: true, force: true });
    await mkdir(this.venvPath, { recursive: true });
    await this.run("uv", ["venv", this.venvPath, "--python", "3.12"]);
    if (libraries.length > 0) {
      await this.run("uv", ["pip", "install", "--python", python, ...libraries]);
    }
  }

  /** 解释器存在且 `--version` 可正常退出即视为可用。 */
  private async isUsable(python: string): Promise<boolean> {
    if (!existsSync(python)) return false;
    try {
      await this.run(python, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  pythonPath(): string {
    return path.join(this.venvPath, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }

  get dir(): string {
    return this.venvPath;
  }

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-500)}`));
      });
      proc.on("error", reject);
    });
  }
}
