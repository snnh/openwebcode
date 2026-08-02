import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { isMissing } from "../fs-utils.js";
import type { CoreClientLike } from "../core-client.js";
import type { EventBus } from "../events/event-bus.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { ShellBackend } from "../sessions/types.js";
import { coreExecShell } from "../agent/shell-detect.js";
import { decodeProcessOutputChunks } from "../agent/output-decoder.js";
import type {
  GitCommitInput,
  GitCommitResult,
  GitDiffOptions,
  GitDiffResult,
  GitExec,
  GitLogEntry,
  GitStatusEntry,
  GitStatusResult,
  WorktreeEntry,
  WorktreeMergeResult,
} from "./types.js";

/** git_status 单分组输出上限；超出截断并保留真实总数。 */
export const MAX_STATUS_ENTRIES_PER_GROUP = 200;
/** diff 内联返回阈值（字节）；超出只给 stat + 摘要，完整 diff 落 artifact。 */
export const MAX_INLINE_DIFF_BYTES = 32 * 1024;
/** worktree 数量上限（plan §4.5 默认 4）。 */
export const MAX_WORKTREES = 4;
/** 提交信息长度上限。 */
export const MAX_COMMIT_MESSAGE_CHARS = 2_000;

const GIT_JOB_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;

/** 严格白名单：分支名/worktree 名/ref（禁空格、引号、shell 元字符、连续点、开头短横线）。 */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
/** 相对路径白名单：普通空格由 quoteArg 安全引用；拒绝控制符与 shell 元字符。 */
const UNSAFE_PATH_CHARS = /[\r\n\t"'%&|;<>`$\\]/;

export function validateRef(ref: string, what = "ref"): string {
  const trimmed = ref.trim();
  if (!SAFE_NAME.test(trimmed) || trimmed.includes("..") || trimmed.endsWith("/") || trimmed.endsWith(".lock")) {
    throw new Error(`Invalid ${what}: ${ref}`);
  }
  return trimmed;
}

/** 允许 HEAD~2 / HEAD^ 这类相对 ref。 */
export function validateRevSpec(spec: string): string {
  const trimmed = spec.trim();
  const normalized = trimmed.replace(/[~^]\d*/g, "");
  // 支持 a..b / a...b 区间：两侧各自校验
  for (const part of normalized.split(/\.{2,3}/)) {
    if (part === "") continue;
    if (!SAFE_NAME.test(part) || part.includes("..") || part.endsWith("/")) throw new Error(`Invalid revision spec: ${spec}`);
  }
  return trimmed;
}

export function validateRelativePath(file: string): string {
  const trimmed = file.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("-") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.split("/").some((segment) => segment === ".." || segment === "") ||
    UNSAFE_PATH_CHARS.test(trimmed)
  ) {
    throw new Error(`Invalid relative path: ${file}`);
  }
  return trimmed;
}

export function validateWorktreeName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(trimmed)) throw new Error(`Invalid worktree name: ${name}`);
  return trimmed;
}

/** 解析 `git status --porcelain=v1 --branch` 输出。 */
export function parseStatusPorcelain(text: string): Omit<GitStatusResult, "isRepo"> {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      if (header.startsWith("HEAD (no branch)") || header === "HEAD") {
        branch = "HEAD";
      } else {
        const separator = header.indexOf("...");
        const branchPart = separator >= 0 ? header.slice(0, separator) : header;
        const restPart = separator >= 0 ? header.slice(separator + 3) : "";
        const upstreamMatch = /^([^\s[]+)/.exec(restPart);
        const trackingMatch = /\[([^\]]*)\]/.exec(restPart);
        if (branchPart) branch = branchPart;
        if (upstreamMatch) upstream = upstreamMatch[1];
        const tracking = trackingMatch?.[1] ?? "";
        const aheadMatch = /ahead (\d+)/.exec(tracking);
        const behindMatch = /behind (\d+)/.exec(tracking);
        if (aheadMatch) ahead = Number(aheadMatch[1]);
        if (behindMatch) behind = Number(behindMatch[1]);
      }
      continue;
    }
    const code = line.slice(0, 2);
    let filePath = line.slice(3);
    let originalPath: string | undefined;
    const renameIndex = filePath.indexOf(" -> ");
    if (renameIndex >= 0) {
      originalPath = filePath.slice(0, renameIndex);
      filePath = filePath.slice(renameIndex + 4);
    }
    // porcelain 对含特殊字符的路径加引号；白名单外的路径仍如实返回（仅展示）
    if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    const entry: GitStatusEntry = { path: filePath, code, ...(originalPath ? { originalPath } : {}) };
    if (code === "??") {
      untracked.push(entry);
      continue;
    }
    const [index, worktree] = code;
    if (index !== " " && index !== "?") staged.push(entry);
    if (worktree !== " " && worktree !== "?") unstaged.push(entry);
  }
  const cap = (entries: GitStatusEntry[]): GitStatusEntry[] => entries.slice(0, MAX_STATUS_ENTRIES_PER_GROUP);
  const truncated = staged.length > MAX_STATUS_ENTRIES_PER_GROUP || unstaged.length > MAX_STATUS_ENTRIES_PER_GROUP || untracked.length > MAX_STATUS_ENTRIES_PER_GROUP;
  return {
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    staged: cap(staged),
    unstaged: cap(unstaged),
    untracked: cap(untracked),
    totals: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length },
    truncated,
  };
}

