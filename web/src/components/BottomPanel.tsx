import { lazy, Suspense, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { ContextUsage, LiveSubagentRun, SessionDetail } from "../lib/contracts";
import type { ContextWindowInfo } from "../lib/context-window";
import type { DiffSpec } from "./editor/DiffPane";
import { Icon, type IconName } from "./Icon";
import { INACTIVE_STATES, stateLabel } from "../lib/agent-state";

// 底部面板标签各自独立 chunk，仅在打开对应标签页时加载；
// 文件/源代码管理/问题视图已迁至侧边栏（0.4.0 Phase 5a 五区布局）
const ContextPanel = lazy(() => import("./panels/ContextPanel").then((m) => ({ default: m.ContextPanel })));
const CostPanel = lazy(() => import("./panels/CostPanel").then((m) => ({ default: m.CostPanel })));
const SandboxPanel = lazy(() => import("./panels/SandboxPanel").then((m) => ({ default: m.SandboxPanel })));
const TimelinePanel = lazy(() => import("./panels/TimelinePanel").then((m) => ({ default: m.TimelinePanel })));
const PerfPanel = lazy(() => import("./panels/PerfPanel").then((m) => ({ default: m.PerfPanel })));
const EvalPanel = lazy(() => import("./panels/EvalPanel").then((m) => ({ default: m.EvalPanel })));
const SubagentsPanel = lazy(() => import("./panels/SubagentsPanel").then((m) => ({ default: m.SubagentsPanel })));
import { useI18n } from "../i18n";

export type PanelTab = "context" | "timeline" | "subagents" | "sandbox" | "cost" | "perf" | "eval";

const TAB_META: Record<PanelTab, { zh: string; en: string; icon: IconName }> = {
  context: { zh: "上下文", en: "Context", icon: "layers" },
  timeline: { zh: "时间线", en: "Timeline", icon: "history" },
  subagents: { zh: "子代理", en: "Subagents", icon: "git" },
  sandbox: { zh: "沙盒", en: "Sandbox", icon: "shield" },
  cost: { zh: "成本", en: "Cost", icon: "chart" },
  perf: { zh: "性能", en: "Perf", icon: "clock" },
  eval: { zh: "评测", en: "Eval", icon: "chart" },
};

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 600;

const clampHeight = (value: number): number => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value));

function readStored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 持久化失败不影响使用
  }
}

/** 桌面端并入标签条的会话状态项（原独立状态栏；cwd/沙盒由作业头展示，不重复） */
export interface PanelStatusInfo {
  state?: string | undefined;
  tokens?: number | undefined;
  costLabel?: string | undefined;
  windowPercent?: number | undefined;
}

