import { lazy, Suspense, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { Icon, type IconName } from "../components/Icon";
import { INACTIVE_STATES, stateLabel } from "../lib/agent-state";
import { deriveWindowInfo } from "../lib/context-window";
import { formatCurrency, formatTokensShort } from "../lib/format";
import { useStore } from "../app/store";
import { sessionStore } from "../app/session-store";
import { useContextViewQuery, useExtensionsQuery, useModelsQuery, useSessionsQuery } from "../app/queries";
import { layout, layoutStore, type BottomTab } from "./layout";
import { useI18n } from "../i18n";

// 底部面板标签各自独立 chunk，仅在打开对应标签页时加载
const ContextPanel = lazy(() => import("../panels/ContextPanel").then((m) => ({ default: m.ContextPanel })));
const TimelinePanel = lazy(() => import("../panels/TimelinePanel").then((m) => ({ default: m.TimelinePanel })));
const SubagentsPanel = lazy(() => import("../panels/SubagentsPanel").then((m) => ({ default: m.SubagentsPanel })));
const SandboxPanel = lazy(() => import("../panels/SandboxPanel").then((m) => ({ default: m.SandboxPanel })));
const CostPanel = lazy(() => import("../panels/CostPanel").then((m) => ({ default: m.CostPanel })));
const PerfPanel = lazy(() => import("../panels/PerfPanel").then((m) => ({ default: m.PerfPanel })));
const EvalPanel = lazy(() => import("../panels/EvalPanel").then((m) => ({ default: m.EvalPanel })));

/** 移动端常驻标签（其余折叠进第二行，默认收起） */
const PRIMARY_TABS: BottomTab[] = ["context", "timeline", "cost"];

const TAB_META: Record<BottomTab, { zh: string; en: string; icon: IconName }> = {
  context: { zh: "上下文", en: "Context", icon: "layers" },
  timeline: { zh: "时间线", en: "Timeline", icon: "history" },
  cost: { zh: "成本", en: "Cost", icon: "chart" },
  subagents: { zh: "子代理", en: "Subagents", icon: "git" },
  sandbox: { zh: "沙盒", en: "Sandbox", icon: "shield" },
  perf: { zh: "性能", en: "Perf", icon: "clock" },
  eval: { zh: "评测", en: "Eval", icon: "chart" },
};

/** 标签条右侧的会话状态项：状态点+文案（移动端仅此项），桌面加 tokens·成本与窗口占用 %（语义沿用旧状态行） */
function PanelStatus({ sessionId, agentState, mobile }: { sessionId: string; agentState?: string | undefined; mobile: boolean }): ReactElement {
  const { t } = useI18n();
  const sessions = useSessionsQuery();
  const contextView = useContextViewQuery(sessionId);
  const models = useModelsQuery();
  const watermark = useStore(sessionStore, (state) => state.watermarks[sessionId]);
  const liveStatus = agentState && !INACTIVE_STATES.has(agentState) ? agentState : "idle";

  const session = sessions.data?.find((item) => item.id === sessionId);
  const costSummary = useMemo(() => {
    const ledger = contextView.data?.ledger;
    if (!ledger || !contextView.data) return undefined;
    const currency = contextView.data.preferences.currency;
    return {
      tokens: ledger.usage.inputTokens + ledger.usage.outputTokens,
      costLabel: formatCurrency(currency === "CNY" ? ledger.cost.cnyMicroUnits : ledger.cost.usdMicroUnits, currency),
    };
  }, [contextView.data]);
  const model = useMemo(
    () => models.data?.find((item) => item.id === session?.model && item.provider === session?.provider),
    [models.data, session?.model, session?.provider],
  );
  const windowInfo = useMemo(() => deriveWindowInfo(watermark, contextView.data?.stats, model), [watermark, contextView.data?.stats, model]);
  const windowPercent = windowInfo?.utilization !== undefined ? Math.round(windowInfo.utilization * 100) : undefined;

  return (
    <div className="panel-status" aria-label={t("会话状态", "Session status")}>
      <span className={`status-live status-${liveStatus}`}>
        <i aria-hidden /> {liveStatus === "idle" ? t("空闲", "Idle") : t(...stateLabel(liveStatus))}
      </span>
      {!mobile && costSummary && (
        <span className="status-optional" title={t("本会话 tokens 与成本", "Tokens and cost for this session")}>
          {formatTokensShort(costSummary.tokens)} tok · {costSummary.costLabel}
        </span>
      )}
      {!mobile && windowPercent !== undefined && (
        <span className="status-optional" title={t("上下文窗口占用", "Context window usage")}>{t("窗口", "ctx")} {windowPercent}%</span>
      )}
    </div>
  );
}

export interface BottomPanelProps {
  sessionId?: string | undefined;
  agentState?: string | undefined;
  mobile: boolean;
}

/**
 * 底部面板：context/timeline/subagents/sandbox/cost/perf/eval 页签（eval 仅 owc-eval 扩展启用时显示）
 * + 开合/高度拖拽（layout store，localStorage 旧键名持久化）+ 会话状态项。
 * 各面板自取数（qk/store），行为对等旧 components/BottomPanel。
 */
export function BottomPanel({ sessionId, agentState, mobile = false }: BottomPanelProps): ReactElement {
  const { t } = useI18n();
  const bottomOpen = useStore(layoutStore, (state) => state.bottomOpen);
  const tab = useStore(layoutStore, (state) => state.bottomTab);
  const height = useStore(layoutStore, (state) => state.bottomHeight);
  // 移动端第二行标签折叠：默认收起、不持久化；面板展开时自动展开，「收起」按钮始终可收回
  const [tabsExpanded, setTabsExpanded] = useState(false);
  const extensions = useExtensionsQuery();
  const evalEnabled = extensions.data?.some((extension) => extension.id === "owc-eval" && extension.enabled) === true;

  const allTabs = (Object.keys(TAB_META) as BottomTab[]).filter((item) => item !== "eval" || evalEnabled);
  const primaryTabs = mobile ? allTabs.filter((item) => PRIMARY_TABS.includes(item)) : allTabs;
  const secondaryTabs = mobile ? allTabs.filter((item) => !PRIMARY_TABS.includes(item)) : [];
  // 第二行显隐只看 tabsExpanded：当前标签在折叠区也不强制展开，保证「收起」永远可用
  const showSecondary = secondaryTabs.length > 0 && tabsExpanded;

  // 面板展开时自动展开第二行标签（移动端），收起面板时恢复紧凑标签条
  useEffect(() => { setTabsExpanded(bottomOpen); }, [bottomOpen]);
  useEffect(() => {
    if (!evalEnabled && tab === "eval") layout.setBottomTab("context");
  }, [evalEnabled, tab]);

  // 顶部拖拽调高：向上拖增大高度；键盘 ArrowUp/Down 每次 40px
  const startDrag = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (move: MouseEvent): void => layout.setBottomHeight(startHeight + (startY - move.clientY));
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const selectTab = (item: BottomTab): void => {
    if (item === tab) layout.setBottomOpen(!bottomOpen);
    else {
      layout.setBottomTab(item);
      layout.setBottomOpen(true);
    }
  };

  const running = agentState !== undefined && !INACTIVE_STATES.has(agentState);

  return (
    <section className={`bottom-panel${bottomOpen ? " open" : ""}`} aria-label={t("面板", "Panel")}>
      {bottomOpen && (
        <button
          className="panel-resize"
          aria-label={t("调整面板高度（方向键上下）", "Resize panel (use arrow keys)")}
          onMouseDown={startDrag}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") layout.setBottomHeight(height + 40);
            if (event.key === "ArrowDown") layout.setBottomHeight(height - 40);
          }}
        />
      )}
      <div className="panel-tabs">
        {primaryTabs.map((item) => (
          <button
            key={item}
            className={tab === item && bottomOpen ? "active" : ""}
            aria-pressed={tab === item && bottomOpen}
            onClick={() => selectTab(item)}
          >
            <Icon name={TAB_META[item].icon} size={13} />
            {t(TAB_META[item].zh, TAB_META[item].en)}
          </button>
        ))}
        {secondaryTabs.length > 0 && (
          <button
            className={`panel-tabs-more${showSecondary ? " open" : ""}`}
            aria-expanded={showSecondary}
            aria-label={showSecondary ? t("收起更多面板标签", "Collapse more panel tabs") : t("更多面板标签", "More panel tabs")}
            title={showSecondary ? t("收起更多面板标签", "Collapse more panel tabs") : t("更多面板标签（子代理 / 沙盒 / 性能）", "More panel tabs (Subagents / Sandbox / Perf)")}
            onClick={() => setTabsExpanded((value) => !value)}
          >
            <Icon name={showSecondary ? "chevron-up" : "chevron-down"} size={13} />
          </button>
        )}
        {sessionId && <PanelStatus sessionId={sessionId} agentState={agentState} mobile={mobile} />}
        <button
          className="panel-fold"
          aria-label={bottomOpen ? t("收起面板", "Collapse panel") : t("展开面板", "Expand panel")}
          onClick={() => layout.setBottomOpen(!bottomOpen)}
        >
          <Icon name={bottomOpen ? "chevron-down" : "chevron-up"} size={14} />
        </button>
      </div>
      {/* 移动端第二行标签（默认收起）：子代理/沙盒/性能/评测 */}
      {showSecondary && (
        <div className="panel-tabs panel-tabs-secondary">
          {secondaryTabs.map((item) => (
            <button
              key={item}
              className={tab === item && bottomOpen ? "active" : ""}
              aria-pressed={tab === item && bottomOpen}
              onClick={() => selectTab(item)}
            >
              <Icon name={TAB_META[item].icon} size={13} />
              {t(TAB_META[item].zh, TAB_META[item].en)}
            </button>
          ))}
        </div>
      )}
      {bottomOpen && (
        <div className="panel-content" style={{ height }}>
          <Suspense fallback={<div className="panel-loading">{t("加载中…", "Loading…")}</div>}>
          {tab === "context" && <ContextPanel sessionId={sessionId} running={running} />}
          {tab === "timeline" && <TimelinePanel sessionId={sessionId} running={running} />}
          {tab === "subagents" && <SubagentsPanel sessionId={sessionId} />}
          {tab === "sandbox" && <SandboxPanel sessionId={sessionId} />}
          {tab === "cost" && <CostPanel />}
          {tab === "perf" && <PerfPanel sessionId={sessionId} />}
          {tab === "eval" && evalEnabled && <EvalPanel />}
          </Suspense>
        </div>
      )}
    </section>
  );
}