/** Parse `git status --porcelain=v1 --branch -z` without display quoting. */
export function parseStatusPorcelainZ(text: string): Omit<GitStatusResult, "isRepo"> {
  const records = text.split("\0");
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith("## ")) {
      const header = record.slice(3);
      if (header.startsWith("HEAD (no branch)") || header === "HEAD") branch = "HEAD";
      else {
        const separator = header.indexOf("...");
        const branchPart = separator >= 0 ? header.slice(0, separator) : header;
        const restPart = separator >= 0 ? header.slice(separator + 3) : "";
        const tracking = /\[([^\]]*)\]/.exec(restPart)?.[1] ?? "";
        if (branchPart) branch = branchPart;
        upstream = /^([^\s[]+)/.exec(restPart)?.[1];
        ahead = Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0);
        behind = Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0);
      }
      continue;
    }
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    // In -z mode Git emits rename/copy records as destination\0source\0.
    const originalPath = code.includes("R") || code.includes("C") ? records[++index] : undefined;
    const entry: GitStatusEntry = { path: filePath, code, ...(originalPath ? { originalPath } : {}) };
    if (code === "??") untracked.push(entry);
    else {
      const [indexCode, worktreeCode] = code;
      if (indexCode !== " " && indexCode !== "?") staged.push(entry);
      if (worktreeCode !== " " && worktreeCode !== "?") unstaged.push(entry);
    }
  }
  const cap = (entries: GitStatusEntry[]): GitStatusEntry[] => entries.slice(0, MAX_STATUS_ENTRIES_PER_GROUP);
  return {
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    staged: cap(staged),
    unstaged: cap(unstaged),
    untracked: cap(untracked),
    totals: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length },
    truncated: staged.length > MAX_STATUS_ENTRIES_PER_GROUP || unstaged.length > MAX_STATUS_ENTRIES_PER_GROUP || untracked.length > MAX_STATUS_ENTRIES_PER_GROUP,
  };
}

/**
 * SCM 服务（0.4.0 Phase 4a）：git_status / git_diff / git_commit 与 worktree 生命周期。
 * 执行默认经 Core job（与 bash/test_runner 同路径，继承会话权限沙盒与 cwd 约束）；
 * 测试可注入 GitExec 直连真实 git。worktree 落在 <worktreeRoot>/<sessionId>/ 下
 * （仓库 .git 之外的服务端数据目录），会话结束不自动删除，用户经 REST 决定清理。
 */
export class ScmService {
  private readonly runGit: GitExec;

  constructor(
    private readonly core: CoreClientLike,
    private readonly sessions: SessionStore,
    private readonly events: EventBus,
    private readonly options: { worktreeRoot: string; exec?: GitExec } ,
  ) {
    this.runGit = options.exec ?? ((args, cwd) => this.runGitViaCore(args, cwd, { sessionId: "", shellBackend: "default" }));
  }

  private publish(sessionId: string, reason: string, detail: Record<string, unknown> = {}): void {
    this.events.publish({ source: "agent", type: "scm.updated", sessionId, payload: { sessionId, reason, ...detail } });
  }

