// ---- SCM（Phase 4）：GET /api/sessions/:id/git/* 的契约（与 server/src/scm/types.ts 对齐） ----

/** 单条变更条目（porcelain v1 解析结果）：path + XY 状态码（如 "M "、" M"、"A "、"??"），rename 带 originalPath */
export interface ScmStatusEntry {
  path: string;
  code: string;
  originalPath?: string;
}

/** GET /api/sessions/:id/git/status 的响应；非 git 仓库时 isRepo=false 且分支等字段缺省 */
export interface ScmStatus {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: ScmStatusEntry[];
  unstaged: ScmStatusEntry[];
  untracked: ScmStatusEntry[];
  /** 分组截断后仍保留真实总数 */
  totals: { staged: number; unstaged: number; untracked: number };
  /** 任一分组因有界输出被截断 */
  truncated: boolean;
}

/** GET /api/sessions/:id/git/diff 的响应；truncated 时只有 stat，完整 diff 落 artifact（artifactId 可经 read_artifact 续读） */
export interface ScmDiff {
  isRepo: boolean;
  /** git diff --stat 输出（可能为空字符串表示无变更） */
  stat: string;
  /** 未超阈值时的完整 unified diff 文本 */
  diff?: string;
  artifactId?: string;
  /** 完整 diff 字节数 */
  totalBytes: number;
  truncated: boolean;
}

/** worktree 条目：name 为注册名（也是 DELETE 路由参数），exists 为 list 时的磁盘探测结果 */
export interface ScmWorktree {
  name: string;
  path: string;
  branch: string;
  createdAt: string;
  exists: boolean;
}

/** GET /api/sessions/:id/git/log 的单条提交（relTime 为服务端格式化的相对时间） */
export interface ScmLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  relTime: string;
  subject: string;
}

/** POST /api/sessions/:id/git/worktrees/:name/merge 的响应；冲突时 merged=false 且如实报告冲突文件列表（与 server WorktreeMergeResult 对齐） */
export interface ScmWorktreeMergeResult {
  merged: boolean;
  conflicts: string[];
  strategy: "merge" | "cherry-pick";
  branch: string;
  message?: string;
}
