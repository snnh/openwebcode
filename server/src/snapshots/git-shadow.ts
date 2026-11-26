import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreClientLike } from "../core-client.js";
import { errorMessage } from "../error-utils.js";
import { collectJobJsonLines } from "../rpc/job-collect.js";
import { readCheckpoints, truncateLines, writeCheckpoints, type Checkpoint, type SnapshotBackend } from "./backend.js";
import { captureDenyFiles, denyPathInsideWorkspace, restoreDenyFiles } from "./deny-preserve.js";

/** git 失败信息只保留前 64 KiB：异常仓库可能一次吐出非常大的诊断文本。 */
const MAX_STDERR_BYTES = 64 * 1024;

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
  static readonly SCAN_MAX_DEPTH = 64;
  static readonly SCAN_MAX_MS = 30_000;
  readonly name = "git-shadow";
  private readonly gitDir: string;
  private readonly metadataPath: string;
  private readonly denyRelatives: readonly string[];
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
    this.denyRelatives = relativeDenyPaths(this.workspace, this.options.denyPaths ?? []);
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    try {
      await readFile(path.join(this.gitDir, "HEAD"), "utf8");
    } catch {
      await this.git(["init", "--bare", this.gitDir], false);
    }
    // 影子仓库固定使用空的 hooks 目录：用户全局 core.hooksPath 不应影响自动快照。
    await mkdir(path.join(this.gitDir, "no-hooks"), { recursive: true });
    // 会话目录（sessionRoot）在工作区内时，把它排除出快照（影子仓库与检查点元数据不入快照）
    const sessionRelative = path.relative(this.workspace, this.sessionRoot);
    if (sessionRelative && !isOutsideRelative(sessionRelative)) {
      const topLevel = sessionRelative.split(/[\\/]/, 1)[0];
      if (topLevel && !this.excludes.includes(topLevel)) this.excludes = [...this.excludes, topLevel];
    }
    // 排除项同时可能是目录或字面文件（contextExcludes 未带通配符），不能一律追加 `/`：
    // `secret.txt/` 不匹配文件，会让 restore 的 clean 误删它。
    await writeFile(path.join(this.gitDir, "info", "exclude"), `${this.excludes.join("\n")}\n`, "utf8");
  }

  async capability(): Promise<{ backend: string; costHint: "linear"; requiresAdmin: false }> {
    await this.git(["--version"], false);
    return { backend: "git-shadow", costHint: "linear", requiresAdmin: false };
  }

  async create(label: string, messageCount: number, ledger?: unknown, activeLeafId?: string): Promise<Checkpoint> {
    await this.initialize();
    const files = await this.scanWorkspace();
    await this.git(["add", "-u"]);
    // `add -u` 只认「已跟踪」：检查点创建后才被加入 deny/contextExcludes 的路径改动
    // 仍会被暂存进快照（跟踪是历史事实，扫描侧的排除管不到暂存区）。这里用 pathspec
    // 精准把这些排除项从暂存区撤出；下面的 add -f 只加扫描到的文件，排除项不进快照。
    await this.unstageExcluded();
    // 一次 git 进程经 stdin 收全部路径：10 万文件不再拆成数百次 spawn，也绕开
    // Windows 命令行长度上限。NUL 分隔可安全承载空格/换行/非 ASCII 文件名。
    if (files.length > 0) {
      await this.git(["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], false, {
        input: `${files.join("\0")}\0`,
      });
    }
    // 用户全局 git 配置可能开启 GPG 签名/提交钩子；影子仓库的提交必须无交互且可预期。
    await this.git([
      "-c", "commit.gpgsign=false",
      "-c", `core.hooksPath=${path.join(this.gitDir, "no-hooks")}`,
      "commit", "--allow-empty", "--no-verify", "-m", label,
    ], true);
    const id = (await this.git(["rev-parse", "HEAD"])).trim();
    const checkpoint: Checkpoint = {
      id,
      label,
      createdAt: new Date().toISOString(),
      messageCount,
      ...(activeLeafId === undefined ? {} : { activeLeafId }),
      ...(ledger === undefined ? {} : { ledger }),
    };
    const checkpoints = await this.list();
    checkpoints.push(checkpoint);
    await this.save(checkpoints);
    return checkpoint;
  }

  async list(): Promise<Checkpoint[]> {
    // 与 btrfs/zfs/overlayfs 共用解析；strict 只把缺失当空列表，权限/损坏仍显式失败。
    return readCheckpoints(this.metadataPath, { strict: true });
  }

  async diff(id: string): Promise<string> {
    validateId(id);
    // stat 摘要之后附完整 unified diff（有界截断），供 Web 统一 diff 视图做 hunk 解析与"恢复到此 hunk"。
    // 超大树仓库的 diff 可能有数百 MB：采集侧硬上限，避免一次性堆进 Node 内存。
    // 两次 diff 都是只读，并行跑缩短大仓库的等待时间，峰值仍由各自上限约束。
    const [stat, full] = await Promise.all([
      this.git(["diff", "--stat", id], false, { maxStdoutBytes: 1 * 1024 * 1024 }),
      this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", id], false, { maxStdoutBytes: 4 * 1024 * 1024 }),
    ]);
    return truncateLines(`${stat.trimEnd()}\n\n${full}`.trim(), 4000);
  }

  async restore(id: string): Promise<void> {
    validateId(id);
    await this.initialize();
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    // deny 文件受会话策略保护：先记下当前内容与“回退前是否存在”，恢复后原样写回；
    // 回退前不存在、目标快照里却有的 deny 文件必须再移除，不能凭旧快照把 .env 造回来。
    const preserved = await captureDenyFiles(this.workspace, this.options.denyPaths ?? []);
    const absentDeny = await this.absentDenyPaths();
    // read-tree --reset 才真正删除「检查点之后新增、且已被后续检查点跟踪」的文件——
    // checkout <id> -- . 只更新目标树中存在的路径，新增文件会残留。它不移动 HEAD，
    // 后续提交仍可继续线性追加。空树检查点同样可用。
    // 已知边界：contextExcludes 只影响之后创建的快照；此前已跟踪的路径仍会随本次
    // read-tree 按目标树重置（help/usage.md 与 FAQ 已标注）。
    await this.git(["read-tree", "-u", "--reset", id]);
    // clean 排除 = 快照 excludes（目录/字面文件）+ 会话 deny 路径（快照扫描跳过、未捕获，restore 不得删除）
    const cleanExcludes = [
      ...this.excludes,
      ...this.denyRelatives,
    ];
    // -q 避免 clean 为每个删除文件回写一行路径；10 万文件时 stdout 本身就有几十 MB。
    await this.git(["clean", "-fdxq", ...cleanExcludes.flatMap((item) => ["-e", item])], false);
    await restoreDenyFiles(preserved);
    for (const relative of absentDeny) {
      const absolute = path.join(this.workspace, relative);
      if (!(await denyPathInsideWorkspace(this.workspace, absolute))) continue;
      await rm(absolute, { recursive: true, force: true });
    }
  }

  async delete(id: string): Promise<void> {
    validateId(id);
    const checkpoints = await this.list();
    const remaining = checkpoints.filter((item) => item.id !== id);
    await this.save(remaining);
    // 最后一个检查点删除后影子仓库已无引用：一并移除，避免用户看到“已删除”但对象仍占盘。
    // 元数据已经提交，清理失败不能反报整个删除失败（Windows 上杀软/句柄可能短暂占用）。
    if (remaining.length === 0) {
      await rm(this.gitDir, { recursive: true, force: true }).catch((error: unknown) => {
        process.stderr.write(`[snapshots] checkpoint metadata removed but shadow repo cleanup failed at ${this.gitDir}: ${errorMessage(error)}\n`);
      });
    }
  }

  async cleanup(): Promise<void> {
    await rm(this.gitDir, { recursive: true, force: true });
  }

  /** 回退前不存在的 deny 相对路径：read-tree 可能从旧快照恢复它们，restore 后需删除。 */
  private async absentDenyPaths(): Promise<string[]> {
    const absent: string[] = [];
    for (const relative of this.denyRelatives) {
      try {
        await lstat(path.join(this.workspace, relative));
      } catch {
        absent.push(relative);
      }
    }
    return absent;
  }

  /**
   * 撤销 `git add -u` 对排除路径的暂存（excludes 目录/字面模式 + 会话 deny 相对路径）。
   *
   * 只把这些排除项作为 pathspec 传给 reset：不动其余已跟踪文件，避免对大仓库做全量
   * 索引重写（无匹配的 pathspec 在 git 里是 no-op，不会报错）。glob 形态的
   * contextExcludes 不参与（构造期只采纳无通配符的字面模式，见构造函数）。
   */
  private async unstageExcluded(): Promise<void> {
    const patterns = [...this.excludes, ...this.denyRelatives];
    if (patterns.length === 0) return;
    // 排除项是字面路径（构造期已剔除 glob），literal 避免文件名中的 * ? [ 被当成通配符。
    await this.git(["--literal-pathspecs", "reset", "-q", "--", ...patterns], false);
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
      maxDepth: GitShadowSnapshots.SCAN_MAX_DEPTH,
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
   * 生产路径总是走 index.scan（有界原语 + 路径策略一致）；回退路径的收集结果与核心路径
   * 对齐——同样跳过 excludes 与会话 deny 相对路径（否则 deny 文件会被 add -f 强行带进快照）。
   */
  private async scanWorkspaceFallback(): Promise<string[]> {
    const files: string[] = [];
    let bytes = 0;
    let nodes = 0;
    const excluded = [...this.excludes, ...this.denyRelatives]
      .map((item) => item.split("\\").join("/"));
    const isExcluded = (relative: string): boolean =>
      excluded.some((item) => relative === item || relative.startsWith(`${item}/`));
    const visit = async (relative: string, depth: number): Promise<void> => {
      if (depth > GitShadowSnapshots.SCAN_MAX_DEPTH) {
        throw new Error(`Checkpoint workspace scan truncated: max depth ${GitShadowSnapshots.SCAN_MAX_DEPTH}`);
      }
      const entries = await readdir(path.join(this.workspace, relative), { withFileTypes: true });
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (isExcluded(child)) continue;
        nodes += 1;
        if (nodes > GitShadowSnapshots.SCAN_MAX_NODES) {
          throw new Error(`Checkpoint workspace scan truncated: ${GitShadowSnapshots.SCAN_MAX_NODES} nodes`);
        }
        // Dirent 已能区分目录（且不跟随符号链接），目录不再多一次 lstat。
        if (entry.isDirectory()) {
          await visit(child, depth + 1);
          continue;
        }
        const stat = await lstat(path.join(this.workspace, child));
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
    await visit("", 0);
    return files;
  }

  private git(
    args: string[],
    commit = false,
    options: { input?: string; maxStdoutBytes?: number } = {},
  ): Promise<string> {
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
      let captured = 0;
      let truncated = false;
      let stderrCaptured = 0;
      let stderrTruncated = false;
      child.stdout.on("data", (chunk: Buffer) => {
        const cap = options.maxStdoutBytes;
        if (cap === undefined) {
          stdout.push(chunk);
          captured += chunk.length;
          return;
        }
        if (captured >= cap) {
          truncated = true;
          return;
        }
        const remaining = cap - captured;
        stdout.push(chunk.subarray(0, remaining));
        captured += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) truncated = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrCaptured >= MAX_STDERR_BYTES) {
          stderrTruncated = true;
          return;
        }
        const remaining = MAX_STDERR_BYTES - stderrCaptured;
        stderr.push(chunk.subarray(0, remaining));
        stderrCaptured += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) stderrTruncated = true;
      });
      // 子进程提前退出时写 stdin 会 EPIPE；错误已由 close 的退出码统一报告。
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString("utf8").trim();
          reject(new Error(`git ${args[0]} failed (${code}): ${detail}${stderrTruncated ? "\n…（stderr 已截断）" : ""}`));
          return;
        }
        const text = Buffer.concat(stdout).toString("utf8");
        resolve(truncated && options.maxStdoutBytes !== undefined
          ? `${text}\n…（输出超过 ${Math.round(options.maxStdoutBytes / (1024 * 1024))} MiB，已截断）`
          : text);
      });
    });
  }

  private async save(checkpoints: Checkpoint[]): Promise<void> {
    await writeCheckpoints(this.metadataPath, checkpoints);
  }
}

function validateId(id: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error("Invalid checkpoint ID");
}

/** path.relative 结果是否逃出根目录；避免 `..foo` 这类合法文件名被误判。 */
function isOutsideRelative(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** denyPaths → 工作区内相对路径（git pathspec 统一用 `/`）；工作区外条目跳过。 */
function relativeDenyPaths(workspace: string, denyPaths: readonly string[]): string[] {
  const root = path.resolve(workspace);
  const relatives = new Set<string>();
  for (const denyPath of denyPaths) {
    const absolute = path.resolve(path.isAbsolute(denyPath) ? denyPath : path.join(root, denyPath));
    const relative = path.relative(root, absolute);
    if (!relative || isOutsideRelative(relative)) continue;
    relatives.add(relative.split(path.sep).join("/"));
  }
  return [...relatives];
}
