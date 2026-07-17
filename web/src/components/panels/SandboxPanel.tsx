import type { ReactElement } from "react";
import type { SessionDetail } from "../../lib/contracts";

export function SandboxPanel({ session }: { session?: SessionDetail }): ReactElement {
  if (!session) return <div className="inspector-body"><p className="panel-empty">选择会话以查看沙盒策略。</p></div>;
  if (!session.sandbox) return <div className="inspector-body"><p className="panel-empty">未配置沙盒策略。</p></div>;
  const { sandbox } = session;
  return (
    <div className="inspector-body">
      <h2>沙盒策略</h2>
      <dl>
        <dt>状态</dt>
        <dd>{sandbox.enabled ? "已启用" : "已关闭"}</dd>
        <dt>网络</dt>
        <dd>{sandbox.network === "allow" ? "允许" : "拒绝"}</dd>
        <dt>读取根</dt>
        <dd>{sandbox.readRoots.join("\n") || "—"}</dd>
        <dt>写入根</dt>
        <dd>{sandbox.writeRoots.join("\n") || "—"}</dd>
        <dt>拒绝路径</dt>
        <dd>{sandbox.denyPaths.join("\n") || "—"}</dd>
      </dl>
    </div>
  );
}
