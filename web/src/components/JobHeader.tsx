import { useState, useEffect, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionDetail, BackgroundTaskInfo, ContextUsage, PythonEnv, SandboxMode, ShellBackend, SnapshotMode } from "../lib/contracts";
import { api } from "../lib/api";
import { formatTokens, formatTokensShort } from "../lib/format";
import { isBusyState, STATE_LABELS } from "../lib/agent-state";
import { cacheHitRate } from "../lib/cache-stats";
import { windowLevel, type ContextWindowInfo } from "../lib/context-window";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";
import { MOBILE_BREAKPOINT } from "../hooks/use-media-query";

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

export function JobHeader({ session, agentState, costSummary, windowUsage, latestUsage, onAbort, onConfig, onCreateCheckpoint, checkpointPending = false, running = false }: {
  session: SessionDetail;
  agentState?: string;
  costSummary?: CostSummary;
  /** 上下文窗口占用（WS 水位优先，REST stats 播种）；无时隐藏。 */
  windowUsage?: ContextWindowInfo;
  /** 最近一轮 token 用量（WS context.usage）；驱动缓存命中率 pill，无时隐藏。 */
  latestUsage?: ContextUsage;
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
  const windowState = windowLevel(windowUsage?.utilization);
  const windowPct = windowUsage?.utilization !== undefined ? Math.round((windowUsage?.utilization ?? 0) * 100) : undefined;
  const cache = latestUsage ? cacheHitRate(latestUsage) : undefined;
  const [tasksOpen, setTasksOpen] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [configPending, setConfigPending] = useState(false);
  // 移动端顶栏默认紧凑（下拉与导出收进展开区），本地已有记录时以用户选择为准
  const [headerCollapsed, setHeaderCollapsed] = useState(() => {
    const stored = localStorage.getItem("owc-header-collapsed");
    if (stored === "1" || stored === "0") return stored === "1";
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_BREAKPOINT).matches;
  });
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

  useEffect(() => { localStorage.setItem("owc-header-collapsed", headerCollapsed ? "1" : "0"); }, [headerCollapsed]);

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
    <header className={`job-header${headerCollapsed ? " compact" : ""}`}>
      <div className="job-header-info">
        <div className="job-title">
          <h1>{session.title}</h1>
          {!headerCollapsed && <p className="job-cwd mono" title={session.cwd}>{session.cwd}</p>}
        </div>
        <div className="job-info">
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
        {windowUsage && (
          <span
            className="window-usage"
            data-testid="window-usage"
            data-level={windowState}
            title={windowUsage.contextWindow
              ? t(`上下文窗口 ${formatTokens(windowUsage.estimatedTokens)} / ${formatTokens(windowUsage.contextWindow)} tokens（${windowPct ?? 0}%）`, `Context window ${formatTokens(windowUsage.estimatedTokens)} / ${formatTokens(windowUsage.contextWindow)} tokens (${windowPct ?? 0}%)`)
              : t(`当前上下文约 ${formatTokens(windowUsage.estimatedTokens)} tokens`, `Current context ≈ ${formatTokens(windowUsage.estimatedTokens)} tokens`)}
          >
            {windowUsage.contextWindow && windowPct !== undefined
              ? `${formatTokensShort(windowUsage.estimatedTokens)}/${formatTokensShort(windowUsage.contextWindow)} · ${windowPct}%`
              : `${formatTokensShort(windowUsage.estimatedTokens)} ${t("上下文", "context")}`}
            {windowPct !== undefined && (
              <i className={`budget-bar${windowState !== "normal" ? ` level-${windowState}` : ""}`} aria-hidden><i style={{ width: `${Math.min(100, windowPct)}%` }} /></i>
            )}
          </span>
        )}
        {latestUsage && cache && cache.rate !== null && (
          <span
            className="window-usage cache-usage"
            data-testid="cache-usage"
            title={t(
              `缓存读取 ${formatTokensShort(cache.cacheRead)} · 写入 ${formatTokensShort(cache.cacheWrite)} · 未缓存输入 ${formatTokensShort(latestUsage.inputTokens)}`,
              `Cache read ${formatTokensShort(cache.cacheRead)} · write ${formatTokensShort(cache.cacheWrite)} · uncached input ${formatTokensShort(latestUsage.inputTokens)}`,
            )}
          >
            {t("缓存", "cache")} {Math.round(cache.rate * 100)}%
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
        {session.activePersona && (
          <span
            className="persona-badge"
            title={t(`env-sim 人格模拟生效：${session.activePersona.name}`, `env-sim persona active: ${session.activePersona.name}`)}
          >
            <Icon name="layers" size={11} />
            {session.activePersona.name}
          </span>
        )}
        </div>
        <button
          type="button"
          className="job-header-toggle"
          aria-label={headerCollapsed ? t("展开顶栏", "Expand header") : t("收起顶栏", "Collapse header")}
          title={headerCollapsed ? t("展开顶栏", "Expand header") : t("收起顶栏", "Collapse header")}
          onClick={() => setHeaderCollapsed((v) => !v)}
        >
          <Icon name={headerCollapsed ? "chevron-down" : "chevron-up"} size={12} />
        </button>
      </div>
      {!headerCollapsed && <div className="job-actions">
        <label className={`mode-switch sandbox-mode-switch ${(session.sandboxMode ?? "jobobject") === "off" ? "advisory" : "enforced"}`} title={t("切换当前会话的命令执行沙盒", "Change the command sandbox for this session")}>
          <Icon name="shield" size={11} />
          <span>{t("沙盒", "Sandbox")}</span>
          <select
            aria-label={t("沙盒模式", "Sandbox mode")}
            value={session.sandboxMode ?? "jobobject"}
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
        <label className="mode-switch shell-backend-switch" title={t("选择当前会话命令使用的解释器", "Choose the command shell for this session")}>
          <Icon name="terminal" size={11} />
          <span>Shell</span>
          <select
            aria-label={t("Shell 后端", "Shell backend")}
            value={session.shellBackend ?? "default"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ shellBackend: event.target.value as ShellBackend })}
          >
            <option value="default">{t("默认", "Default")}</option>
            <option value="pwsh">PowerShell 7</option>
            <option value="bash">Bash</option>
            <option value="cmd">CMD</option>
          </select>
        </label>
        <label className="mode-switch python-env-switch" title={t("选择当前会话 bash 的 python 运行环境", "Choose the python environment for bash in this session")}>
          <Icon name="terminal" size={11} />
          <span>Python</span>
          <select
            aria-label={t("Python 环境", "Python environment")}
            value={session.pythonEnv ?? "global"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ pythonEnv: event.target.value as PythonEnv })}
          >
            <option value="global">{t("本机环境", "Host")}</option>
            <option value="uv-workspace">{t("uv·工作区", "uv · workspace")}</option>
            <option value="uv-config">{t("uv·配置目录", "uv · config dir")}</option>
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
        <a
          className="icon-btn"
          href={`/api/sessions/${session.id}/export.md`}
          download
          aria-label={t("导出 Markdown", "Export Markdown")}
          title={t("导出会话为 Markdown 文档", "Export session as a Markdown document")}
        >
          <Icon name="file" size={14} />
        </a>
        {busy && (
          <button className="btn danger-outline" onClick={onAbort}>{t("中断", "Stop")}</button>
        )}
      </div>}
      {tasksOpen && allTasks.length > 0 && (
        <div className="task-dropdown">
          {allTasks.map((task) => (
            <div key={task.taskId} className={`task-item task-${task.status}`}>
              <div className="task-item-header" role="button" tabIndex={0} onClick={() => openTask(task.taskId)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTask(task.taskId); } }}>
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
