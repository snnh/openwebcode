import type { ReactElement } from "react";
import type { SessionDetail } from "../lib/contracts";
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

export function JobHeader({ session, agentState, costSummary, onAbort }: {
  session: SessionDetail;
  agentState?: string;
  costSummary?: CostSummary;
  onAbort(): void;
}): ReactElement {
  const busy = isBusyState(agentState);
  const budgetRatio = costSummary?.tokenBudget ? Math.min(1, costSummary.tokens / costSummary.tokenBudget) : undefined;
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
        {agentState && agentState !== "idle" && (
          <span className={`state-badge state-${agentState}`}>{STATE_LABELS[agentState] ?? agentState}</span>
        )}
        <span className={`sandbox-badge ${session.sandbox?.enabled ? "enforced" : "advisory"}`}>
          <Icon name="shield" size={11} />
          {session.sandbox?.enabled ? "沙盒已启用" : "沙盒关闭"}
        </span>
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
    </header>
  );
}
