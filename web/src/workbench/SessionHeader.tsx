/**
 * 会话头（旧 JobHeader 并入）：标题/cwd、运行状态、成本与预算条、上下文水位、
 * 缓存命中、后台任务下拉、沙盒/Shell/虚拟环境/快照模式切换、手动快照、导出、中断。
 * props 契约固定于 chat/types.ts 的 SessionHeaderProps。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type SelectHTMLAttributes } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BackgroundTaskInfo, SandboxMode, ShellBackend, NodeEnv, PythonEnv, SnapshotMode } from "../lib/contracts";
import { api } from "../lib/api";
import { formatElapsed, formatTokens, formatTokensShort } from "../lib/format";
import { isBusyState, STATE_LABELS } from "../lib/agent-state";
import { cacheHitRate, cacheTone, formatCacheTitle } from "../lib/cache-stats";
import { selectContextMetrics } from "../lib/context-metrics";
import { tasksPollInterval } from "../lib/task-poll";
import { compactionThresholdPercent, windowLevel } from "../lib/context-window";
import { useContextViewQuery, useServerSettingsQuery } from "../app/queries";
import { Icon } from "../components/Icon";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { useI18n } from "../i18n";
import { MOBILE_BREAKPOINT, useMediaQuery } from "../hooks/use-media-query";
import { MobileNavTrigger } from "./Rail";
import type { SessionHeaderProps } from "../chat/types";

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
  landlock: ["Landlock", "Landlock"],
  bubblewrap: ["bubblewrap", "bubblewrap"],
  off: ["关闭", "Off"],
};

/** 原生 select 按最长 option 撑宽，顶栏会留出大片空白；桌面端按选中项实测文本宽度收缩（+18px 箭头余量）。移动端由 CSS 百分比栏位铺满，清掉内联宽度 */
let measureCanvas: HTMLCanvasElement | undefined;
function fitSelectWidth(select: HTMLSelectElement, isMobile: boolean): void {
  if (isMobile) {
    select.style.width = "";
    return;
  }
  const text = select.selectedOptions[0]?.textContent ?? "";
  const context = (measureCanvas ??= document.createElement("canvas")).getContext("2d");
  if (!context) return; // jsdom 等无 canvas 环境跳过
  const style = getComputedStyle(select);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  select.style.width = `${Math.ceil(context.measureText(text).width) + 18}px`;
}

