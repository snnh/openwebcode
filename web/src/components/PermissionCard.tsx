import { useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import { CodeBlock } from "./Markdown";
import { summarizeToolInput } from "./MessageCard";

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
        onError?.("权限响应失败，请重试");
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
    <article className="permission-card" role="alertdialog" aria-labelledby={titleId}>
      <span className="track-node" aria-hidden />
      <div className="message-meta">需要你的确认</div>
      <h2 id={titleId}>允许执行 <b className="mono">{permission.tool}</b> 吗？</h2>
      {summary && <p className="tool-summary mono" title={summary}>{summary}</p>}
      <details className="tool-detail">
        <summary>完整参数</summary>
        <CodeBlock lang="json" code={JSON.stringify(permission.input, null, 2)} />
      </details>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="拒绝理由（可选）"
        aria-label="拒绝理由（可选）"
      />
      <div className="permission-actions">
        <button ref={allowOnceRef} className="btn primary" disabled={pending} onClick={() => { cancelConfirm(); decide("allow"); }}>允许一次</button>
        <button className={`btn${confirmAlways ? " danger" : ""}`} disabled={pending} onClick={clickAllowAlways}>
          {confirmAlways ? "确认总是允许？" : "总是允许"}
        </button>
        <button className="btn danger" disabled={pending} onClick={() => { cancelConfirm(); decide("deny"); }}>拒绝</button>
      </div>
    </article>
  );
}
