import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Icon } from "../Icon";
import { CodeBlock } from "../Markdown";
import { useI18n } from "../../i18n";

export function TimelinePanel({ sessionId, running, onNotice }: {
  sessionId?: string;
  running: boolean;
  onNotice(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>();
  const checkpoints = useQuery({
    queryKey: ["checkpoints", sessionId],
    queryFn: () => api.checkpoints(sessionId!),
    enabled: Boolean(sessionId),
  });
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

  if (!sessionId) return <div className="inspector-body"><p className="panel-empty">{t("选择会话以查看检查点。", "Select a session to view checkpoints.")}</p></div>;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["checkpoints", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  };

  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>{t("检查点", "Checkpoints")}</h2>
        <button
          className="btn small"
          disabled={running}
          title={running ? t("运行中无法创建检查点", "Cannot create a checkpoint while running") : t("以当前状态创建检查点", "Create a checkpoint from the current state")}
          onClick={() => {
            api.createCheckpoint(sessionId)
              .then(() => { refresh(); onNotice(t("已创建检查点", "Checkpoint created")); })
              .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("创建检查点失败", "Could not create checkpoint"), "error"));
          }}
        >
          <Icon name="plus" size={12} /> {t("新建", "New")}
        </button>
      </div>
      {capability.data && (
        <p className="backend-badge-row">
          <span className="badge backend-badge" title={capability.data.detail ?? capability.data.backend}>
            {capability.data.backend} · {capability.data.costHint === "instant" ? t("即时 CoW", "Instant CoW") : t("线性拷贝", "Linear copy")}
            {capability.data.requiresAdmin ? t(" · 需管理员", " · Administrator required") : ""}
          </span>
        </p>
      )}
      {checkpoints.isPending && <p className="panel-empty">{t("加载中…", "Loading…")}</p>}
      {checkpoints.data && checkpoints.data.length === 0 && <p className="panel-empty">{t("暂无检查点。", "No checkpoints yet.")}</p>}
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
              onClick={() => {
                if (window.confirm(t(`完整回滚到「${checkpoint.label}」？文件和对话将同步恢复。`, `Fully roll back to “${checkpoint.label}”? Files and conversation will both be restored.`))) {
                  api.restoreCheckpoint(sessionId, checkpoint.id)
                    .then(() => { refresh(); onNotice(t("已完整恢复检查点", "Checkpoint fully restored")); })
                    .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("回滚失败", "Rollback failed"), "error"));
                }
              }}
            >
              {t("完整回滚", "Full rollback")}
            </button>
            <button
              className="btn small"
              disabled={running}
              onClick={() => {
                if (window.confirm(t(`仅恢复「${checkpoint.label}」的文件？对话不会截断。`, `Restore only files from “${checkpoint.label}”? The conversation will not be truncated.`))) {
                  api.restoreCheckpoint(sessionId, checkpoint.id, true)
                    .then(() => { refresh(); onNotice(t("已仅恢复文件", "Files restored")); })
                    .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("回滚失败", "Rollback failed"), "error"));
                }
              }}
            >
              {t("仅文件", "Files only")}
            </button>
            <button
              className="btn small danger-outline"
              disabled={running}
              title={t("删除该检查点", "Delete this checkpoint")}
              onClick={() => {
                if (window.confirm(t(`删除检查点「${checkpoint.label}」？快照数据将一并移除。`, `Delete checkpoint “${checkpoint.label}”? Its snapshot data will also be removed.`))) {
                  api.deleteCheckpoint(sessionId, checkpoint.id)
                    .then(() => {
                      setSelectedCheckpoint((value) => (value === checkpoint.id ? undefined : value));
                      refresh();
                      onNotice(t("已删除检查点", "Checkpoint deleted"));
                    })
                    .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("删除检查点失败", "Could not delete checkpoint"), "error"));
                }
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
          {selectedCheckpoint === checkpoint.id && (
            diff.data ? <CodeBlock lang="diff" code={diff.data.diff || t("（无差异）", "(No differences)")} /> : <p className="panel-empty">{t("加载 diff…", "Loading diff…")}</p>
          )}
        </div>
      ))}
    </div>
  );
}
