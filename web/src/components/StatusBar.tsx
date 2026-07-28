import type { ReactElement } from "react";
import type { AgentRunState, SessionDetail, WorkspaceIndexState } from "../lib/contracts";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

export const STATE_LABELS: Record<string, [string, string]> = {
  accepted: ["已接受", "Accepted"], starting: ["启动中", "Starting"], snapshotting: ["创建快照", "Snapshotting"],
  preparing_context: ["准备上下文", "Preparing context"], streaming: ["正在输出", "Responding"],
  executing_tools: ["执行工具", "Running tools"], waiting_permission: ["等待确认", "Waiting for approval"],
  advancing_turn: ["推进回合", "Advancing turn"], settling: ["正在收尾", "Settling"], budget_paused: ["预算暂停", "Budget paused"],
};

/** 运行态标签：未知枚举不原样透出，降级为通用「运行中」 */
export function stateLabel(state: string): [string, string] {
  return STATE_LABELS[state] ?? ["运行中", "Running"];
}

/** 终态/空闲不视为活跃运行（状态栏与实时活动指示共用同一判定） */
export const INACTIVE_STATES: ReadonlySet<string> = new Set(["idle", "completed", "failed", "aborted"]);

/** 符号索引状态（0.4.0 Phase 2 §4.1）：如实展示 新鲜/滞后/构建中/未建。 */
const INDEX_LABELS: Record<WorkspaceIndexState, [string, string]> = {
  fresh: ["索引:新鲜", "Index:fresh"],
  stale: ["索引:滞后", "Index:stale"],
  building: ["索引:构建中", "Index:building"],
  missing: ["索引:未建", "Index:none"],
};

export function StatusBar({ session, state, tokens, costLabel, indexStatus, windowPercent }: { session: SessionDetail; state?: AgentRunState | string; tokens?: number; costLabel?: string; indexStatus?: WorkspaceIndexState; windowPercent?: number }): ReactElement {
  const { t } = useI18n();
  const status = state && !["completed", "failed", "aborted"].includes(state) ? state : "idle";
  return (
    <footer className="session-status-bar" aria-label={t("会话状态", "Session status")}>
      <span title={session.cwd}><Icon name="folder" size={12} /> <b>{session.cwd}</b></span>
      <span><Icon name="history" size={12} /> {session.agentMode ?? "build"}</span>
      <span><Icon name="shield" size={12} /> {session.sandboxMode ?? "appcontainer"}</span>
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
