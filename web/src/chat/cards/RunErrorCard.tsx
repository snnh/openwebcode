import type { ReactElement } from "react";
import { agentErrorGuidance } from "../../lib/agent-error";
import { ui } from "../../app/ui-store";
import { useI18n } from "../../i18n";
import type { RunErrorCardProps } from "../types";

/**
 * 本轮执行失败的持久可见错误卡：分类提示（agentErrorGuidance）+ 原始错误（超长折叠）
 * + 「打开模型设置」深链 / 「重试」动作。
 */
export function RunErrorCard({ error, onRetryRun, retryPending }: RunErrorCardProps): ReactElement {
  const { t } = useI18n();
  const guidance = agentErrorGuidance(error, t);
  // 原始错误保留可见但弱化：超长 JSON blob 默认折叠
  const longMessage = error.message.length > 280;
  return (
    <section className="tool-result error run-error" role="alert">
      <span className="tool-result-label">{t("本轮执行失败", "Run failed")}</span>
      {guidance.hint && <p className="run-error-hint">{guidance.hint}</p>}
      {longMessage ? (
        <details className="run-error-details">
          <summary>{t("原始错误信息", "Raw error message")}</summary>
          <pre className="mono">{error.message}</pre>
        </details>
      ) : (
        <pre className="mono run-error-message">{error.message}</pre>
      )}
      {(guidance.settingsTab || (guidance.retryable && onRetryRun)) && (
        <div className="run-error-actions">
          {guidance.settingsTab && (
            <button type="button" className="btn small" onClick={() => ui.openSettings(guidance.settingsTab!)}>
              {t("打开模型设置", "Open model settings")}
            </button>
          )}
          {guidance.retryable && onRetryRun && (
            <button
              type="button"
              className="btn small"
              disabled={retryPending}
              title={t("重发最近一条用户消息；附件不随重试重发", "Resends the latest user message; attachments are not re-sent")}
              onClick={onRetryRun}
            >{t("重试", "Retry")}</button>
          )}
        </div>
      )}
    </section>
  );
}