/** 宽度自适应选中项的 select：挂载/每次渲染后重测，onChange 时立即重测；appearance:none + 自带 chevron，规避原生箭头布局的平台差异 */
function FitSelect({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  const ref = useRef<HTMLSelectElement>(null);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  useLayoutEffect(() => {
    if (ref.current) fitSelectWidth(ref.current, isMobile);
  });
  return (
    <span className="fit-select">
      <select
        ref={ref}
        {...props}
        onChange={(event) => {
          fitSelectWidth(event.currentTarget, isMobile);
          props.onChange?.(event);
        }}
      >
        {children}
      </select>
      <Icon name="chevron-down" size={10} />
    </span>
  );
}

export function SessionHeader({ session, agentState, costSummary, windowUsage, latestUsage, running = false, checkpointPending = false, onAbort, onConfig, onCreateCheckpoint, onOpenNavMenu }: SessionHeaderProps): ReactElement {
  const { t } = useI18n();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const busy = isBusyState(agentState) || running;
  const budgetRatio = costSummary?.tokenBudget ? Math.min(1, costSummary.tokens / costSummary.tokenBudget) : undefined;
  const thresholdPercent = compactionThresholdPercent(useServerSettingsQuery().data);
  const windowState = windowLevel(windowUsage?.utilization, thresholdPercent);
  const windowPct = windowUsage?.utilization !== undefined ? Math.round((windowUsage?.utilization ?? 0) * 100) : undefined;
  // 会话累计用量（ledger.usage 切片订阅——账本其余变化不重渲顶栏）：
  // 顶栏缓存命中率用累计口径，查询未返回前回退到最近一轮（latestUsage）
  const contextQuery = useContextViewQuery(session.id, selectContextMetrics);
  const cumulativeUsage = contextQuery.data?.usage;
  const cacheSource = cumulativeUsage ?? latestUsage;
  const cache = cacheSource ? cacheHitRate(cacheSource) : undefined;
  const [tasksOpen, setTasksOpen] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [configPending, setConfigPending] = useState(false);
  // 移动端顶栏默认紧凑（下拉与导出收进展开区），本地已有记录时以用户选择为准
  const [headerCollapsed, setHeaderCollapsed] = useState(() => {
    const stored = localStorage.getItem("owc-header-collapsed");
    if (stored === "1" || stored === "0") return stored === "1";
    return isMobile;
  });
  // 任务列表路由不含 output（避免载荷过大），展开时按 taskId 拉详情缓存于此
  const [taskDetails, setTaskDetails] = useState<Record<string, BackgroundTaskInfo>>({});
  const tasks = useQuery({
    queryKey: ["tasks", session.id],
    queryFn: () => api.tasks(session.id),
    // 轮询收敛：即时性走 task.started/finished 事件 invalidate；活跃 5s、空闲 30s 兜底
    refetchInterval: (query) => {
      const data = query.state.data as BackgroundTaskInfo[] | undefined;
      return tasksPollInterval(Boolean(data?.some((task) => task.status === "running")), tasksOpen);
    },
  });
  const sandboxCapabilities = useQuery({
    queryKey: ["sandbox-capabilities"],
    queryFn: api.sandboxCapabilities,
    staleTime: 60_000,
  });
  // env-sim 人格清单：仅人格生效时拉取（会话级覆盖下拉供数；扩展宿主不可用时静默为空）
  const personas = useQuery({
    queryKey: ["env-sim-personas"],
    queryFn: api.envSimPersonas,
    enabled: Boolean(session.activePersona),
    staleTime: 60_000,
    retry: false,
  });
  // 弹层排序：运行中在前（startedAt 升序），已结束后随（finishedAt 降序，弱化显示）
  const sortedTasks = useMemo(() => {
    const all = tasks.data ?? [];
    const live = all.filter((task) => task.status === "running").sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const settled = all.filter((task) => task.status !== "running")
      .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt));
    return [...live, ...settled];
  }, [tasks.data]);
  const runningTasks = useMemo(() => sortedTasks.filter((task) => task.status === "running"), [sortedTasks]);
  // 运行中耗时每秒走动：弹层打开且有活任务时才起一个 interval，关闭/无活任务即停
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (!tasksOpen || runningTasks.length === 0) return undefined;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tasksOpen, runningTasks.length]);
  // Esc/外部按下关闭弹层并还焦触发按钮；最后一个任务消失时先关弹层（焦点不随卸载丢失）
  const tasksTriggerRef = useRef<HTMLButtonElement>(null);
  const tasksDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tasksOpen) return undefined;
    const close = (refocus: boolean): void => {
      setTasksOpen(false);
      if (refocus) tasksTriggerRef.current?.focus();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close(true);
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (tasksDropdownRef.current?.contains(target) || tasksTriggerRef.current?.contains(target)) return;
      close(true);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [tasksOpen]);
  useEffect(() => {
    if (tasksOpen && tasks.data !== undefined && sortedTasks.length === 0) {
      setTasksOpen(false);
      tasksTriggerRef.current?.focus();
    }
  }, [tasksOpen, tasks.data, sortedTasks.length]);
  // 平台来源统一为 server 上报的 capabilities.platform；未拿到前保持 Windows 行为（现状）
  const isWindows = sandboxCapabilities.data?.platform === undefined || sandboxCapabilities.data.platform === "win32";
  const currentSandboxMode = session.sandboxMode ?? "appcontainer";
  // POSIX 真值选项：landlock（兼容档）/ bubblewrap（默认档）/ off；Windows 维持 appcontainer/jobobject/wsb/off
  const sandboxModeOptions: SandboxMode[] = isWindows
    ? ["appcontainer", "wsb", "jobobject", "off"]
    : ["landlock", "bubblewrap", "off"];
  // 未设置（内部默认 appcontainer）在 POSIX 按 bubblewrap 显示；存量 Linux 会话 meta 可能是 jobobject，选中项按 landlock 显示（切换时提交真值）
  const selectedSandboxMode: SandboxMode = !isWindows
    ? currentSandboxMode === "jobobject" ? "landlock" : currentSandboxMode === "appcontainer" ? "bubblewrap" : currentSandboxMode
    : currentSandboxMode;
  // 异常存量值（如 Linux 会话存了 wsb）兜底保留，避免下拉落空
  if (!sandboxModeOptions.includes(selectedSandboxMode)) sandboxModeOptions.push(selectedSandboxMode);
  // bubblewrap 不可用时禁用该选项（旧 core 不上报 features.bwrap 时 server 按 unavailable 返回）
  const bwrapUnavailableReason = !isWindows && sandboxCapabilities.data?.bwrap?.available === false
    ? sandboxCapabilities.data.bwrap?.reason ?? t("当前环境未安装 bubblewrap", "bubblewrap is not available in this environment")
    : undefined;
  // Linux 通常没有 CMD / pwsh：隐藏，但当前会话已选中时保留以免下拉落空
  const shellOptions: { value: ShellBackend; label: [string, string] }[] = [
    { value: "default", label: ["默认", "Default"] },
    ...(isWindows || session.shellBackend === "pwsh" ? [{ value: "pwsh" as const, label: ["PowerShell 7", "PowerShell 7"] as [string, string] }] : []),
    { value: "bash", label: ["Bash", "Bash"] },
    ...(isWindows || session.shellBackend === "cmd" ? [{ value: "cmd" as const, label: ["CMD", "CMD"] as [string, string] }] : []),
  ];

  useEffect(() => { localStorage.setItem("owc-header-collapsed", headerCollapsed ? "1" : "0"); }, [headerCollapsed]);

  const openTask = (taskId: string): void => {
    if (expandedTask === taskId) {
      setExpandedTask(null);
    } else {
      setExpandedTask(taskId);
      api.task(session.id, taskId)
        .then((detail) => setTaskDetails((previous) => ({ ...previous, [taskId]: detail })))
        .catch(() => undefined);
    }
  };

  const confirm = useConfirmDialog();

  const updateMode = (body: Record<string, unknown>): void => {
    setConfigPending(true);
    // 契约上 onConfig 返回 void；装配层实际返回 Promise，这里兼容两者
    void Promise.resolve(onConfig(body) as unknown)
      .catch((error: unknown) => {
        // 配置触发持久 shell 回收且有 !cmd 在途（409 SHELL_PENDING）：确认后以 force 重发。
        // 其余错误已由 onConfig 通知，吞掉不再重复提示（不能再抛，否则 void 后成未处理 rejection）
        if (body.force !== true && error instanceof Error && (error as { code?: string }).code === "SHELL_PENDING") {
          confirm.ask({
            title: t("中断 shell 命令", "Interrupt shell command"),
            body: t("当前会话有 shell 命令正在执行或等待审批。应用此更改将中断该命令。确定继续吗？", "A shell command is running or awaiting approval in this session. Applying this change will interrupt it. Continue?"),
            confirmLabel: t("中断并应用", "Interrupt and apply"),
            danger: true,
            onConfirm: () => updateMode({ ...body, force: true }),
          });
        }
      })
      .finally(() => setConfigPending(false));
  };

  const changeSandbox = (mode: SandboxMode): void => {
    const apply = (): void => updateMode({ sandboxMode: mode, ...(mode === "wsb" && session.setupScript ? { setupScript: session.setupScript } : {}) });
    if (mode === "off") {
      confirm.ask({
        title: t("关闭沙盒", "Turn off sandbox"),
        body: t("关闭沙盒后，命令可访问工作目录以外的文件。确定继续吗？", "With the sandbox off, commands can access files outside the workspace. Continue?"),
        confirmLabel: t("关闭沙盒", "Turn off sandbox"),
        danger: false,
        onConfirm: apply,
      });
      return;
    }
    apply();
  };

  // 运行状态项与展开/收起钮：桌面端在信息行/行1，移动端挪到 cwd 行（两行结构，信息行不折行）
  const stateItem = agentState && agentState !== "idle" ? (
    <span className={`job-info-state${agentState === "error" || agentState === "failed" ? " danger" : agentState === "aborted" ? " amber" : ""}`}>
      <i className="info-dot" aria-hidden />
      {STATE_LABELS[agentState] ? t(...STATE_LABELS[agentState]!) : agentState}
    </span>
  ) : null;
  const toggleButton = (
    <button
      type="button"
      className="job-header-toggle"
      aria-label={headerCollapsed ? t("展开顶栏", "Expand header") : t("收起顶栏", "Collapse header")}
      title={headerCollapsed ? t("展开顶栏", "Expand header") : t("收起顶栏", "Collapse header")}
      onClick={() => setHeaderCollapsed((value) => !value)}
    >
      <Icon name={headerCollapsed ? "chevron-down" : "chevron-up"} size={12} />
    </button>
  );

  return (
    <header className={`job-header${headerCollapsed ? " compact" : ""}`}>
      <div className="job-header-info">
        {onOpenNavMenu && <MobileNavTrigger onOpen={onOpenNavMenu} />}
        <div className="job-title">
          <h1>{session.title}</h1>
          {/* 桌面端 cwd 在标题下（compact 由 CSS 隐藏）；移动端 cwd 在下方 job-header-sub 行 */}
          {!isMobile && <p className="job-cwd mono" title={session.cwd}>{session.cwd}{session.kind === "local" && <span className="local-badge">{t("本机", "LOCAL")}</span>}</p>}
        </div>
        <div className="job-info">
        {costSummary && (
          <span
            className={`cost-summary${costSummary.paused ? " paused" : ""}`}
            title={(costSummary.tokenBudget
              ? t(`Token 预算 ${formatTokensShort(costSummary.tokenBudget)}，已用 ${formatTokensShort(costSummary.tokens)}`, `Token budget ${formatTokensShort(costSummary.tokenBudget)}; ${formatTokensShort(costSummary.tokens)} used`)
              : t("本会话 tokens 与成本", "Tokens and cost for this session"))
              + ((costSummary.unpricedTokens ?? 0) > 0
                ? t(`；另有 ${formatTokensShort(costSummary.unpricedTokens!)} tokens 未定价，成本不完整`, `; ${formatTokensShort(costSummary.unpricedTokens!)} additional tokens unpriced, cost is incomplete`)
                : "")}
          >
            <span className="cost-summary-text">
              {formatTokensShort(costSummary.tokens)}
              <span className="unit-full"> tokens</span><span className="unit-narrow"> tok</span>
              <i className="dot-sep" aria-hidden />{costSummary.costLabel}{(costSummary.unpricedTokens ?? 0) > 0 ? " *" : ""}
            </span>
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
            <span className="window-usage-text">
              {windowUsage.contextWindow && windowPct !== undefined
                ? <>{formatTokensShort(windowUsage.estimatedTokens)}/{formatTokensShort(windowUsage.contextWindow)}<i className="dot-sep" aria-hidden />{windowPct}%</>
                : `${formatTokensShort(windowUsage.estimatedTokens)} ${t("上下文", "context")}`}
            </span>
          </span>
        )}
        {cache && cache.rate !== null && (cache.cacheRead > 0 || cache.cacheWrite > 0) && (
          <span
            className="window-usage cache-usage"
            data-testid="cache-usage"
            data-tone={cacheTone(cache)}
            title={formatCacheTitle(cache, { cumulative: cumulativeUsage !== undefined }, t, formatTokensShort)}
          >
            <span className="window-usage-text">
              {t("缓存", "cache")} {Math.round(cache.rate * 100)}%
              <span className="unit-full"> · {cumulativeUsage !== undefined ? t("累计", "sess") : t("本轮", "last")}</span>
            </span>
          </span>
        )}
        {runningTasks.length > 0 && (
          <button
            type="button"
            ref={tasksTriggerRef}
            className={`job-info-btn${tasksOpen ? " open" : ""}`}
            aria-expanded={tasksOpen}
            onClick={() => setTasksOpen((value) => !value)}
            title={t(`${runningTasks.length} 个后台任务运行中`, `${runningTasks.length} background tasks running`)}
          >
            <i className="info-dot" aria-hidden />
            {t("任务", "tasks")} {runningTasks.length}
          </button>
        )}
        {!isMobile && stateItem}
        {session.activePersona && (
          <label
            className="mode-switch persona-switch"
            title={t(`env-sim 人格模拟生效：${session.activePersona.name}（点击切换会话级人格）`, `env-sim persona active: ${session.activePersona.name} (click to override for this session)`)}
          >
            <Icon name="layers" size={11} />
            <FitSelect
              aria-label={t("人格模拟", "Persona")}
              value={session.persona ?? ""}
              disabled={busy || configPending}
              onChange={(event) => updateMode({ persona: event.target.value })}
            >
              <option value="">{t(`跟随扩展配置（${session.activePersona.name}）`, `Follow extension config (${session.activePersona.name})`)}</option>
              {(personas.data?.personas ?? []).map((persona) => (
                <option key={persona.id} value={persona.id}>{persona.overridden === true ? t(`${persona.name}（已自定义）`, `${persona.name} (customized)`) : persona.name}</option>
              ))}
            </FitSelect>
          </label>
        )}
        </div>
        {!isMobile && toggleButton}
      </div>
      {isMobile && (
        <div className="job-header-sub">
          <p className="job-cwd mono" title={session.cwd}>{session.cwd}{session.kind === "local" && <span className="local-badge">{t("本机", "LOCAL")}</span>}</p>
          {stateItem}
          {toggleButton}
        </div>
      )}
      {!headerCollapsed && <div className="job-actions">
        {/* 本机会话固定 off 沙盒：不提供切换（服务端也拒绝变更） */}
        {session.kind !== "local" && (
        <label className={`mode-switch sandbox-mode-switch ${(session.sandboxMode ?? "appcontainer") === "off" ? "advisory" : "enforced"}`} title={t("切换当前会话的命令执行沙盒", "Change the command sandbox for this session")}>
          <Icon name="box" size={11} />
          <span>{t("沙盒", "Sandbox")}</span>
          <FitSelect
            aria-label={t("沙盒模式", "Sandbox mode")}
            value={selectedSandboxMode}
            disabled={busy || configPending}
            onChange={(event) => changeSandbox(event.target.value as SandboxMode)}
          >
            {sandboxModeOptions.map((mode) => (
              <option
                key={mode}
                value={mode}
                disabled={(mode === "wsb" && sandboxCapabilities.data !== undefined && !sandboxCapabilities.data.wsb.available) || (mode === "bubblewrap" && bwrapUnavailableReason !== undefined)}
                title={mode === "bubblewrap" ? bwrapUnavailableReason : undefined}
              >
                {t(...SANDBOX_LABELS[mode])}
              </option>
            ))}
          </FitSelect>
        </label>
        )}
        <label className="mode-switch shell-backend-switch" title={t("选择当前会话命令使用的解释器", "Choose the command shell for this session")}>
          <Icon name="terminal" size={11} />
          <span>Shell</span>
          <FitSelect
            aria-label={t("Shell 后端", "Shell backend")}
            value={session.shellBackend ?? "default"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ shellBackend: event.target.value as ShellBackend })}
          >
            {shellOptions.map((option) => (
              <option key={option.value} value={option.value}>{t(...option.label)}</option>
            ))}
          </FitSelect>
        </label>
        <label className="mode-switch python-env-switch" title={t("选择当前会话 bash 的虚拟环境（Python）", "Choose the virtual environment (Python) for bash in this session")}>
          <Icon name="layers" size={11} />
          <span>{t("虚拟环境", "Env")}</span>
          <FitSelect
            aria-label={t("虚拟环境", "Virtual environment")}
            value={session.pythonEnv ?? "global"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ pythonEnv: event.target.value as PythonEnv })}
          >
            <option value="global">{t("本机环境", "Host")}</option>
            <option value="uv-workspace">{t("uv·工作区", "uv · workspace")}</option>
            <option value="uv-config">{t("uv·配置目录", "uv · config dir")}</option>
          </FitSelect>
        </label>
        <label className="mode-switch node-env-switch" title={t("选择当前会话 bash 的 Node 环境", "Choose the Node environment for bash in this session")}>
          <Icon name="layers" size={11} />
          <span>{t("Node 环境", "Node")}</span>
          <FitSelect
            aria-label={t("Node 环境", "Node environment")}
            value={session.nodeEnv ?? "global"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ nodeEnv: event.target.value as NodeEnv })}
          >
            <option value="global">{t("本机 global", "Host global")}</option>
            <option value="project">{t("工作区 project", "Workspace project")}</option>
            <option value="fnm">fnm</option>
            <option value="nvm">nvm</option>
          </FitSelect>
        </label>
        <label className="mode-switch snapshot-mode-switch" title={t("自动模式会在每轮用户消息前创建检查点", "Automatic mode creates a checkpoint before each user turn")}>
          <Icon name="history" size={11} />
          <span>{t("快照", "Snapshot")}</span>
          <FitSelect
            aria-label={t("快照模式", "Snapshot mode")}
            value={session.snapshotMode ?? "auto"}
            disabled={busy || configPending}
            onChange={(event) => updateMode({ snapshotMode: event.target.value as SnapshotMode })}
          >
            <option value="auto">{t("每轮自动", "Automatic")}</option>
            <option value="manual">{t("仅手动", "Manual only")}</option>
          </FitSelect>
        </label>
        {session.workspace?.mode === "managed" && (
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
      {tasksOpen && sortedTasks.length > 0 && (
        <div className="task-dropdown" ref={tasksDropdownRef}>
          {sortedTasks.map((task) => {
            const elapsedMs = task.status === "running"
              ? (nowTick || Date.now()) - Date.parse(task.startedAt)
              : Date.parse(task.finishedAt ?? task.startedAt) - Date.parse(task.startedAt);
            return (
            <div key={task.taskId} className={`task-item task-${task.status}`}>
              <div className="task-item-header" role="button" tabIndex={0} aria-expanded={expandedTask === task.taskId} onClick={() => openTask(task.taskId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTask(task.taskId); } }}>
                <span className={`task-status-dot task-${task.status}`} />
                <span className="task-id mono">{task.taskId}</span>
                <span className="task-status-label">{STATUS_LABELS[task.status] ? t(...STATUS_LABELS[task.status]!) : task.status}</span>
                {task.exitCode !== undefined && <span className="task-exit-code mono">exit {task.exitCode}</span>}
                <span className="task-elapsed mono" title={task.status === "running" ? t("已运行时长", "Elapsed") : t("总耗时", "Duration")}>{formatElapsed(elapsedMs)}</span>
                <span className="task-cmd" title={task.cmd}>{task.cmd}</span>
              </div>
              {expandedTask === task.taskId && (
                <pre className="task-output mono">
                  {taskDetails[task.taskId]?.output ?? (task.status === "running" ? t("（运行中，输出累积中…）", "(Running; output is accumulating…)") : t("(无输出)", "(No output)"))}
                  {taskDetails[task.taskId]?.truncated ? t("\n…（输出过长，头部已截断）", "\n…(Output too long; beginning truncated)") : ""}
                </pre>
              )}
            </div>
            );
          })}
        </div>
      )}
      {confirm.dialogElement}
    </header>
  );
}
