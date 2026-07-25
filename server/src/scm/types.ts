/**
 * SCM（Git 集成，0.4.0 Phase 4a）类型契约。
 * 与快照体系互补：快照管"恢复"，git 视图管"审查与提交"（plan §4.3）。
 */

/** git_status 单条变更条目（porcelain v1 解析结果）。 */
export interface GitStatusEntry {
  /** 相对仓库根的路径（rename 时为新路径）。 */
  path: string;
  /** porcelain XY 状态码，如 "M "、" M"、"A "、"??"。 */
  code: string;
  /** rename/copy 时的原路径。 */
  originalPath?: string;
}

export interface GitStatusResult {
  /** 非 git 仓库时为 false，其余字段缺省；REST 据此返回 409/降级视图。 */
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  /** 分组截断后仍保留真实总数。 */
  totals: { staged: number; unstaged: number; untracked: number };
  /** 任一分组因有界输出被截断。 */
  truncated: boolean;
}

export interface GitDiffOptions {
  /** true 查看已暂存变更（git diff --staged）。 */
  staged?: boolean;
  /** commit 区间/基线 ref（如 HEAD~1、main...HEAD）；与 staged 互斥。 */
  base?: string;
  /** 限定单文件（相对路径，白名单校验）。 */
  file?: string;
}

export interface GitDiffResult {
  isRepo: boolean;
  /** git diff --stat 输出（可能为空字符串表示无变更）。 */
  stat: string;
  /** 未超阈值时的完整 diff 文本。 */
  diff?: string;
  /** 超阈值时完整 diff 落 sessions artifact 的 id（read_artifact 可续读）。 */
  artifactId?: string;
  /** 完整 diff 字节数。 */
  totalBytes: number;
  truncated: boolean;
}

export interface GitCommitInput {
  message: string;
  /** 提交前 git add -A（默认 false）。 */
  stageAll?: boolean;
  /** 提交前仅暂存这些相对路径（与 stageAll 互斥）。 */
  files?: string[];
}

export interface GitCommitResult {
  /** 新提交的完整哈希。 */
  commit: string;
  /** 提交主题行。 */
  subject: string;
  /** 提交后的工作区状态摘要（自动附带）。 */
  status: GitStatusResult;
}

export interface WorktreeEntry {
  name: string;
  /** worktree 磁盘路径（<worktreeRoot>/<sessionId>/<name>）。 */
  path: string;
  branch: string;
  createdAt: string;
  /** 磁盘上是否仍存在（list 时探测，不自动清理）。 */
  exists: boolean;
}

export interface WorktreeMergeResult {
  merged: boolean;
  /** 冲突时如实报告的冲突文件列表；不做自动解决。 */
  conflicts: string[];
  /** 合回方式。 */
  strategy: "merge" | "cherry-pick";
  branch: string;
  message?: string;
}

/** 可注入的 git 执行器：默认经 Core job 执行（继承会话权限沙盒与 cwd 约束）；测试注入真实 git。 */
export type GitExec = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