export function BottomPanel({ sessionId, session, running, evalEnabled = false, windowUsage, latestUsage, subagentRuns, status, onNotice, open, onOpenChange, onOpenDiff, onOpenSubagentTab, onForkSession }: {
  sessionId?: string;
  session?: SessionDetail;
  running: boolean;
  evalEnabled?: boolean;
  /** 上下文窗口占用（App 下发的实时水位）；仅上下文标签页使用。 */
  windowUsage?: ContextWindowInfo;
  /** 最近一轮 token 用量（App 下发的 context.usage）；仅上下文标签页使用。 */
  latestUsage?: ContextUsage;
  /** 当前会话合并后的子代理运行（taskId → run）；仅子代理标签页使用。 */
  subagentRuns?: Record<string, LiveSubagentRun>;
  /** 桌面端会话状态项：提供时在标签条右侧渲染（移动端由独立 StatusBar 承担，不下发） */
  status?: PanelStatusInfo | undefined;
  onNotice(message: string, kind?: "info" | "error"): void;
  /** 受控开合（布局持久化在 useWorkbenchLayout，Ctrl/Cmd+` 切换） */
  open: boolean;
  onOpenChange(open: boolean): void;
  /** 0.5.0 Phase 1b：检查点对比一键在统一 diff 视图中打开（hunk 级恢复） */
  onOpenDiff?(spec: DiffSpec): void;
  /** 桌面端子代理「在标签中打开」：按 toolCallId 在主区开标签并聚焦（移动端不传） */
  onOpenSubagentTab?: ((toolCallId: string) => void) | undefined;
  /** 时间线分叉成功后切换到新会话（App 注入；不传时仅刷新会话列表） */
  onForkSession?: ((newSessionId: string) => void) | undefined;
}): ReactElement {
  const { t } = useI18n();
  const [tab, setTab] = useState<PanelTab>(() => {
    const stored = readStored("owc-panel-tab");
    return stored && stored in TAB_META ? (stored as PanelTab) : "context";
  });
  const [height, setHeight] = useState(() => clampHeight(Number(readStored("owc-panel-height")) || 260));

  useEffect(() => store("owc-panel-tab", tab), [tab]);
  useEffect(() => store("owc-panel-height", String(height)), [height]);
  useEffect(() => {
    if (!evalEnabled && tab === "eval") setTab("context");
  }, [evalEnabled, tab]);

  // 顶部拖拽调高：向上拖增大高度；键盘 ArrowUp/Down 每次 40px
  const startDrag = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (move: MouseEvent): void => setHeight(clampHeight(startHeight + (startY - move.clientY)));
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const selectTab = (item: PanelTab): void => {
    if (item === tab) onOpenChange(!open);
    else {
      setTab(item);
      onOpenChange(true);
    }
  };

  // 标签条右侧的会话状态（桌面端并入）：活跃态圆点+标签在最前，未知枚举不原样透出
  const liveStatus = status?.state && !INACTIVE_STATES.has(status.state) ? status.state : "idle";

  return (
    <section className={`bottom-panel${open ? " open" : ""}`} aria-label={t("面板", "Panel")}>
      {open && (
        <button
          className="panel-resize"
          aria-label={t("调整面板高度（方向键上下）", "Resize panel (use arrow keys)")}
          onMouseDown={startDrag}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") setHeight((value) => clampHeight(value + 40));
            if (event.key === "ArrowDown") setHeight((value) => clampHeight(value - 40));
          }}
        />
      )}
      <div className="panel-tabs">
        {(Object.keys(TAB_META) as PanelTab[]).filter((item) => item !== "eval" || evalEnabled).map((item) => (
          <button
            key={item}
            className={tab === item && open ? "active" : ""}
            aria-pressed={tab === item && open}
            onClick={() => selectTab(item)}
          >
            <Icon name={TAB_META[item].icon} size={13} />
            {t(TAB_META[item].zh, TAB_META[item].en)}
          </button>
        ))}
        {status && session && (
          <div className="panel-status" aria-label={t("会话状态", "Session status")}>
            <span className={`status-live status-${liveStatus}`}>
              <i aria-hidden /> {liveStatus === "idle" ? t("空闲", "Idle") : t(...stateLabel(liveStatus))}
            </span>
            <span>{session.agentMode ?? "code"}</span>
            <span title={`${session.provider}/${session.model}`}>{session.model}</span>
            {status.windowPercent !== undefined && <span className="status-optional" title={t("上下文窗口占用", "Context window usage")}>{t("窗口", "ctx")} {status.windowPercent}%</span>}
          </div>
        )}
        <button
          className="panel-fold"
          aria-label={open ? t("收起面板", "Collapse panel") : t("展开面板", "Expand panel")}
          onClick={() => onOpenChange(!open)}
        >
          <Icon name={open ? "chevron-down" : "chevron-up"} size={14} />
        </button>
      </div>
      {open && (
        <div className="panel-content" style={{ height }}>
          <Suspense fallback={<div className="panel-loading">{t("加载中…", "Loading…")}</div>}>
          {tab === "context" && <ContextPanel sessionId={sessionId} session={session} running={running} windowUsage={windowUsage} latestUsage={latestUsage} onNotice={onNotice} />}
          {tab === "timeline" && <TimelinePanel sessionId={sessionId} running={running} onNotice={onNotice} onOpenDiff={onOpenDiff} onForkSession={onForkSession} />}
          {tab === "subagents" && <SubagentsPanel sessionId={sessionId} runs={subagentRuns ?? {}} {...(onOpenSubagentTab ? { onOpenInTab: onOpenSubagentTab } : {})} />}
          {tab === "sandbox" && <SandboxPanel session={session} />}
          {tab === "cost" && <CostPanel />}
          {tab === "perf" && <PerfPanel sessionId={sessionId} />}
          {tab === "eval" && evalEnabled && <EvalPanel onNotice={onNotice} />}
          </Suspense>
        </div>
      )}
    </section>
  );
}
