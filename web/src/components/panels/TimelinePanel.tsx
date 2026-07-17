import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Icon } from "../Icon";
import { CodeBlock } from "../Markdown";

export function TimelinePanel({ sessionId, running, onNotice }: {
  sessionId?: string;
  running: boolean;
  onNotice(message: string): void;
}): ReactElement {
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

  if (!sessionId) return <div className="inspector-body"><p className="panel-empty">选择会话以查看检查点。</p></div>;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["checkpoints", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  };

  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>检查点</h2>
        <button
          className="btn small"
          disabled={running}
          title={running ? "运行中无法创建检查点" : "以当前状态创建检查点"}
          onClick={() => {
            api.createCheckpoint(sessionId)
              .then(() => { refresh(); onNotice("已创建检查点"); })
              .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "创建检查点失败"));
          }}
        >
          <Icon name="plus" size={12} /> 新建
        </button>
      </div>
      {capability.data && (
        <p className="backend-badge-row">
          <span className="badge backend-badge" title={capability.data.detail ?? capability.data.backend}>
            {capability.data.backend} · {capability.data.costHint === "instant" ? "即时 CoW" : "线性拷贝"}
            {capability.data.requiresAdmin ? " · 需管理员" : ""}
          </span>
        </p>
      )}
      {checkpoints.isPending && <p className="panel-empty">加载中…</p>}
      {checkpoints.data && checkpoints.data.length === 0 && <p className="panel-empty">暂无检查点。</p>}
      {checkpoints.data?.map((checkpoint) => (
        <div className="checkpoint" key={checkpoint.id}>
          <button
            className="checkpoint-label"
            onClick={() => setSelectedCheckpoint((value) => (value === checkpoint.id ? undefined : checkpoint.id))}
          >
            {checkpoint.label}
          </button>
          <small>{new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.messageCount} 条消息</small>
          <div className="checkpoint-actions">
            <button
              className="btn small"
              disabled={running}
              onClick={() => {
                if (window.confirm(`完整回滚到「${checkpoint.label}」？文件和对话将同步恢复。`)) {
                  api.restoreCheckpoint(sessionId, checkpoint.id)
                    .then(() => { refresh(); onNotice("已完整恢复检查点"); })
                    .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "回滚失败"));
                }
              }}
            >
              完整回滚
            </button>
            <button
              className="btn small"
              disabled={running}
              onClick={() => {
                if (window.confirm(`仅恢复「${checkpoint.label}」的文件？对话不会截断。`)) {
                  api.restoreCheckpoint(sessionId, checkpoint.id, true)
                    .then(() => { refresh(); onNotice("已仅恢复文件"); })
                    .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "回滚失败"));
                }
              }}
            >
              仅文件
            </button>
            <button
              className="btn small danger-outline"
              disabled={running}
              title="删除该检查点"
              onClick={() => {
                if (window.confirm(`删除检查点「${checkpoint.label}」？快照数据将一并移除。`)) {
                  api.deleteCheckpoint(sessionId, checkpoint.id)
                    .then(() => {
                      setSelectedCheckpoint((value) => (value === checkpoint.id ? undefined : value));
                      refresh();
                      onNotice("已删除检查点");
                    })
                    .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "删除检查点失败"));
                }
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
          {selectedCheckpoint === checkpoint.id && (
            diff.data ? <CodeBlock lang="diff" code={diff.data.diff || "（无差异）"} /> : <p className="panel-empty">加载 diff…</p>
          )}
        </div>
      ))}
    </div>
  );
}
