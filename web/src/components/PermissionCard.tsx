import { useState, type ReactElement } from "react";
import { api } from "../lib/api";
import { CodeBlock } from "./Markdown";
import { summarizeToolInput } from "./MessageCard";

export interface PermissionRequest {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

export function PermissionCard({ permission, sessionId, onDone }: {
  permission: PermissionRequest;
  sessionId: string;
  onDone(requestId: string): void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const decide = (decision: "allow" | "allow_always" | "deny"): void => {
    setPending(true);
    api.respondPermission(sessionId, { requestId: permission.requestId, decision, ...(reason ? { reason } : {}) })
      .then(() => onDone(permission.requestId))
      .catch(() => setPending(false));
  };
  const summary = summarizeToolInput(permission.input);
  return (
    <article className="permission-card">
      <span className="track-node" aria-hidden />
      <div className="message-meta">需要你的确认</div>
      <h2>允许执行 <b className="mono">{permission.tool}</b> 吗？</h2>
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
        <button className="btn primary" disabled={pending} onClick={() => decide("allow")}>允许一次</button>
        <button className="btn" disabled={pending} onClick={() => decide("allow_always")}>总是允许</button>
        <button className="btn danger" disabled={pending} onClick={() => decide("deny")}>拒绝</button>
      </div>
    </article>
  );
}
