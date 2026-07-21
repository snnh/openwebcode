import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionDetail, BackgroundTaskInfo, SandboxMode, SnapshotMode } from "../lib/contracts";
import { api } from "../lib/api";
import { formatTokensShort } from "../lib/format";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

const STATE_LABELS: Record<string, [string, string]> = {
  thinking: ["思考中", "Thinking"],
  tool_running: ["执行工具", "Running tool"],
  waiting_permission: ["等待确认", "Waiting for approval"],
  budget_paused: ["预算暂停", "Budget paused"],
  error: ["错误", "Error"],
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

const STATUS_LABELS: Record<string, [string, string]> = {
  running: ["运行中", "Running"],
  done: ["完成", "Done"],
  failed: ["失败", "Failed"],
  stopped: ["已停止", "Stopped"],
};

const SANDBOX_LABELS: Record<SandboxMode, [string, string]> = {
  appcontainer: ["AppContainer", "AppContainer"],
  wsb: ["Windows Sandbox", "Windows Sandbox"],
  jobobject: ["Job Object", "Job Object"],
  off: ["关闭", "Off"],
};

export function JobHeader({ session, agentState, costSummary, onAbort, onConfig, onCreateCheckpoint, checkpointPending = false, running = false }: {
  session: SessionDetail;
  agentState?: string;
  costSummary?: CostSummary;
  onAbort(): void;
  onConfig(body: Record<string, unknown>): Promise<void>;
  /** 托管工作区的显式镜像盘快照；由 App 统一处理通知与缓存刷新。 */
  onCreateCheckpoint?(): void;
  checkpointPending?: boolean;
  /** 包含首个 agent.state 事件到达前的临时流，避免快照与运行中的会话竞态。 */
  running?: boolean;
}): ReactElement {
  const { t } = useI18n();
  const busy = isBusyState(agentState) || running;
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
    if (mode === "off" && !window.confirm(t("关闭沙盒后，命令可访问工作目录以外的文件。确定继续吗？", "With the sandbox off, commands can access files outside the workspace. Continue?"))) return;
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
              ? t(`Token 预算 ${formatTokensShort(costSummary.tokenBudget)}，已用 ${formatTokensShort(costSummary.tokens)}`, `Token budget ${formatTokensShort(costSummary.tokenBudget)}; ${formatTokensShort(costSummary.tokens)} used`)
              : t("本会话 tokens 与成本", "Tokens and cost for this session")}
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
            title={t(`${runningTasks.length} 个后台任务运行中`, `${runningTasks.length} background tasks running`)}
          >
            <Icon name="terminal" size={12} />
            {runningTasks.length}
          </button>
        )}
        {agentState && agentState !== "idle" && (
          <span className={`state-badge state-${agentState}`}>{STATE_LABELS[agentState] ? t(...STATE_LABELS[agentState]!) : agentState}</span>
        )}
        <label className={`mode-switch sandbox-mode-switch ${(session.sandboxMode ?? "appcontainer") === "off" ? "advisory" : "enforced"}`} title={t("切换当前会话的命令执行沙盒", "Change the command sandbox for this session")}>
          <Icon name="shield" size={11} />
          <span>{t("沙盒", "Sandbox")}</span>
          <select
            aria-label={t("沙盒模式", "Sandbox mode")}
            value={session.sandboxMode ?? "appcontainer"}
            disabled={busy || configPending}
            onChange={(event) => changeSandbox(event.target.value as SandboxMode)}
          >
            {(Object.keys(SANDBOX_LABELS) as SandboxMode[]).map((mode) => (
              <option key={mode} value={mode} disabled={mode === "wsb" && sandboxCapabilities.data !== undefined && !sandboxCapabilities.data.wsb.available}>
                {t(...SANDBOX_LABELS[mode])}
              </option>
            ))}
          </select>
        </label>
        <label className="mode-switch snapshot-mode-switch" title={t("自动模式会在每轮用户消息前创建检查点", "Automatic mode creates a checkpoint before each user turn")}>
          <Icon name="history" size={11} />
          <span>{t("快照", "Snapshot")}</span>
          <select
            aria-label={t("快照模式", "Snapshot mode")}
            value={session.snapshotMode ?? "auto"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ snapshotMode: event.target.value as SnapshotMode })}
          >
            <option value="auto">{t("每轮自动", "Automatic")}</option>
            <option value="manual">{t("仅手动", "Manual only")}</option>
          </select>
        </label>
        {session.workspace?.mode === "managed" && onCreateCheckpoint && (
          <button
            type="button"
            className="btn small manual-snapshot-btn"
            aria-label={t("创建虚拟磁盘快照", "Create virtual disk snapshot")}
            title={checkpointPending
              ? t("正在创建虚拟磁盘快照", "Creating virtual disk snapshot")
              : busy || configPending
                ? t("会话运行或配置更新时无法创建快照", "Cannot create a snapshot while the session is running or being updated")
                : t("立即为当前虚拟磁盘创建手动差分链快照", "Create a manual differential-disk snapshot now")}
            disabled={busy || configPending || checkpointPending}
            onClick={onCreateCheckpoint}
          >
            <Icon name="history" size={12} /> {checkpointPending ? t("创建中…", "Creating…") : t("手动快照", "Snapshot now")}
          </button>
        )}
        <a
          className="icon-btn"
          href={`/api/sessions/${session.id}/export`}
          download
          aria-label={t("导出会话", "Export session")}
          title={t("导出会话（JSONL，不含账本与 artifacts）", "Export session (JSONL, excluding ledger and artifacts)")}
        >
          <Icon name="download" size={14} />
        </a>
        {busy && (
          <button className="btn danger-outline" onClick={onAbort}>{t("中断", "Stop")}</button>
        )}
      </div>
      {tasksOpen && allTasks.length > 0 && (
        <div className="task-dropdown">
          {allTasks.map((task) => (
            <div key={task.taskId} className={`task-item task-${task.status}`}>
              <div className="task-item-header" onClick={() => openTask(task.taskId)}>
                <span className={`task-status-dot task-${task.status}`} />
                <span className="task-id mono">{task.taskId}</span>
                <span className="task-status-label">{STATUS_LABELS[task.status] ? t(...STATUS_LABELS[task.status]!) : task.status}</span>
                {task.exitCode !== undefined && <span className="task-exit-code mono">exit {task.exitCode}</span>}
                <span className="task-cmd">{task.cmd.length > 60 ? task.cmd.slice(0, 60) + "..." : task.cmd}</span>
              </div>
              {expandedTask === task.taskId && (
                <pre className="task-output mono">
                  {taskDetails[task.taskId]?.output ?? (task.status === "running" ? t("（运行中，输出累积中…）", "(Running; output is accumulating…)") : t("(无输出)", "(No output)"))}
                  {taskDetails[task.taskId]?.truncated ? t("\n…（输出过长，头部已截断）", "\n…(Output too long; beginning truncated)") : ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </header>
  );
}
