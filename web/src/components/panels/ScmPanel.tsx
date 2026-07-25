import { useEffect, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import type { ScmDiff, ScmStatusEntry } from "../../lib/contracts";
import { Icon } from "../Icon";
import { useI18n } from "../../i18n";

/** diff 行按前缀着色：+ 新增、- 删除、\ 注释（如 No newline）、其余为上下文 */
function diffLineClass(line: string): string {
  if (line.startsWith("+")) return "diff-line add";
  if (line.startsWith("-")) return "diff-line del";
  if (line.startsWith("\\")) return "diff-line meta";
  return "diff-line";
}

/** 只读 unified diff 渲染；server 返回整段 diff 文本（stat + diff），truncated 时只有 stat + artifactId */
function DiffView({ diff }: { diff: ScmDiff }): ReactElement {
  const { t } = useI18n();
  if (diff.truncated) {
    return (
      <div className="diff-view">
        <pre className="diff-stat">{diff.stat}</pre>
        <p className="preview-note">
          {t("diff 过大已截断，仅显示统计；完整内容在 artifact", "Diff is too large and was truncated; only the stat is shown. Full content is in artifact")}
          {diff.artifactId ? <code>{diff.artifactId}</code> : null}
        </p>
      </div>
    );
  }
  const lines = (diff.diff ?? "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    return <p className="panel-empty">{t("该文件没有可显示的 diff。", "No diff to display for this file.")}</p>;
  }
  return (
    <div className="diff-view">
      <pre className="diff-lines">
        {lines.map((line, lineIndex) => (
          <div key={lineIndex} className={diffLineClass(line)}>{line || " "}</div>
        ))}
      </pre>
    </div>
  );
}

function StatusGroup({ title, entries, total, onOpen }: {
  title: string;
  entries: ScmStatusEntry[];
  total?: number;
  onOpen(entry: ScmStatusEntry): void;
}): ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <section className="problems-group">
      <h3 className="problems-file">
        {title}
        <small>{total ?? entries.length}</small>
      </h3>
      <ul className="problems-list">
        {entries.map((entry) => (
          <li key={`${entry.code}:${entry.path}`}>
            <button className="problems-item" onClick={() => onOpen(entry)} title={entry.path}>
              <span className="scm-status-code" aria-label={entry.code}>{entry.code}</span>
              <span className="problems-name">{entry.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ScmPanel({ sessionId, onNotice }: {
  sessionId?: string;
  onNotice?(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<{ path: string; staged: boolean }>();
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [confirming, setConfirming] = useState<string>();

  useEffect(() => {
    setSelected(undefined);
    setCommitMessage("");
    setNewBranch("");
    setConfirming(undefined);
  }, [sessionId]);

  const status = useQuery({
    queryKey: ["scm-status", sessionId],
    queryFn: () => api.scmStatus(sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const diff = useQuery({
    queryKey: ["scm-diff", sessionId, selected?.path, selected?.staged],
    queryFn: () => api.scmDiff(sessionId!, { staged: selected!.staged, file: selected!.path }),
    enabled: Boolean(sessionId && selected),
    retry: false,
  });
  const worktrees = useQuery({
    queryKey: ["scm-worktrees", sessionId],
    queryFn: () => api.scmWorktrees(sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  });

  const refresh = (): void => {
    queryClient.invalidateQueries({ queryKey: ["scm-status", sessionId] });
    queryClient.invalidateQueries({ queryKey: ["scm-worktrees", sessionId] });
    queryClient.invalidateQueries({ queryKey: ["scm-diff", sessionId] });
  };

  // 提交辅助：前端不直接调写接口，而是向会话下发一条请 agent 执行 git_commit 的消息，
  // 由 agent 走权限链并经用户确认后才真正提交
  const commit = useMutation({
    mutationFn: (message: string) => api.sendMessage(
      sessionId!,
      t(
        `请使用 git_commit 工具提交当前已暂存的更改，提交信息如下：\n${message}\n\n注意：提交必须走权限链并经我确认后才可执行。`,
        `Please commit the currently staged changes using the git_commit tool with the following message:\n${message}\n\nNote: the commit must go through the permission chain and requires my confirmation.`,
      ),
    ),
    onSuccess: () => {
      setCommitMessage("");
      onNotice?.(t("已下发提交请求，agent 执行前会请求你确认。", "Commit request dispatched. The agent will ask for your confirmation before committing."));
    },
    onError: (error) => onNotice?.(error instanceof Error ? error.message : t("下发提交请求失败", "Failed to dispatch commit request"), "error"),
  });

  const createWorktree = useMutation({
    mutationFn: (branch: string) => api.scmCreateWorktree(sessionId!, { branch }),
    onSuccess: () => {
      setNewBranch("");
      queryClient.invalidateQueries({ queryKey: ["scm-worktrees", sessionId] });
      onNotice?.(t("worktree 已创建。", "Worktree created."));
    },
    onError: (error) => onNotice?.(error instanceof Error ? error.message : t("创建 worktree 失败", "Failed to create worktree"), "error"),
  });

  const removeWorktree = useMutation({
    // 用户已在前端确认过，携带 force 允许清理含未提交改动的 worktree
    mutationFn: (name: string) => api.scmDeleteWorktree(sessionId!, name, { force: true }),
    onSuccess: () => {
      setConfirming(undefined);
      queryClient.invalidateQueries({ queryKey: ["scm-worktrees", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["scm-status", sessionId] });
      onNotice?.(t("worktree 已清理。", "Worktree removed."));
    },
    onError: (error) => {
      setConfirming(undefined);
      onNotice?.(error instanceof Error ? error.message : t("清理 worktree 失败", "Failed to remove worktree"), "error");
    },
  });

  if (!sessionId) {
    return <div className="inspector-body"><p className="panel-empty">{t("选择会话以查看源代码管理。", "Select a session to view source control.")}</p></div>;
  }

  const data = status.data;
  const openEntry = (entry: ScmStatusEntry, staged: boolean): void => setSelected({ path: entry.path, staged });

  return (
    <div className="files-panel-wrap">
      <div className="inspector-body problems-panel">
        <div className="panel-head">
          <h2>{t("源代码管理", "Source Control")}</h2>
          <button className="btn small" onClick={refresh} aria-label={t("刷新", "Refresh")}>
            <Icon name="history" size={12} />
            {t("刷新", "Refresh")}
          </button>
        </div>
        {status.isPending ? (
          <p className="panel-empty">{t("加载中…", "Loading…")}</p>
        ) : status.isError ? (
          <p className="panel-empty">
            {t("无法读取 git 状态（该会话目录可能不是 git 仓库）", "Could not read git status (the session directory may not be a git repository)")}
            {status.error instanceof ApiError ? `：${status.error.message}` : ""}
          </p>
        ) : data ? (
          !data.isRepo ? (
            <p className="panel-empty">{t("该会话目录不是 git 仓库。", "The session directory is not a git repository.")}</p>
          ) : (
          <>
            <p className="scm-branch">
              <Icon name="git" size={13} />
              <span className="mono">{data.branch ?? t("（未知分支）", "(unknown branch)")}</span>
              {((data.ahead ?? 0) > 0 || (data.behind ?? 0) > 0) && (
                <span className="scm-sync">
                  {(data.ahead ?? 0) > 0 && <span aria-label={t(`领先 ${data.ahead} 个提交`, `${data.ahead} ahead`)}>↑{data.ahead}</span>}
                  {(data.behind ?? 0) > 0 && <span aria-label={t(`落后 ${data.behind} 个提交`, `${data.behind} behind`)}>↓{data.behind}</span>}
                </span>
              )}
            </p>
            {data.staged.length + data.unstaged.length + data.untracked.length === 0 ? (
              <p className="panel-empty">{t("工作区干净，没有变更。", "Working tree clean. No changes.")}</p>
            ) : (
              <>
                <StatusGroup title={t("已暂存的更改", "Staged Changes")} entries={data.staged} total={data.totals.staged} onOpen={(entry) => openEntry(entry, true)} />
                <StatusGroup title={t("更改", "Changes")} entries={data.unstaged} total={data.totals.unstaged} onOpen={(entry) => openEntry(entry, false)} />
                <StatusGroup title={t("未跟踪的文件", "Untracked Files")} entries={data.untracked} total={data.totals.untracked} onOpen={(entry) => openEntry(entry, false)} />
              </>
            )}
            <section className="scm-commit">
              <h3 className="problems-file">{t("提交", "Commit")}</h3>
              <textarea
                className="scm-commit-input"
                rows={3}
                value={commitMessage}
                placeholder={t("输入提交信息…", "Enter a commit message…")}
                aria-label={t("提交信息", "Commit message")}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <p className="preview-note">{t("提交将下发给 agent 执行，需经你确认后才真正生效。", "The commit is dispatched to the agent and only takes effect after your confirmation.")}</p>
              <button
                className="btn primary small"
                disabled={!commitMessage.trim() || commit.isPending}
                onClick={() => commit.mutate(commitMessage.trim())}
              >
                <Icon name="check" size={12} />
                {commit.isPending ? t("下发中…", "Dispatching…") : t("提交（需确认）", "Commit (requires confirmation)")}
              </button>
            </section>
          </>
          )
        ) : null}
        <section className="scm-worktrees">
          <h3 className="problems-file">{t("Worktrees", "Worktrees")}</h3>
          {worktrees.isError ? (
            <p className="preview-note">
              {t("无法读取 worktree 列表", "Could not load worktrees")}
              {worktrees.error instanceof ApiError ? `：${worktrees.error.message}` : ""}
            </p>
          ) : (worktrees.data ?? []).length === 0 ? (
            <p className="panel-empty">{t("暂无 worktree。", "No worktrees.")}</p>
          ) : (
            <ul className="problems-list">
              {(worktrees.data ?? []).map((worktree) => (
                <li key={worktree.name} className="scm-worktree-item">
                  <Icon name="folder" size={12} />
                  <span className="mono" title={worktree.path}>{worktree.name}</span>
                  <small className="mono">{worktree.branch}</small>
                  {!worktree.exists && <small>{t("（磁盘已缺失）", "(missing on disk)")}</small>}
                  {confirming === worktree.name ? (
                    <span className="scm-confirm">
                      <span>{t("确认清理？", "Confirm removal?")}</span>
                      <button className="btn small primary" onClick={() => removeWorktree.mutate(worktree.name)}>
                        {t("确认", "Confirm")}
                      </button>
                      <button className="btn small" onClick={() => setConfirming(undefined)}>
                        {t("取消", "Cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn small"
                      aria-label={t(`清理 worktree ${worktree.name}`, `Remove worktree ${worktree.name}`)}
                      onClick={() => setConfirming(worktree.name)}
                    >
                      <Icon name="trash" size={12} />
                      {t("清理", "Remove")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="scm-worktree-new">
            <input
              type="text"
              value={newBranch}
              placeholder={t("新分支名…", "New branch name…")}
              aria-label={t("新分支名", "New branch name")}
              onChange={(event) => setNewBranch(event.target.value)}
            />
            <button
              className="btn small"
              disabled={!newBranch.trim() || createWorktree.isPending}
              onClick={() => createWorktree.mutate(newBranch.trim())}
            >
              <Icon name="plus" size={12} />
              {t("创建 worktree", "Create worktree")}
            </button>
          </div>
        </section>
      </div>
      {selected && (
        <section className="file-preview" aria-label={t(`查看 ${selected.path} 的 diff`, `View diff of ${selected.path}`)}>
          <header>
            <span className="mono" title={selected.path}>
              {selected.path}{selected.staged ? t("（已暂存）", " (staged)") : ""}
            </span>
            <button className="icon-btn" onClick={() => setSelected(undefined)} aria-label={t("关闭 diff 视图", "Close diff view")}><Icon name="x" size={14} /></button>
          </header>
          {diff.isError ? (
            <p className="preview-note">
              {diff.error instanceof ApiError ? diff.error.message : t("无法读取 diff。", "Could not load the diff.")}
            </p>
          ) : diff.data ? (
            <DiffView diff={diff.data} />
          ) : (
            <p className="preview-note">{t("加载中…", "Loading…")}</p>
          )}
        </section>
      )}
    </div>
  );
}
