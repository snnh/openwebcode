import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Icon } from "../components/Icon";
import { CodeBlock } from "../components/Markdown";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { qk } from "../app/queries";
import { ui } from "../app/ui-store";
import { auxViews } from "../workbench/aux-views";
import { useI18n } from "../i18n";

/** 会话树节点展示上限（超出时只保留最新 N 个，滚动查看；当前叶节点打开时滚动可见） */
const TIMELINE_TREE_LIMIT = 50;

/** 时间线面板：会话树（检出/分叉）+ 检查点（新建/回滚/删除/diff 视图）。数据自取，提示走 ui.notify，diff 走 auxViews。 */
export function TimelinePanel({ sessionId, running }: {
  sessionId?: string | undefined;
  running: boolean;
}): ReactElement {
  const { t, locale } = useI18n();
  const confirm = useConfirmDialog();
  const queryClient = useQueryClient();
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>();
  const checkpoints = useQuery({
    queryKey: qk.checkpoints(sessionId ?? ""),
    queryFn: () => api.checkpoints(sessionId!),
    enabled: Boolean(sessionId),
  });
  const timeline = useQuery({ queryKey: qk.timeline(sessionId ?? ""), queryFn: () => api.timeline(sessionId!), enabled: Boolean(sessionId) });
  const capability = useQuery({
    queryKey: ["snapshot-capability", sessionId],
    queryFn: () => api.snapshotCapability(sessionId!),
    enabled: Boolean(sessionId),
  });
  const diff = useQuery({
    queryKey: ["checkpoint-diff", sessionId, selectedCheckpoint],
    queryFn: () => api.checkpointDiff(sessionId!, selectedCheckpoint!),
    enabled: Boolean(sessionId && selectedCheckpoint),
  });
  const treeRef = useRef<HTMLDivElement>(null);
  const activeLeafId = timeline.data?.activeLeafId;
  const treeEntryCount = timeline.data?.entries.length ?? 0;
  // 会话树加载/检出后，滚动让当前叶节点可见（jsdom 无 scrollIntoView 时跳过）
  useEffect(() => {
    const active = treeRef.current?.querySelector(".timeline-node.active");
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
  }, [activeLeafId, treeEntryCount]);

  if (!sessionId) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("选择会话以查看检查点。", "Select a session to view checkpoints.")}</p></div>;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.checkpoints(sessionId) });
    void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
  };

  // 检出到任意树节点并从那里继续（运行中 409，由按钮禁用拦截；服务端兜底错误进 toast）
  const checkout = (messageId: string): void => {
    api.checkoutSession(sessionId, messageId)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: qk.timeline(sessionId) });
        void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
        ui.notify(t("已检出到该节点", "Checked out to this node"));
      })
      .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("检出失败", "Checkout failed"), "error"));
  };

  // 从任意树节点分叉为新会话（运行中允许），成功后切换过去
  const fork = (messageId: string): void => {
    api.forkSession(sessionId, { messageId })
      .then(({ sessionId: newSessionId }) => {
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
        ui.notify(t("已分叉到新会话", "Forked into a new session"));
        ui.selectSession(newSessionId);
      })
      .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("分叉失败", "Fork failed"), "error"));
  };

  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>{t("时间线与检查点", "Timeline & checkpoints")}</h2>
        <button
          className="btn small"
          disabled={running}
          title={running ? t("运行中无法创建检查点", "Cannot create a checkpoint while running") : t("以当前状态创建检查点", "Create a checkpoint from the current state")}
          onClick={() => {
            api.createCheckpoint(sessionId)
              .then(() => { refresh(); ui.notify(t("已创建检查点", "Checkpoint created")); })
              .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("创建检查点失败", "Could not create checkpoint"), "error"));
          }}
        >
          <Icon name="plus" size={12} /> {t("新建", "New")}
        </button>
      </div>
      {timeline.data && (
        <div className="timeline-summary" aria-label={t("会话树", "Conversation tree")}>
          <small>{t(`会话树 · ${timeline.data.entries.length} 个节点`, `Conversation tree · ${timeline.data.entries.length} nodes`)}</small>
          <div className="timeline-tree" ref={treeRef}>
            {timeline.data.entries.slice(-TIMELINE_TREE_LIMIT).map((entry) => (
              <div
                key={entry.id}
                className={`timeline-node${entry.id === activeLeafId ? " active" : ""}${entry.onActivePath === false ? " off-path" : ""}`}
              >
                <span>{entry.role}</span>
                {entry.runId && <code>{entry.turnId ?? entry.runId}</code>}
                {entry.id === activeLeafId && <b>{t("当前", "Current")}</b>}
                <span className="timeline-node-actions">
                  <button
                    type="button"
                    className="copy-btn"
                    disabled={running || entry.id === activeLeafId}
                    title={running ? t("运行中不可用", "Unavailable while running") : t("检出到该节点并从这里继续", "Check out this node and continue from here")}
                    onClick={() => checkout(entry.id)}
                  >
                    {t("继续", "Continue")}
                  </button>
                  <button
                    type="button"
                    className="copy-btn"
                    title={t("从该节点分叉为新会话", "Fork a new session from this node")}
                    onClick={() => fork(entry.id)}
                  >
                    {t("分叉", "Fork")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {capability.data && (
        <p className="backend-badge-row">
          <span className="pill small accent" title={capability.data.detail ?? capability.data.backend}>
            {capability.data.backend} · {capability.data.costHint === "instant" ? t("即时 CoW", "Instant CoW") : t("线性拷贝", "Linear copy")}
            {capability.data.requiresAdmin ? t(" · 需管理员", " · Administrator required") : ""}
          </span>
        </p>
      )}
      {capability.data?.backend === "overlayfs" && (
        <p className="muted-empty panel-empty">{t("源目录只读：改动在 merged 视图中进行，需在文件面板确认后手动同步回源。", "The source directory is read-only: changes live in the merged view and must be synced back manually from the Files panel.")}</p>
      )}
      {checkpoints.isPending && <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>}
      {checkpoints.data && checkpoints.data.length === 0 && <p className="muted-empty panel-empty">{t("暂无检查点。", "No checkpoints yet.")}</p>}
      {checkpoints.data?.map((checkpoint) => (
        <div className="checkpoint" key={checkpoint.id}>
          <button
            className="checkpoint-label"
            onClick={() => setSelectedCheckpoint((value) => (value === checkpoint.id ? undefined : checkpoint.id))}
          >
            {checkpoint.label}
          </button>
          <small>{new Date(checkpoint.createdAt).toLocaleString(locale)} · {t(`${checkpoint.messageCount} 条消息`, `${checkpoint.messageCount} messages`)}</small>
          <div className="checkpoint-actions">
            <button
              className="btn small"
              disabled={running}
              onClick={() => confirm.ask({
                title: t("完整回滚", "Full rollback"),
                body: t(`完整回滚到「${checkpoint.label}」？文件和对话将同步恢复。`, `Fully roll back to “${checkpoint.label}”? Files and conversation will both be restored.`),
                confirmLabel: t("回滚", "Roll back"),
                onConfirm: () => {
                  api.restoreCheckpoint(sessionId, checkpoint.id)
                    .then(() => { refresh(); ui.notify(t("已完整恢复检查点", "Checkpoint fully restored")); })
                    .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("回滚失败", "Rollback failed"), "error"));
                },
              })}
            >
              {t("完整回滚", "Full rollback")}
            </button>
            <button
              className="btn small"
              disabled={running}
              onClick={() => confirm.ask({
                title: t("仅恢复文件", "Restore files only"),
                body: t(`仅恢复「${checkpoint.label}」的文件？对话不会截断。`, `Restore only files from “${checkpoint.label}”? The conversation will not be truncated.`),
                confirmLabel: t("恢复", "Restore"),
                onConfirm: () => {
                  api.restoreCheckpoint(sessionId, checkpoint.id, true)
                    .then(() => { refresh(); ui.notify(t("已仅恢复文件", "Files restored")); })
                    .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("回滚失败", "Rollback failed"), "error"));
                },
              })}
            >
              {t("仅文件", "Files only")}
            </button>
            <button
              className="btn small danger-outline"
              disabled={running}
              title={t("删除该检查点", "Delete this checkpoint")}
              onClick={() => confirm.ask({
                title: t("删除检查点", "Delete checkpoint"),
                body: t(`删除检查点「${checkpoint.label}」？快照数据将一并移除。`, `Delete checkpoint “${checkpoint.label}”? Its snapshot data will also be removed.`),
                confirmLabel: t("删除", "Delete"),
                onConfirm: () => {
                  api.deleteCheckpoint(sessionId, checkpoint.id)
                    .then(() => {
                      setSelectedCheckpoint((value) => (value === checkpoint.id ? undefined : value));
                      refresh();
                      ui.notify(t("已删除检查点", "Checkpoint deleted"));
                    })
                    .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("删除检查点失败", "Could not delete checkpoint"), "error"));
                },
              })}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
          {selectedCheckpoint === checkpoint.id && (
            <>
              <button
                className="btn small"
                onClick={() => auxViews.openDiff({ source: "checkpoint", checkpointId: checkpoint.id, label: checkpoint.label })}
                aria-label={t("在 diff 视图中打开（支持 hunk 级恢复）", "Open in diff view (hunk-level restore)")}
              >
                {t("在 diff 视图中打开", "Open in diff view")}
              </button>
              {diff.data ? <CodeBlock lang="diff" code={diff.data.diff || t("（无差异）", "(No differences)")} /> : <p className="muted-empty panel-empty">{t("加载 diff…", "Loading diff…")}</p>}
            </>
          )}
        </div>
      ))}
      {confirm.dialogElement}
    </div>
  );
}
