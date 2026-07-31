import { useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import { CodeBlock } from "./Markdown";
import { summarizeToolInput } from "../lib/tool-format";
import { useI18n } from "../i18n";

export interface PermissionRequest {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

export function PermissionCard({ permission, sessionId, onDone, onError }: {
  permission: PermissionRequest;
  sessionId: string;
  onDone(requestId: string): void;
  onError?(message: string): void;
}): ReactElement {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  // 「总是允许」需二次确认：第一次点击进入确认态，3 秒内再点才生效
  const [confirmAlways, setConfirmAlways] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);
  const allowOnceRef = useRef<HTMLButtonElement>(null);
  const titleId = `permission-title-${permission.requestId}`;

  // 出现时把焦点移到主操作按钮，便于键盘/读屏用户立即响应
  useEffect(() => {
    allowOnceRef.current?.focus();
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  const cancelConfirm = (): void => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    setConfirmAlways(false);
  };

  const decide = (decision: "allow" | "allow_always" | "deny"): void => {
    setPending(true);
    api.respondPermission(sessionId, { requestId: permission.requestId, decision, ...(reason ? { reason } : {}) })
      .then(() => onDone(permission.requestId))
      .catch(() => {
        setPending(false);
        onError?.(t("权限响应失败，请重试", "Permission response failed. Try again."));
      });
  };

  const clickAllowAlways = (): void => {
    if (!confirmAlways) {
      setConfirmAlways(true);
      confirmTimer.current = window.setTimeout(() => setConfirmAlways(false), 3000);
      return;
    }
    cancelConfirm();
    decide("allow_always");
  };

  const summary = summarizeToolInput(permission.input);
  return (
    <article
      className="permission-card"
      role="alertdialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        // Esc 退出「总是允许」的 3 秒确认态；非确认态下是无害空操作
        if (event.key === "Escape") cancelConfirm();
      }}
    >
      <div className="message-meta">{t("需要你的确认", "Your confirmation is required")}</div>
      <h2 id={titleId}>{t("允许执行", "Allow")} <b className="mono">{permission.tool}</b>{t(" 吗？", "?")}</h2>
      {summary && <p className="tool-summary mono" title={summary}>{summary}</p>}
      <details className="tool-detail">
        <summary>{t("完整参数", "Full parameters")}</summary>
        <CodeBlock lang="json" code={JSON.stringify(permission.input, null, 2)} />
      </details>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t("拒绝理由（可选）", "Reason for denial (optional)")}
        aria-label={t("拒绝理由（可选）", "Reason for denial (optional)")}
      />
      <div className="permission-actions">
        <button ref={allowOnceRef} className="btn primary" disabled={pending} onClick={() => { cancelConfirm(); decide("allow"); }}>{t("允许一次", "Allow once")}</button>
        <button className={`btn${confirmAlways ? " danger" : ""}`} disabled={pending} onClick={clickAllowAlways}
          {...(permission.tool === "bash" ? { title: t("对 bash 命令按词边界前缀生效：允许「npm test」将同时放行「npm test -- --watch」等追加参数的调用", "For bash this applies as a word-boundary prefix: allowing \"npm test\" also allows calls with extra arguments like \"npm test -- --watch\"") } : {})}>
          {confirmAlways ? t("确认总是允许？", "Confirm always allow?") : t("总是允许", "Always allow")}
        </button>
        <button className="btn danger" disabled={pending} onClick={() => { cancelConfirm(); decide("deny"); }}>{t("拒绝", "Deny")}</button>
      </div>
    </article>
  );
}
