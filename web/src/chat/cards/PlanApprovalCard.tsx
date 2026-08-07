import { useState, type ReactElement } from "react";
import type { PlanApprovalAnswer } from "../../lib/contracts";
import { Markdown } from "../../components/Markdown";
import { useI18n } from "../../i18n";
import type { PlanApprovalCardProps } from "../types";

/** plan 模式批准卡：计划全文 Markdown 渲染 + 批准执行 / 编辑后批准 / 拒绝（附意见）。 */
export function PlanApprovalCard({ item, onRespond }: PlanApprovalCardProps): ReactElement {
  const { t } = useI18n();
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [draft, setDraft] = useState(item.prompt);
  const [feedback, setFeedback] = useState("");
  const respond = (answer: PlanApprovalAnswer): void => onRespond(answer);
  return (
    <section className="interaction-card plan-approval-card" aria-label={item.title}>
      <strong>{item.title}</strong>
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
      <div className="interaction-actions">
        {mode === "view" && <>
          <button className="btn small" onClick={() => respond({ decision: "approve" })}>{t("批准执行", "Approve and run")}</button>
          <button className="btn small" onClick={() => setMode("edit")}>{t("编辑后批准", "Edit and approve")}</button>
          <button className="btn small" onClick={() => setMode("reject")}>{t("拒绝", "Reject")}</button>
        </>}
        {mode === "edit" && <>
          <button className="btn small" onClick={() => respond({ decision: "edit", plan: draft })} disabled={!draft.trim()}>{t("提交修改并批准", "Submit edits and approve")}</button>
          <button className="btn small" onClick={() => { setDraft(item.prompt); setMode("view"); }}>{t("取消", "Cancel")}</button>
        </>}
        {mode === "reject" && <>
          <button className="btn small" onClick={() => respond({ decision: "reject", feedback: feedback.trim() })}>{t("确认拒绝", "Confirm rejection")}</button>
          <button className="btn small" onClick={() => { setFeedback(""); setMode("view"); }}>{t("取消", "Cancel")}</button>
        </>}
      </div>
    </section>
  );
}
