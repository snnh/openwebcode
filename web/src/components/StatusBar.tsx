import type { ReactElement } from "react";
import type { AgentRunState, SessionDetail, WorkspaceIndexState } from "../lib/contracts";
import { INACTIVE_STATES, stateLabel } from "../lib/agent-state";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

/** 符号索引状态（0.4.0 Phase 2 §4.1）：如实展示 新鲜/滞后/构建中/未建。 */
const INDEX_LABELS: Record<WorkspaceIndexState, [string, string]> = {
  fresh: ["索引:新鲜", "Index:fresh"],
  stale: ["索引:滞后", "Index:stale"],
  building: ["索引:构建中", "Index:building"],
  missing: ["索引:未建", "Index:none"],
};

export function StatusBar({ session, state, tokens, costLabel, indexStatus, windowPercent }: { session: SessionDetail; state?: AgentRunState | string; tokens?: number; costLabel?: string; indexStatus?: WorkspaceIndexState; windowPercent?: number }): ReactElement {
  const { t } = useI18n();
  const status = state && !INACTIVE_STATES.has(state) ? state : "idle";
  return (
    <footer className="session-status-bar" aria-label={t("会话状态", "Session status")}>
      <span title={session.cwd}><Icon name="folder" size={12} /> <b>{session.cwd}</b></span>
      <span><Icon name="history" size={12} /> {session.agentMode ?? "code"}</span>
      <span><Icon name="shield" size={12} /> {session.sandboxMode ?? "jobobject"}</span>
      <span><Icon name="settings" size={12} /> {session.provider}/{session.model}</span>
      {session.thinking && <span className="status-optional">thinking: {session.thinking}</span>}
      {tokens !== undefined && <span className="status-optional">{tokens.toLocaleString()} tokens</span>}
      {windowPercent !== undefined && <span className="status-optional" title={t("上下文窗口占用", "Context window usage")}>{t("窗口", "ctx")} {windowPercent}%</span>}
      {costLabel && <span className="status-optional">{costLabel}</span>}
      {indexStatus && <span className="status-optional" data-testid="index-status">{t(...INDEX_LABELS[indexStatus])}</span>}
      <span className={`status-live status-${status}`}><i aria-hidden /> {status === "idle" ? t("空闲", "Idle") : t(...stateLabel(status))}</span>
    </footer>
  );
}
