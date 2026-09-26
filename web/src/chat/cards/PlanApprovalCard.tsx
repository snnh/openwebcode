import { useState, type ReactElement } from "react";
import type { PlanApprovalAnswer } from "../../lib/contracts";
import { Markdown } from "../../components/Markdown";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import type { PlanApprovalCardProps } from "../types";

/** plan 模式批准卡：计划全文 Markdown 渲染 + 批准执行 / 编辑后批准 / 拒绝（附意见）。
 *  收起态只留卡头 + 「批准执行」：计划正文可能很长，与其余待回答卡共用同一限高护栏。 */
export function PlanApprovalCard({ item, onRespond, collapsed = false, onToggleCollapse }: PlanApprovalCardProps): ReactElement {
  const { t } = useI18n();
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [draft, setDraft] = useState(item.prompt);
  const [feedback, setFeedback] = useState("");
  const respond = (answer: PlanApprovalAnswer): void => onRespond(answer);
  return (
    <section
      className={`interaction-card plan-approval-card pending-block${collapsed ? " collapsed" : ""}`}
      aria-label={item.title}
    >
      <div className="pending-head">
        {onToggleCollapse ? (
          <button
            type="button"
            className="pending-toggle"
            aria-expanded={!collapsed}
            aria-label={t(`收起/展开「${item.title}」`, `Collapse or expand "${item.title}"`)}
            onClick={onToggleCollapse}
          >
            <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
            <span className="pending-title">{item.title}</span>
          </button>
        ) : <strong className="pending-title">{item.title}</strong>}
        <span className="pending-flag">{t("待批准", "Needs approval")}</span>
      </div>
      {!collapsed && (
        <div className="pending-body">
          {mode === "edit"
            ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t("编辑计划", "Edit plan")} rows={14} />
            : <Markdown>{item.prompt}</Markdown>}
          {mode === "reject" && (
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              aria-label={t("拒绝意见", "Rejection feedback")}
              placeholder={t("告诉 agent 需要调整什么", "Tell the agent what to change")}
            />
          )}
        </div>
      )}
      <div className="interaction-actions">
        {collapsed && (
          <button className="btn small" onClick={() => respond({ decision: "approve" })}>{t("批准执行", "Approve and run")}</button>
        )}
        {!collapsed && mode === "view" && <>
          <button className="btn small" onClick={() => respond({ decision: "approve" })}>{t("批准执行", "Approve and run")}</button>
          <button className="btn small" onClick={() => setMode("edit")}>{t("编辑后批准", "Edit and approve")}</button>
          <button className="btn small" onClick={() => setMode("reject")}>{t("拒绝", "Reject")}</button>
        </>}
        {!collapsed && mode === "edit" && <>
          <button className="btn small" onClick={() => respond({ decision: "edit", plan: draft })} disabled={!draft.trim()}>{t("提交修改并批准", "Submit edits and approve")}</button>
          <button className="btn small" onClick={() => { setDraft(item.prompt); setMode("view"); }}>{t("取消", "Cancel")}</button>
        </>}
        {!collapsed && mode === "reject" && <>
          <button className="btn small" onClick={() => respond({ decision: "reject", feedback: feedback.trim() })}>{t("确认拒绝", "Confirm rejection")}</button>
          <button className="btn small" onClick={() => { setFeedback(""); setMode("view"); }}>{t("取消", "Cancel")}</button>
        </>}
      </div>
    </section>
  );
}
