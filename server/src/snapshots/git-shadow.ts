import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreClientLike } from "../core-client.js";
import { collectJobJsonLines } from "../rpc/job-collect.js";
import { isCheckpoint, truncateLines, type Checkpoint, type SnapshotBackend } from "./backend.js";

export type { Checkpoint } from "./backend.js";

export interface GitShadowOptions {
  /** 会话 id：index.scan 的策略快照来源（denyPaths 生效的前提）。 */
  sessionId?: string;
  /** core RPC 客户端：scanWorkspace 走有界扫描原语（index.scan），替代 Node 直遍历。 */
  core?: CoreClientLike;
  /** 会话 deny 路径（绝对路径）：core 扫描自动跳过；restore 的 clean 同样排除，避免快照未捕获的文件被删。 */
  denyPaths?: readonly string[];
  /** 会话 contextExcludes（glob）：无通配符的字面模式按目录名排除（与 repo map/索引同一份用户配置）。 */
  contextExcludes?: readonly string[];
}

export class GitShadowSnapshots implements SnapshotBackend {
  static readonly MAX_FILES = 100_000;
  static readonly MAX_BYTES = 2 * 1024 * 1024 * 1024;
  /** index.scan 预算：节点数（含目录）与毫秒。文件上限由 MAX_FILES 在收集侧兜底。 */
  static readonly SCAN_MAX_NODES = 200_000;
  static readonly SCAN_MAX_MS = 30_000;
  readonly name = "git-shadow";
  private readonly gitDir: string;
  private readonly metadataPath: string;
  private excludes = [".git", "node_modules", ".owc", ".openwebcode"];

