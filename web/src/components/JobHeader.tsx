import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionDetail, BackgroundTaskInfo, SandboxMode, SnapshotMode } from "../lib/contracts";
import { api } from "../lib/api";
import { formatTokensShort } from "../lib/format";
import { Icon } from "./Icon";

const STATE_LABELS: Record<string, string> = {
  thinking: "思考中",
  tool_running: "执行工具",
  waiting_permission: "等待确认",
  budget_paused: "预算暂停",
  error: "错误",
};

export function isBusyState(state?: string): boolean {
  return Boolean(state) && state !== "idle" && state !== "error";
}

export interface CostSummary {
  tokens: number;
  costLabel: string;
  tokenBudget?: number;
  paused: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  stopped: "已停止",
};

const SANDBOX_LABELS: Record<SandboxMode, string> = {
  appcontainer: "AppContainer",
  wsb: "Windows Sandbox",
  jobobject: "Job Object",
  off: "关闭",
};

export function JobHeader({ session, agentState, costSummary, onAbort, onConfig }: {
  session: SessionDetail;
  agentState?: string;
  costSummary?: CostSummary;
  onAbort(): void;
  onConfig(body: Record<string, unknown>): Promise<void>;
}): ReactElement {
  const busy = isBusyState(agentState);
  const budgetRatio = costSummary?.tokenBudget ? Math.min(1, costSummary.tokens / costSummary.tokenBudget) : undefined;
  const [tasksOpen, setTasksOpen] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [configPending, setConfigPending] = useState(false);
  // 任务列表路由不含 output（避免载荷过大），展开时按 taskId 拉详情缓存于此
  const [taskDetails, setTaskDetails] = useState<Record<string, BackgroundTaskInfo>>({});
  const tasks = useQuery({
    queryKey: ["tasks", session.id],
    queryFn: () => api.tasks(session.id),
    refetchInterval: 5_000,
  });
  const sandboxCapabilities = useQuery({
    queryKey: ["sandbox-capabilities"],
    queryFn: api.sandboxCapabilities,
    staleTime: 60_000,
  });
  const runningTasks = tasks.data?.filter((t) => t.status === "running") ?? [];
  const allTasks = tasks.data ?? [];

  const openTask = (taskId: string): void => {
    if (expandedTask === taskId) {
      setExpandedTask(null);
    } else {
      setExpandedTask(taskId);
      api.task(session.id, taskId)
        .then((detail) => setTaskDetails((prev) => ({ ...prev, [taskId]: detail })))
        .catch(() => undefined);
    }
  };

  const updateMode = (body: Record<string, unknown>): void => {
    setConfigPending(true);
    void onConfig(body).finally(() => setConfigPending(false));
  };

  const changeSandbox = (mode: SandboxMode): void => {
    if (mode === "off" && !window.confirm("关闭沙盒后，命令可访问工作目录以外的文件。确定继续吗？")) return;
    updateMode({ sandboxMode: mode, ...(mode === "wsb" && session.setupScript ? { setupScript: session.setupScript } : {}) });
  };

  return (
    <header className="job-header">
      <div className="job-title">
        <h1>{session.title}</h1>
        <p className="job-cwd mono" title={session.cwd}>{session.cwd}</p>
      </div>
      <div className="job-actions">
        {costSummary && (
          <span
            className={`cost-summary${costSummary.paused ? " paused" : ""}`}
            title={costSummary.tokenBudget
              ? `Token 预算 ${formatTokensShort(costSummary.tokenBudget)}，已用 ${formatTokensShort(costSummary.tokens)}`
              : "本会话 tokens 与成本"}
          >
            {formatTokensShort(costSummary.tokens)} tokens · {costSummary.costLabel}
            {budgetRatio !== undefined && (
              <i className="budget-bar" aria-hidden><i style={{ width: `${Math.round(budgetRatio * 100)}%` }} /></i>
            )}
          </span>
        )}
        {runningTasks.length > 0 && (
          <button
            className={`task-badge${tasksOpen ? " open" : ""}`}
            onClick={() => setTasksOpen((v) => !v)}
            title={`${runningTasks.length} 个后台任务运行中`}
          >
            <Icon name="terminal" size={12} />
            {runningTasks.length}
          </button>
        )}
        {agentState && agentState !== "idle" && (
          <span className={`state-badge state-${agentState}`}>{STATE_LABELS[agentState] ?? agentState}</span>
        )}
        <label className={`mode-switch sandbox-mode-switch ${(session.sandboxMode ?? "appcontainer") === "off" ? "advisory" : "enforced"}`} title="切换当前会话的命令执行沙盒">
          <Icon name="shield" size={11} />
          <span>沙盒</span>
          <select
            aria-label="沙盒模式"
            value={session.sandboxMode ?? "appcontainer"}
            disabled={busy || configPending}
            onChange={(event) => changeSandbox(event.target.value as SandboxMode)}
          >
            {(Object.keys(SANDBOX_LABELS) as SandboxMode[]).map((mode) => (
              <option key={mode} value={mode} disabled={mode === "wsb" && sandboxCapabilities.data !== undefined && !sandboxCapabilities.data.wsb.available}>
                {SANDBOX_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <label className="mode-switch snapshot-mode-switch" title="自动模式会在每轮用户消息前创建检查点">
          <Icon name="history" size={11} />
          <span>快照</span>
          <select
            aria-label="快照模式"
            value={session.snapshotMode ?? "auto"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ snapshotMode: event.target.value as SnapshotMode })}
          >
            <option value="auto">每轮自动</option>
            <option value="manual">仅手动</option>
          </select>
        </label>
        <a
          className="icon-btn"
          href={`/api/sessions/${session.id}/export`}
          download
          aria-label="导出会话"
          title="导出会话（JSONL，不含账本与 artifacts）"
        >
          <Icon name="download" size={14} />
        </a>
        {busy && (
          <button className="btn danger-outline" onClick={onAbort}>中断</button>
        )}
      </div>
      {tasksOpen && allTasks.length > 0 && (
        <div className="task-dropdown">
          {allTasks.map((task) => (
            <div key={task.taskId} className={`task-item task-${task.status}`}>
              <div className="task-item-header" onClick={() => openTask(task.taskId)}>
                <span className={`task-status-dot task-${task.status}`} />
                <span className="task-id mono">{task.taskId}</span>
                <span className="task-status-label">{STATUS_LABELS[task.status] ?? task.status}</span>
                {task.exitCode !== undefined && <span className="task-exit-code mono">exit {task.exitCode}</span>}
                <span className="task-cmd">{task.cmd.length > 60 ? task.cmd.slice(0, 60) + "..." : task.cmd}</span>
              </div>
              {expandedTask === task.taskId && (
                <pre className="task-output mono">
                  {taskDetails[task.taskId]?.output ?? (task.status === "running" ? "（运行中，输出累积中…）" : "(无输出)")}
                  {taskDetails[task.taskId]?.truncated ? "\n…（输出过长，头部已截断）" : ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </header>
  );
}