  /** 默认执行路径：Core job exec（继承会话权限沙盒）；命令行只含白名单参数，提交信息走 -F 文件。 */
  private async runGitViaCore(
    args: string[],
    cwd: string,
    context: { sessionId: string; shellBackend: ShellBackend; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cmd = ["git", ...args.map(quoteArg)].join(" ");
    const jobId = `git-${randomUUID()}`;
    const output: Array<{ stream: "stdout" | "stderr"; data: string; seq: number }> = [];
    let afterSeq = 0;
    const cancel = () => { void this.core.cancelJob({ sessionId: context.sessionId, jobId }).catch(() => undefined); };
    context.signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.core.startJob({ sessionId: context.sessionId, jobId, kind: "exec", cmd, cwd, timeoutMs: GIT_JOB_TIMEOUT_MS, ...coreExecShell(context.shellBackend) });
      for (;;) {
        const page = await this.core.jobOutput({ sessionId: context.sessionId, jobId, afterSeq, limit: 128 });
        output.push(...page.chunks);
        afterSeq = page.nextSeq;
        const status = await this.core.jobStatus({ sessionId: context.sessionId, jobId });
        if (status.state === "running") {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          continue;
        }
        const tail = await this.core.jobOutput({ sessionId: context.sessionId, jobId, afterSeq, limit: 128 });
        output.push(...tail.chunks);
        if (status.state === "cancelled" || status.state === "timed_out") {
          throw new Error(status.error ?? `git job ${status.state}`);
        }
        // job.output 的 chunk.data 是 base64：先整体解码再按流分拣（保持跨块多字节字符完整）
        const decoded = decodeProcessOutputChunks(output);
        const stdout = decoded.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.data).join("");
        const stderr = decoded.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.data).join("");
        return { stdout, stderr, exitCode: status.exitCode ?? 1 };
      }
    } finally {
      context.signal?.removeEventListener("abort", cancel);
    }
  }

  /** 会话级执行封装：默认 Core job 路径带 sessionId/shellBackend；注入 exec 时直连（测试）。 */
  private async git(sessionId: string, cwd: string, args: string[], context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.options.exec) return this.options.exec(args, cwd);
    return this.runGitViaCore(args, cwd, { sessionId, shellBackend: context.shellBackend ?? "default", ...(context.signal ? { signal: context.signal } : {}) });
  }

  private async requireRepo(sessionId: string, cwd: string, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<void> {
    const probe = await this.git(sessionId, cwd, ["rev-parse", "--is-inside-work-tree"], context);
    if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
      throw new NotARepoError("Not a git repository (or any parent up to mount point)");
    }
  }

  async status(sessionId: string, cwd: string, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<GitStatusResult> {
    const probe = await this.git(sessionId, cwd, ["rev-parse", "--is-inside-work-tree"], context);
    if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
      return { isRepo: false, staged: [], unstaged: [], untracked: [], totals: { staged: 0, unstaged: 0, untracked: 0 }, truncated: false };
    }
    const result = await this.git(sessionId, cwd, ["status", "--porcelain=v1", "--branch", "-z"], context);
    if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    return { isRepo: true, ...parseStatusPorcelainZ(result.stdout) };
  }

  async diff(sessionId: string, cwd: string, options: GitDiffOptions = {}, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<GitDiffResult> {
    const probe = await this.git(sessionId, cwd, ["rev-parse", "--is-inside-work-tree"], context);
    if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
      return { isRepo: false, stat: "", totalBytes: 0, truncated: false };
    }
    const scope: string[] = [];
    if (options.staged) scope.push("--staged");
    else if (options.base) scope.push(validateRevSpec(options.base));
    const file = options.file !== undefined ? validateRelativePath(options.file) : undefined;
    const statArgs = ["diff", "--stat", ...scope, ...(file ? ["--", file] : [])];
    const diffArgs = ["diff", ...scope, ...(file ? ["--", file] : [])];
    const stat = await this.git(sessionId, cwd, statArgs, context);
    if (stat.exitCode !== 0) throw new Error(`git diff --stat failed: ${stat.stderr.trim() || `exit ${stat.exitCode}`}`);
    const full = await this.git(sessionId, cwd, diffArgs, context);
    if (full.exitCode !== 0) throw new Error(`git diff failed: ${full.stderr.trim() || `exit ${full.exitCode}`}`);
    const totalBytes = Buffer.byteLength(full.stdout, "utf8");
    if (totalBytes <= MAX_INLINE_DIFF_BYTES) {
      return { isRepo: true, stat: stat.stdout, diff: full.stdout, totalBytes, truncated: false };
    }
    // 大 diff：只给 stat + 摘要，完整 diff 落 sessions artifact（read_artifact 可续读）
    const artifactId = `artifact-${randomUUID()}`;
    const directory = path.join(this.sessions.contextRoot(sessionId), "artifacts");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${artifactId}.txt`), full.stdout, "utf8");
    return { isRepo: true, stat: stat.stdout, artifactId, totalBytes, truncated: true };
  }

  /**
   * 提交辅助：参数白名单（message/stageAll/files），不接受任意 flag（--no-verify 等无从传入）；
   * 提交信息经 -F 临时文件传递，不拼进命令行。提交后自动附带 git_status 摘要。
   */
  async commit(sessionId: string, cwd: string, input: GitCommitInput, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<GitCommitResult> {
    const message = input.message.trim();
    if (!message) throw new Error("git_commit requires a non-empty message");
    if (message.length > MAX_COMMIT_MESSAGE_CHARS) throw new Error(`Commit message exceeds ${MAX_COMMIT_MESSAGE_CHARS} characters`);
    if (input.stageAll && input.files && input.files.length > 0) throw new Error("stageAll and files are mutually exclusive");
    await this.requireRepo(sessionId, cwd, context);
    if (input.stageAll) {
      const add = await this.git(sessionId, cwd, ["add", "-A"], context);
      if (add.exitCode !== 0) throw new Error(`git add -A failed: ${add.stderr.trim() || `exit ${add.exitCode}`}`);
    } else if (input.files && input.files.length > 0) {
      const files = input.files.map(validateRelativePath);
      const add = await this.git(sessionId, cwd, ["add", "--", ...files], context);
      if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.trim() || `exit ${add.exitCode}`}`);
    }
    // 提交信息走 -F 文件：跨 cmd.exe/sh 安全，不注入命令行
    const messageDir = path.join(this.sessions.contextRoot(sessionId), "scm");
    await mkdir(messageDir, { recursive: true });
    const messageFile = path.join(messageDir, `commit-${randomUUID()}.txt`);
    await writeFile(messageFile, message, "utf8");
    try {
      const committed = await this.git(sessionId, cwd, ["commit", "-F", messageFile], context);
      if (committed.exitCode !== 0) {
        const detail = (committed.stderr || committed.stdout).trim();
        throw new Error(`git commit failed: ${detail || `exit ${committed.exitCode}`}`);
      }
    } finally {
      await rm(messageFile, { force: true });
    }
    const head = await this.git(sessionId, cwd, ["rev-parse", "HEAD"], context);
    const commit = head.exitCode === 0 ? head.stdout.trim() : "";
    const status = await this.status(sessionId, cwd, context);
    this.publish(sessionId, "commit", { commit: commit.slice(0, 12) });
    return { commit, subject: message.split("\n", 1)[0] ?? "", status };
  }

  // ---- stage / unstage / discard（阶段 2a）----

  /** 暂存指定相对路径（git add -- <files>）。 */
  async stage(sessionId: string, cwd: string, files: string[], context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<{ ok: true }> {
    const validated = validateFileList(files);
    await this.requireRepo(sessionId, cwd, context);
    const result = await this.git(sessionId, cwd, ["add", "--", ...validated], context);
    if (result.exitCode !== 0) throw new Error(`git add failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    this.publish(sessionId, "stage", { files: validated });
    return { ok: true };
  }

  /** 取消暂存（git restore --staged -- <files>），工作区内容不变。 */
  async unstage(sessionId: string, cwd: string, files: string[], context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<{ ok: true }> {
    const validated = validateFileList(files);
    await this.requireRepo(sessionId, cwd, context);
    const result = await this.git(sessionId, cwd, ["restore", "--staged", "--", ...validated], context);
    if (result.exitCode !== 0) throw new Error(`git restore --staged failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    this.publish(sessionId, "unstage", { files: validated });
    return { ok: true };
  }

  /**
   * 丢弃变更：先 status 分拣 tracked/untracked——tracked 用 git restore 还原工作区，
   * untracked 用 git clean -f 删除（不可恢复，路由层要求带 force 双确认）。
   */
  async discard(sessionId: string, cwd: string, files: string[], options: { force?: boolean } = {}, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<{ ok: true }> {
    const validated = validateFileList(files);
    await this.requireRepo(sessionId, cwd, context);
    const status = await this.status(sessionId, cwd, context);
    const untrackedPaths = status.untracked.map((entry) => entry.path);
    // porcelain 对整目录未跟踪只报 "dir/"；其内文件同样按 untracked 处理
    const isUntracked = (file: string): boolean => untrackedPaths.some((entry) => entry === file || (entry.endsWith("/") && file.startsWith(entry)));
    const untracked = validated.filter(isUntracked);
    const tracked = validated.filter((file) => !isUntracked(file));
    if (untracked.length > 0 && !options.force) {
      throw new DiscardRequiresForceError(`Discarding untracked files requires force: ${untracked.join(", ")}`);
    }
    if (tracked.length > 0) {
      const restored = await this.git(sessionId, cwd, ["restore", "--", ...tracked], context);
      if (restored.exitCode !== 0) throw new Error(`git restore failed: ${restored.stderr.trim() || `exit ${restored.exitCode}`}`);
    }
    if (untracked.length > 0) {
      const cleaned = await this.git(sessionId, cwd, ["clean", "-f", "--", ...untracked], context);
      if (cleaned.exitCode !== 0) throw new Error(`git clean failed: ${cleaned.stderr.trim() || `exit ${cleaned.exitCode}`}`);
    }
    this.publish(sessionId, "discard", { files: validated });
    return { ok: true };
  }

  // ---- 只读历史（阶段 2f）----

  /** git log 只读历史；空仓库（无提交）返回空数组而非报错。limit 钳制 1-200。 */
  async log(sessionId: string, cwd: string, limit = 50, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<GitLogEntry[]> {
    const clamped = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.trunc(limit))) : 50;
    await this.requireRepo(sessionId, cwd, context);
    const result = await this.git(sessionId, cwd, ["log", "--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%s", "-n", String(clamped)], context);
    if (result.exitCode !== 0) {
      // 空仓库：stderr 文案随 git 版本/语言变化，宽松匹配
      if (/does not have any commits|no commits yet|bad default revision|unknown revision|ambiguous argument/i.test(result.stderr)) return [];
      throw new Error(`git log failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    const commits: GitLogEntry[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [hash = "", shortHash = "", author = "", relTime = "", subject = ""] = line.split("\x1f");
      commits.push({ hash, shortHash, author, relTime, subject });
    }
    return commits;
  }

  // ---- worktree 生命周期 ----

  private registryPath(sessionId: string): string {
    return path.join(this.options.worktreeRoot, sessionId, "worktrees.json");
  }

  private async readRegistry(sessionId: string): Promise<WorktreeEntry[]> {
    try {
      const value = JSON.parse(await readFile(this.registryPath(sessionId), "utf8")) as WorktreeEntry[];
      if (!Array.isArray(value)) throw new Error("Invalid worktree registry");
      return value;
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async writeRegistry(sessionId: string, entries: WorktreeEntry[]): Promise<void> {
    const file = this.registryPath(sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeUtf8Atomically(file, `${JSON.stringify(entries, null, 2)}\n`);
  }

  async listWorktrees(sessionId: string): Promise<WorktreeEntry[]> {
    const entries = await this.readRegistry(sessionId);
    return Promise.all(entries.map(async (entry) => ({
      ...entry,
      exists: await stat(entry.path).then((value) => value.isDirectory()).catch(() => false),
    })));
  }

  async createWorktree(sessionId: string, cwd: string, input: { name?: string; branch?: string } = {}, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<WorktreeEntry> {
    await this.requireRepo(sessionId, cwd, context);
    const name = validateWorktreeName(input.name ?? `wt-${randomUUID().slice(0, 8)}`);
    const branch = input.branch ? validateRef(input.branch, "branch") : `owc/${name}`;
    const existing = await this.readRegistry(sessionId);
    const alive = [];
    for (const entry of existing) {
      if (await stat(entry.path).then((value) => value.isDirectory()).catch(() => false)) alive.push(entry);
    }
    if (alive.length >= MAX_WORKTREES) throw new Error(`Worktree limit reached (${MAX_WORKTREES}); remove one before creating more`);
    if (alive.some((entry) => entry.name === name)) throw new Error(`Worktree already exists: ${name}`);
    const worktreePath = path.join(this.options.worktreeRoot, sessionId, name);
    const result = await this.git(sessionId, cwd, ["worktree", "add", worktreePath, "-b", branch], context);
    if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    const entry: WorktreeEntry = { name, path: worktreePath, branch, createdAt: new Date().toISOString(), exists: true };
    await this.writeRegistry(sessionId, [...alive, entry]);
    this.publish(sessionId, "worktree.create", { name, branch });
    return entry;
  }

  async removeWorktree(sessionId: string, cwd: string, name: string, options: { force?: boolean } = {}, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<{ removed: true; name: string }> {
    const validated = validateWorktreeName(name);
    const entries = await this.readRegistry(sessionId);
    const entry = entries.find((item) => item.name === validated);
    if (!entry) throw new Error(`Worktree not found: ${validated}`);
    const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), entry.path];
    const result = await this.git(sessionId, cwd, args, context);
    if (result.exitCode !== 0) {
      throw new Error(`git worktree remove failed: ${result.stderr.trim() || `exit ${result.exitCode}`} (retry with force to discard changes)`);
    }
    await this.writeRegistry(sessionId, entries.filter((item) => item.name !== validated));
    this.publish(sessionId, "worktree.remove", { name: validated });
    return { removed: true, name: validated };
  }

  /**
   * 合回 worktree 分支到主 cwd：显式执行；冲突时中止并如实报告冲突文件列表，不做自动解决。
   */
  async mergeWorktree(sessionId: string, cwd: string, name: string, options: { strategy?: "merge" | "cherry-pick" } = {}, context: { shellBackend?: ShellBackend; signal?: AbortSignal } = {}): Promise<WorktreeMergeResult> {
    const validated = validateWorktreeName(name);
    const strategy = options.strategy ?? "merge";
    const entries = await this.readRegistry(sessionId);
    const entry = entries.find((item) => item.name === validated);
    if (!entry) throw new Error(`Worktree not found: ${validated}`);
    await this.requireRepo(sessionId, cwd, context);
    let args: string[];
    if (strategy === "merge") {
      args = ["merge", "--no-ff", "--no-edit", entry.branch];
    } else {
      const base = await this.git(sessionId, cwd, ["merge-base", "HEAD", entry.branch], context);
      if (base.exitCode !== 0 || !base.stdout.trim()) throw new Error(`git merge-base failed: ${base.stderr.trim() || `exit ${base.exitCode}`}`);
      const commits = await this.git(sessionId, cwd, ["rev-list", "--reverse", `${base.stdout.trim()}..${entry.branch}`], context);
      if (commits.exitCode !== 0) throw new Error(`git rev-list failed: ${commits.stderr.trim() || `exit ${commits.exitCode}`}`);
      const ordered = commits.stdout.split("\n").map((commit) => commit.trim()).filter(Boolean);
      if (ordered.length === 0) {
        this.publish(sessionId, "worktree.merge", { name: validated, strategy, branch: entry.branch });
        return { merged: true, conflicts: [], strategy, branch: entry.branch };
      }
      args = ["cherry-pick", "--no-commit", ...ordered];
    }
    const result = await this.git(sessionId, cwd, args, context);
    if (result.exitCode === 0) {
      // cherry-pick --no-commit 需要补一次提交完成合回
      if (strategy === "cherry-pick") {
        const finalized = await this.git(sessionId, cwd, ["commit", "--no-edit", "-m", `cherry-pick: ${entry.branch}`], context);
        if (finalized.exitCode !== 0) throw new Error(`git commit after cherry-pick failed: ${finalized.stderr.trim() || `exit ${finalized.exitCode}`}`);
      }
      this.publish(sessionId, "worktree.merge", { name: validated, strategy, branch: entry.branch });
      return { merged: true, conflicts: [], strategy, branch: entry.branch };
    }
    const conflictsRaw = await this.git(sessionId, cwd, ["diff", "--name-only", "--diff-filter=U"], context);
    const conflicts = conflictsRaw.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    // 冲突如实报告并中止合回，主工作区回到合回前状态
    await this.git(sessionId, cwd, [strategy === "merge" ? "merge" : "cherry-pick", "--abort"], context).catch(() => undefined);
    const detail = (result.stderr || result.stdout).trim();
    this.publish(sessionId, "worktree.merge_conflict", { name: validated, strategy, branch: entry.branch, conflicts });
    return {
      merged: false,
      conflicts,
      strategy,
      branch: entry.branch,
      ...(detail ? { message: detail } : {}),
    };
  }
}

export class NotARepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotARepoError";
  }
}

/** discard 目标含 untracked 文件但未带 force：REST 映射 400（删除不可恢复，需双确认）。 */
export class DiscardRequiresForceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscardRequiresForceError";
  }
}

/** 非空相对路径列表校验（stage/unstage/discard 共用）。 */
function validateFileList(files: string[]): string[] {
  if (!Array.isArray(files) || files.length === 0) throw new Error("files must be a non-empty array of relative paths");
  return files.map(validateRelativePath);
}

/** 跨 cmd.exe / sh 的参数引用：白名单字符原样，其余用双引号包裹（参数先经严格校验，不含引号）。 */
function quoteArg(arg: string): string {
  return /^[a-zA-Z0-9._/:@=+~^,-]+$/.test(arg) ? arg : `"${arg}"`;
}
