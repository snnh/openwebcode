/**
 * 底部状态条：agent 状态点+文案、agent 模式、模型名、成本、上下文 %。
 * 桌面完整 / 移动端精简（语义沿用旧 BottomPanel 状态行）。
 * 成本与上下文水位由会话 context 查询 + session-store 水位内部推导（缓存与 ChatView 共享）。
 */
import { useMemo, type ReactElement } from "react";
import type { Session } from "../lib/contracts";
import { deriveWindowInfo } from "../lib/context-window";
import { INACTIVE_STATES, stateLabel } from "../lib/agent-state";
import { formatCurrency, formatTokensShort } from "../lib/format";
import { useStore } from "../app/store";
import { sessionStore } from "../app/session-store";
import { useContextViewQuery, useModelsQuery } from "../app/queries";
import { useI18n } from "../i18n";

export interface StatusBarProps {
  sessionId?: string | undefined;
  session?: Session | undefined;
  agentState?: string | undefined;
  /** 移动端精简：只显示状态点+文案与模型名 */
  mobile?: boolean;
}

export function StatusBar({ sessionId, session, agentState, mobile = false }: StatusBarProps): ReactElement {
  const { t } = useI18n();
  const contextView = useContextViewQuery(sessionId);
  const models = useModelsQuery();
  const watermark = useStore(sessionStore, (state) => (sessionId ? state.watermarks[sessionId] : undefined));

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

  const liveState = agentState && !INACTIVE_STATES.has(agentState) ? agentState : "idle";
  return (
    <div className="status-bar" aria-label={t("会话状态", "Session status")}>
      <span className={`status-live status-${liveState}`}>
        <i aria-hidden /> {liveState === "idle" ? t("空闲", "Idle") : t(...stateLabel(liveState))}
      </span>
      {session && (
        <>
          <span className="status-optional">{session.agentMode ?? "code"}</span>
          <span className="panel-status-model" title={`${session.provider}/${session.model}`}>{session.model}</span>
        </>
      )}
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