  constructor(
    private readonly sessionRoot: string,
    private readonly workspace: string,
    private readonly options: GitShadowOptions = {},
  ) {
    this.gitDir = path.join(sessionRoot, "shadow.git");
    this.metadataPath = path.join(sessionRoot, "checkpoints.json");
    for (const pattern of this.options.contextExcludes ?? []) {
      // 与 repo map/索引同一份用户配置；快照排除保守：只采纳无通配符的字面模式
      if (!/[*?[\]{}]/.test(pattern) && !this.excludes.includes(pattern)) this.excludes.push(pattern);
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    try {
      await readFile(path.join(this.gitDir, "HEAD"), "utf8");
    } catch {
      await this.git(["init", "--bare", this.gitDir], false);
    }
    // 会话目录（sessionRoot）在工作区内时，把它排除出快照（影子仓库与检查点元数据不入快照）
    const sessionRelative = path.relative(this.workspace, this.sessionRoot);
    if (sessionRelative && !sessionRelative.startsWith("..") && !path.isAbsolute(sessionRelative)) {
      const topLevel = sessionRelative.split(/[\\/]/, 1)[0];
      if (topLevel && !this.excludes.includes(topLevel)) this.excludes = [...this.excludes, topLevel];
    }
    await writeFile(path.join(this.gitDir, "info", "exclude"), `${this.excludes.map((item) => `${item}/`).join("\n")}\n`, "utf8");
  }

  async capability(): Promise<{ backend: string; costHint: "linear"; requiresAdmin: false }> {
    await this.git(["--version"], false);
    return { backend: "git-shadow", costHint: "linear", requiresAdmin: false };
  }

  async create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint> {
    await this.initialize();
    const files = await this.scanWorkspace();
    await this.git(["add", "-u"]);
    for (let index = 0; index < files.length; index += 200) {
      await this.git(["add", "-f", "--", ...files.slice(index, index + 200)]);
    }
    await this.git(["commit", "--allow-empty", "-m", label], true);
    const id = (await this.git(["rev-parse", "HEAD"])).trim();
    const checkpoint: Checkpoint = {
      id,
      label,
      createdAt: new Date().toISOString(),
      messageCount,
      ...(ledger === undefined ? {} : { ledger }),
    };
    const checkpoints = await this.list();
    checkpoints.push(checkpoint);
    await this.save(checkpoints);
    return checkpoint;
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const value = JSON.parse(await readFile(this.metadataPath, "utf8")) as unknown;
      return Array.isArray(value) ? value.filter(isCheckpoint) : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async diff(id: string): Promise<string> {
    validateId(id);
    // stat 摘要之后附完整 unified diff（有界截断），供 Web 统一 diff 视图做 hunk 解析与"恢复到此 hunk"
    const stat = await this.git(["diff", "--stat", id]);
    const full = await this.git(["diff", id]);
    return truncateLines(`${stat.trimEnd()}\n\n${full}`.trim(), 4000);
  }

  async restore(id: string): Promise<void> {
    validateId(id);
    await this.initialize();
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    // 空树检查点（空工作区快照，--allow-empty 提交）：checkout 的 pathspec 匹配不到任何文件会报错，
    // 此时跳过 checkout，仅靠 clean 把工作区回滚到空状态。
    const tree = await this.git(["ls-tree", "-r", "--name-only", id]);
    if (tree.trim()) await this.git(["checkout", "-f", id, "--", "."]);
    // clean 排除 = 快照 excludes（目录）+ 会话 deny 路径（快照扫描跳过、未捕获，restore 不得删除）
    const cleanExcludes = [
      ...this.excludes.map((item) => `${item}/`),
      ...this.denyPathRelatives(),
    ];
    await this.git(["clean", "-fdx", ...cleanExcludes.flatMap((item) => ["-e", item])], false);
  }

  async delete(id: string): Promise<void> {
    validateId(id);
    const checkpoints = await this.list();
    await this.save(checkpoints.filter((item) => item.id !== id));
  }

  async cleanup(): Promise<void> {
    await rm(this.gitDir, { recursive: true, force: true });
  }

  /** 会话 deny 路径中落在 workspace 内的部分（相对路径）：restore 的 clean 排除项。 */
  private denyPathRelatives(): string[] {
    const relatives: string[] = [];
    for (const denyPath of this.options.denyPaths ?? []) {
      const relative = path.relative(this.workspace, denyPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      // 不带斜杠的 gitignore 模式同时匹配文件与目录（deny 路径可能是文件如 .env）
      relatives.push(relative);
    }
    return relatives;
  }

  /**
   * 收集工作区文件清单（相对 workspace 路径）。
   *
   * 走 core 的 index.scan 有界递归扫描原语：路径策略（denyPaths）一致、内存有界、
   * 排除在 C 侧完成——替代旧的 Node readdir+lstat 直遍历（绕过路径策略，有界性靠自己维护）。
   * 仅需 path+size，不需要 sha256：maxBytes 是哈希字节预算（core 最小 1），传 1 即跳过哈希。
   * 扫描被截断（truncated）或超限（files/bytes）一律抛错：快照不完整比失败更危险。
   */
  async scanWorkspace(): Promise<string[]> {
    const { sessionId, core } = this.options;
    // 生产路径总是有 core（getSnapshotBackend 注入）；缺失/残缺仅出现在测试与异常场景，回退 Node 遍历
    if (!sessionId || !core || typeof core.startIndexScan !== "function") return this.scanWorkspaceFallback();
    const files: string[] = [];
    let bytes = 0;
    const jobId = `shadow-${randomUUID()}`;
    await core.startIndexScan({
      sessionId,
      jobId,
      kind: "index.scan",
      cwd: this.workspace,
      path: ".",
      exclude: this.excludes,
      maxDepth: 64,
      maxNodes: GitShadowSnapshots.SCAN_MAX_NODES,
      maxBytes: 1,
      maxMs: GitShadowSnapshots.SCAN_MAX_MS,
    });
    const { summary } = await collectJobJsonLines(
      core,
      sessionId,
      jobId,
      new AbortController().signal,
      "index.scan",
      (line) => {
        const record = JSON.parse(line) as { path?: unknown; size?: unknown };
        if (typeof record.path !== "string") return; // summary 行
        files.push(record.path);
        bytes += typeof record.size === "number" ? record.size : 0;
        if (files.length > GitShadowSnapshots.MAX_FILES) {
          throw new Error(`Checkpoint exceeds ${GitShadowSnapshots.MAX_FILES} files`);
        }
        if (bytes > GitShadowSnapshots.MAX_BYTES) {
          throw new Error(`Checkpoint exceeds ${GitShadowSnapshots.MAX_BYTES} bytes`);
        }
      },
    );
    if (summary?.truncated) throw new Error(`Checkpoint workspace scan truncated: ${String(summary.reason ?? "limit")}`);
    return files;
  }

  /**
   * 无 core 时的回退：Node readdir+lstat 直遍历（core 缺失/残缺仅出现在测试与异常场景）。
   * 生产路径总是走 index.scan（有界原语 + 路径策略一致）；回退路径与旧实现行为完全一致。
   */
  private async scanWorkspaceFallback(): Promise<string[]> {
    const files: string[] = [];
    let bytes = 0;
    const visit = async (relative: string): Promise<void> => {
      const entries = await readdir(path.join(this.workspace, relative), { withFileTypes: true });
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (this.excludes.some((excluded) => child === excluded || child.startsWith(`${excluded}/`))) continue;
        const stat = await lstat(path.join(this.workspace, child));
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await visit(child);
          continue;
        }
        files.push(child);
        bytes += stat.size;
        if (files.length > GitShadowSnapshots.MAX_FILES) {
          throw new Error(`Checkpoint exceeds ${GitShadowSnapshots.MAX_FILES} files`);
        }
        if (bytes > GitShadowSnapshots.MAX_BYTES) {
          throw new Error(`Checkpoint exceeds ${GitShadowSnapshots.MAX_BYTES} bytes`);
        }
      }
    };
    await visit("");
    return files;
  }

  private git(args: string[], commit = false): Promise<string> {
    const command = args[0] === "init" || args[0] === "--version" ? args : ["--git-dir", this.gitDir, "--work-tree", this.workspace, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn("git", command, {
        cwd: this.workspace,
        windowsHide: true,
        env: commit
          ? {
              ...process.env,
              GIT_AUTHOR_NAME: "OpenWebCode",
              GIT_AUTHOR_EMAIL: "openwebcode@localhost",
              GIT_COMMITTER_NAME: "OpenWebCode",
              GIT_COMMITTER_EMAIL: "openwebcode@localhost",
            }
          : process.env,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code: number | null) =>
        code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`)),
      );
    });
  }

  private async save(checkpoints: Checkpoint[]): Promise<void> {
    await writeFile(this.metadataPath, `${JSON.stringify(checkpoints, null, 2)}\n`, "utf8");
  }
}

function validateId(id: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error("Invalid checkpoint ID");
}
