/**
 * 侧栏源代码管理视图：分支状态、staged/unstaged/untracked 分组与行内 stage/unstage/discard、
 * 只读 diff 预览（可一键在统一 diff 视图打开，hunk 级接受/拒绝）、提交辅助（下发 agent 走权限链）、
 * 历史折叠区、worktree 创建/清理/合回（冲突列表展示）。
 * 通知经 ui.notify；写操作成功后主动 invalidate scm 查询，不等 scm.updated 事件。
 */
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import type { ScmDiff, ScmStatusEntry } from "../../lib/contracts";
import { ui } from "../../app/ui-store";
import { auxViews } from "../aux-views";
import { Icon } from "../../components/Icon";
import { CodeBlock } from "../../components/Markdown";
import { useI18n } from "../../i18n";
import { EXT_LANGS } from "../../lib/file-langs";

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
        <p className="muted-empty preview-note">
          {t("diff 过大已截断，仅显示统计；完整内容在 artifact", "Diff is too large and was truncated; only the stat is shown. Full content is in artifact")}
          {diff.artifactId ? <code>{diff.artifactId}</code> : null}
        </p>
      </div>
    );
  }
  const lines = (diff.diff ?? "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    return <p className="muted-empty panel-empty">{t("该文件没有可显示的 diff。", "No diff to display for this file.")}</p>;
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

function StatusGroup({ title, entries, total, onOpen, actions, confirmingPath, confirmLabel, onConfirmDiscard, onCancelDiscard }: {
  title: string;
  entries: ScmStatusEntry[];
  total?: number | undefined;
  onOpen(entry: ScmStatusEntry): void;
  /** 行内操作按钮（hover 显示），按分组注入 stage/unstage/discard */
  actions?(entry: ScmStatusEntry): ReactNode;
  /** 正在等待二次确认 discard 的行路径 */
  confirmingPath?: string | undefined;
  confirmLabel?: string | undefined;
  onConfirmDiscard?(entry: ScmStatusEntry): void;
  onCancelDiscard?(): void;
}): ReactElement | null {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  return (
    <section className="problems-group">
      <h3 className="problems-file">
        {title}
        <small>{total ?? entries.length}</small>
      </h3>
      <ul className="problems-list">
        {entries.map((entry) => (
          <li key={`${entry.code}:${entry.path}`} className="scm-status-row">
            <button className="problems-item" onClick={() => onOpen(entry)} title={entry.path}>
              <span className="scm-status-code" aria-label={entry.code}>{entry.code}</span>
              <span className="problems-name">{entry.path}</span>
            </button>
            {confirmingPath === entry.path ? (
              <span className="scm-confirm">
                <span>{confirmLabel}</span>
                <button className="btn small primary" onClick={() => onConfirmDiscard?.(entry)}>{t("确认", "Confirm")}</button>
                <button className="btn small" onClick={() => onCancelDiscard?.()}>{t("取消", "Cancel")}</button>
              </span>
            ) : actions ? (
              <span className="scm-row-actions">{actions(entry)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ScmView({ sessionId }: { sessionId?: string | undefined }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<{ path: string; staged: boolean; untracked: boolean } | undefined>();
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [confirming, setConfirming] = useState<string | undefined>();
  const [confirmDiscard, setConfirmDiscard] = useState<{ path: string; untracked: boolean } | undefined>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mergeConflicts, setMergeConflicts] = useState<{ name: string; conflicts: string[] } | undefined>();

  useEffect(() => {
    setSelected(undefined);
    setCommitMessage("");
    setNewBranch("");
    setConfirming(undefined);
    setConfirmDiscard(undefined);
    setHistoryOpen(false);
    setMergeConflicts(undefined);
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
    enabled: Boolean(sessionId && selected && !selected.untracked),
    retry: false,
  });
  // 未跟踪文件没有 diff 可言：直接读文件内容预览
  const untrackedFile = useQuery({
    queryKey: ["scm-file", sessionId, selected?.path],
    queryFn: () => api.readFile(sessionId!, selected!.path),
    enabled: Boolean(sessionId && selected?.untracked),
    retry: false,
  });
  const worktrees = useQuery({
    queryKey: ["scm-worktrees", sessionId],
    queryFn: () => api.scmWorktrees(sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  });
  // 历史区：折叠时不拉取，展开后才请求
  const log = useQuery({
    queryKey: ["scm-log", sessionId],
    queryFn: () => api.scmLog(sessionId!, 50),
    enabled: Boolean(sessionId && historyOpen),
    retry: false,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["scm-status", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["scm-worktrees", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["scm-diff", sessionId] });
  };

  const notifyError = (fallback: string) => (error: unknown) =>
    ui.notify(error instanceof Error ? error.message : fallback, "error");

  const stage = useMutation({
    mutationFn: (files: string[]) => api.scmStage(sessionId!, files),
    onSuccess: () => refresh(),
    onError: notifyError(t("暂存失败", "Failed to stage")),
  });
  const unstage = useMutation({
    mutationFn: (files: string[]) => api.scmUnstage(sessionId!, files),
    onSuccess: () => refresh(),
    onError: notifyError(t("取消暂存失败", "Failed to unstage")),
  });
  const discard = useMutation({
    mutationFn: (input: { files: string[]; force: boolean }) => api.scmDiscard(sessionId!, input.files, input.force),
    onSuccess: () => {
      setConfirmDiscard(undefined);
      refresh();
    },
    onError: (error) => {
      setConfirmDiscard(undefined);
      notifyError(t("放弃更改失败", "Failed to discard changes"))(error);
    },
  });

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
      ui.notify(t("已下发提交请求，agent 执行前会请求你确认。", "Commit request dispatched. The agent will ask for your confirmation before committing."));
    },
    onError: (error) => ui.notify(error instanceof Error ? error.message : t("下发提交请求失败", "Failed to dispatch commit request"), "error"),
  });

  const createWorktree = useMutation({
    mutationFn: (branch: string) => api.scmCreateWorktree(sessionId!, { branch }),
    onSuccess: () => {
      setNewBranch("");
      void queryClient.invalidateQueries({ queryKey: ["scm-worktrees", sessionId] });
      ui.notify(t("worktree 已创建。", "Worktree created."));
    },
    onError: (error) => ui.notify(error instanceof Error ? error.message : t("创建 worktree 失败", "Failed to create worktree"), "error"),
  });

  const removeWorktree = useMutation({
    // 用户已在前端确认过，携带 force 允许清理含未提交改动的 worktree
    mutationFn: (name: string) => api.scmDeleteWorktree(sessionId!, name, { force: true }),
    onSuccess: () => {
      setConfirming(undefined);
      void queryClient.invalidateQueries({ queryKey: ["scm-worktrees", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["scm-status", sessionId] });
      ui.notify(t("worktree 已清理。", "Worktree removed."));
    },
    onError: (error) => {
      setConfirming(undefined);
      ui.notify(error instanceof Error ? error.message : t("清理 worktree 失败", "Failed to remove worktree"), "error");
    },
  });

  // worktree 合回：冲突时不做自动解决，展开展示冲突文件列表
  const mergeWorktree = useMutation({
    mutationFn: (name: string) => api.scmMergeWorktree(sessionId!, name),
    onSuccess: (result, name) => {
      if (result.merged) {
        setMergeConflicts(undefined);
        void queryClient.invalidateQueries({ queryKey: ["scm-worktrees", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["scm-status", sessionId] });
        ui.notify(t(`已将 ${name} 合回 ${result.branch}。`, `Merged ${name} back into ${result.branch}.`));
      } else {
        setMergeConflicts({ name, conflicts: result.conflicts });
        ui.notify(t(`合回 ${name} 存在 ${result.conflicts.length} 个冲突，请手动解决。`, `Merging ${name} produced ${result.conflicts.length} conflict(s); resolve them manually.`), "error");
      }
    },
    onError: (error) => ui.notify(error instanceof Error ? error.message : t("合回 worktree 失败", "Failed to merge worktree"), "error"),
  });

  if (!sessionId) {
    return <div className="inspector-body"><p className="muted-empty panel-empty">{t("选择会话以查看源代码管理。", "Select a session to view source control.")}</p></div>;
  }

  const data = status.data;
  const openEntry = (entry: ScmStatusEntry, staged: boolean, untracked = false): void => setSelected({ path: entry.path, staged, untracked });

  const stageActions = (entry: ScmStatusEntry): ReactNode => (
    <>
      <button
        className="icon-btn"
        title={t(`暂存 ${entry.path}`, `Stage ${entry.path}`)}
        aria-label={t(`暂存 ${entry.path}`, `Stage ${entry.path}`)}
        disabled={stage.isPending}
        onClick={() => stage.mutate([entry.path])}
      >
        <Icon name="plus" size={12} />
      </button>
      <button
        className="icon-btn"
        title={t(`放弃 ${entry.path} 的更改`, `Discard changes in ${entry.path}`)}
        aria-label={t(`放弃 ${entry.path} 的更改`, `Discard changes in ${entry.path}`)}
        onClick={() => setConfirmDiscard({ path: entry.path, untracked: false })}
      >
        <Icon name="undo" size={12} />
      </button>
    </>
  );
  const unstageActions = (entry: ScmStatusEntry): ReactNode => (
    <button
      className="icon-btn"
      title={t(`取消暂存 ${entry.path}`, `Unstage ${entry.path}`)}
      aria-label={t(`取消暂存 ${entry.path}`, `Unstage ${entry.path}`)}
      disabled={unstage.isPending}
      onClick={() => unstage.mutate([entry.path])}
    >
      <Icon name="minus" size={12} />
    </button>
  );
  const untrackedActions = (entry: ScmStatusEntry): ReactNode => (
    <>
      <button
        className="icon-btn"
        title={t(`暂存 ${entry.path}`, `Stage ${entry.path}`)}
        aria-label={t(`暂存 ${entry.path}`, `Stage ${entry.path}`)}
        disabled={stage.isPending}
        onClick={() => stage.mutate([entry.path])}
      >
        <Icon name="plus" size={12} />
      </button>
      <button
        className="icon-btn"
        title={t(`删除未跟踪文件 ${entry.path}`, `Delete untracked file ${entry.path}`)}
        aria-label={t(`删除未跟踪文件 ${entry.path}`, `Delete untracked file ${entry.path}`)}
        onClick={() => setConfirmDiscard({ path: entry.path, untracked: true })}
      >
        <Icon name="undo" size={12} />
      </button>
    </>
  );

  return (
    <div className="files-panel-wrap">
      <div className="inspector-body problems-panel">
        <div className="panel-head">
          <button className="btn small" onClick={refresh} aria-label={t("刷新", "Refresh")}>
            <Icon name="history" size={12} />
            {t("刷新", "Refresh")}
          </button>
        </div>
        {status.isPending ? (
          <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>
        ) : status.isError ? (
          <p className="panel-error" role="alert">
            {t("无法读取 git 状态（该会话目录可能不是 git 仓库）", "Could not read git status (the session directory may not be a git repository)")}
            {status.error instanceof ApiError ? `：${status.error.message}` : ""}
          </p>
        ) : data ? (
          !data.isRepo ? (
            <p className="muted-empty panel-empty">{t("该会话目录不是 git 仓库。", "The session directory is not a git repository.")}</p>
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
              <p className="muted-empty panel-empty">{t("工作区干净，没有变更。", "Working tree clean. No changes.")}</p>
            ) : (
              <>
                <StatusGroup
                  title={t("已暂存的更改", "Staged Changes")}
                  entries={data.staged}
                  total={data.totals.staged}
                  onOpen={(entry) => openEntry(entry, true)}
                  actions={unstageActions}
                />
                <StatusGroup
                  title={t("更改", "Changes")}
                  entries={data.unstaged}
                  total={data.totals.unstaged}
                  onOpen={(entry) => openEntry(entry, false)}
                  actions={stageActions}
                  confirmingPath={!confirmDiscard?.untracked ? confirmDiscard?.path : undefined}
                  confirmLabel={t("确认放弃更改？", "Discard changes?")}
                  onConfirmDiscard={(entry) => discard.mutate({ files: [entry.path], force: false })}
                  onCancelDiscard={() => setConfirmDiscard(undefined)}
                />
                <StatusGroup
                  title={t("未跟踪的文件", "Untracked Files")}
                  entries={data.untracked}
                  total={data.totals.untracked}
                  onOpen={(entry) => openEntry(entry, false, true)}
                  actions={untrackedActions}
                  confirmingPath={confirmDiscard?.untracked ? confirmDiscard.path : undefined}
                  confirmLabel={t("确认删除该未跟踪文件？", "Delete this untracked file?")}
                  onConfirmDiscard={(entry) => discard.mutate({ files: [entry.path], force: true })}
                  onCancelDiscard={() => setConfirmDiscard(undefined)}
                />
              </>
            )}
            <section className="scm-commit">
              <h3 className="problems-file">{t("提交", "Commit")}</h3>
              <textarea
                className="input scm-commit-input"
                rows={3}
                value={commitMessage}
                placeholder={t("输入提交信息…", "Enter a commit message…")}
                aria-label={t("提交信息", "Commit message")}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <p className="muted-empty preview-note">{t("提交将下发给 agent 执行，需经你确认后才真正生效。", "The commit is dispatched to the agent and only takes effect after your confirmation.")}</p>
              <button
                className="btn primary small"
                disabled={!commitMessage.trim() || commit.isPending}
                onClick={() => commit.mutate(commitMessage.trim())}
              >
                <Icon name="check" size={12} />
                {commit.isPending ? t("下发中…", "Dispatching…") : t("提交（需确认）", "Commit (requires confirmation)")}
              </button>
            </section>
            <section className="scm-history">
              <h3 className="problems-file">
                <button
                  className="scm-history-toggle"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen((value) => !value)}
                >
                  <Icon name={historyOpen ? "chevron-down" : "chevron-right"} size={12} />
                  {t("历史", "History")}
                </button>
              </h3>
              {historyOpen && (
                log.isPending ? (
                  <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>
                ) : log.isError ? (
                  <p className="muted-empty panel-empty">{t("暂无提交记录。", "No commits yet.")}</p>
                ) : (log.data?.commits ?? []).length === 0 ? (
                  <p className="muted-empty panel-empty">{t("暂无提交记录。", "No commits yet.")}</p>
                ) : (
                  <ul className="problems-list scm-log-list">
                    {(log.data?.commits ?? []).map((entry) => (
                      <li key={entry.hash} className="scm-log-item" title={`${entry.hash}\n${entry.subject}`}>
                        <span className="scm-log-hash">{entry.shortHash}</span>
                        <span className="scm-log-subject">{entry.subject}</span>
                        <span className="scm-log-meta">{entry.author} · {entry.relTime}</span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </section>
          </>
          )
        ) : null}
        <section className="scm-worktrees">
          <h3 className="problems-file">{t("Worktrees", "Worktrees")}</h3>
          {worktrees.isError ? (
            <p className="panel-error" role="alert">
              {t("无法读取 worktree 列表", "Could not load worktrees")}
              {worktrees.error instanceof ApiError ? `：${worktrees.error.message}` : ""}
            </p>
          ) : (worktrees.data ?? []).length === 0 ? (
            <p className="muted-empty panel-empty">{t("暂无 worktree。", "No worktrees.")}</p>
          ) : (
            <ul className="problems-list">
              {(worktrees.data ?? []).map((worktree) => (
                <li key={worktree.name} className="scm-worktree-item">
                  <Icon name="folder" size={12} />
                  <span className="mono" title={worktree.path}>{worktree.name}</span>
                  <small className="mono">{worktree.branch}</small>
                  {!worktree.exists && <small>{t("（磁盘已缺失）", "(missing on disk)")}</small>}
                  <button
                    className="btn small scm-merge-btn"
                    aria-label={t(`合回 worktree ${worktree.name}`, `Merge worktree ${worktree.name} back`)}
                    disabled={!worktree.exists || mergeWorktree.isPending}
                    onClick={() => mergeWorktree.mutate(worktree.name)}
                  >
                    <Icon name="git" size={12} />
                    {t("合回", "Merge back")}
                  </button>
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
          {mergeConflicts && (
            <div className="scm-merge-conflicts" role="alert">
              <div className="scm-merge-conflicts-head">
                <span>{t(`合回 ${mergeConflicts.name} 的冲突文件（${mergeConflicts.conflicts.length}）`, `Conflicts merging ${mergeConflicts.name} (${mergeConflicts.conflicts.length})`)}</span>
                <button className="icon-btn" onClick={() => setMergeConflicts(undefined)} aria-label={t("关闭冲突列表", "Close conflict list")}><Icon name="x" size={14} /></button>
              </div>
              <ul className="problems-list">
                {mergeConflicts.conflicts.map((path) => (
                  <li key={path} className="scm-log-item"><code>{path}</code></li>
                ))}
              </ul>
            </div>
          )}
          <div className="scm-worktree-new">
            <input
              className="input"
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
        <section className="file-preview" aria-label={selected.untracked ? t(`预览未跟踪文件 ${selected.path}`, `Preview untracked file ${selected.path}`) : t(`查看 ${selected.path} 的 diff`, `View diff of ${selected.path}`)}>
          <header>
            <span className="mono" title={selected.path}>
              {selected.path}
              {selected.untracked ? t("（未跟踪）", " (untracked)") : selected.staged ? t("（已暂存）", " (staged)") : ""}
            </span>
            {!selected.untracked && (
              <button
                className="btn small"
                onClick={() => auxViews.openDiff({ source: "scm", path: selected.path, staged: selected.staged })}
                aria-label={t("在 diff 视图中打开（支持 hunk 接受/拒绝）", "Open in diff view (hunk accept/reject)")}
              >
                {t("在 diff 视图中打开", "Open in diff view")}
              </button>
            )}
            <button className="icon-btn" onClick={() => setSelected(undefined)} aria-label={selected.untracked ? t("关闭预览", "Close preview") : t("关闭 diff 视图", "Close diff view")}><Icon name="x" size={14} /></button>
          </header>
          {selected.untracked ? (
            untrackedFile.isError ? (
              <p className="panel-error" role="alert">
                {untrackedFile.error instanceof ApiError ? untrackedFile.error.message : t("无法读取该文件。", "Could not read this file.")}
              </p>
            ) : untrackedFile.data ? (
              <CodeBlock lang={EXT_LANGS[selected.path.split(".").pop()?.toLowerCase() ?? ""]} code={untrackedFile.data.content} />
            ) : (
              <p className="muted-empty preview-note">{t("加载中…", "Loading…")}</p>
            )
          ) : diff.isError ? (
            <p className="panel-error" role="alert">
              {diff.error instanceof ApiError ? diff.error.message : t("无法读取 diff。", "Could not load the diff.")}
            </p>
          ) : diff.data ? (
            <DiffView diff={diff.data} />
          ) : (
            <p className="muted-empty preview-note">{t("加载中…", "Loading…")}</p>
          )}
        </section>
      )}
    </div>
  );
}
