import type { ReactElement } from "react";
import type { SandboxMode, SessionDetail } from "../../lib/contracts";

const SANDBOX_MODE_LABELS: Record<SandboxMode, string> = {
  appcontainer: "应用容器（AppContainer）",
  wsb: "Windows Sandbox",
  jobobject: "兼容模式（Job Object）",
  off: "关闭",
};

export function SandboxPanel({ session }: { session?: SessionDetail }): ReactElement {
  if (!session) return <div className="inspector-body"><p className="panel-empty">选择会话以查看沙盒策略。</p></div>;
  if (!session.sandbox) return <div className="inspector-body"><p className="panel-empty">未配置沙盒策略。</p></div>;
  const { sandbox } = session;
  const enabled = (session.sandboxMode ?? "appcontainer") !== "off" && sandbox.enabled;
  return (
    <div className="inspector-body">
      <h2>沙盒策略</h2>
      <dl>
        <dt>模式</dt>
        <dd>{SANDBOX_MODE_LABELS[session.sandboxMode ?? "appcontainer"]}</dd>
        <dt>状态</dt>
        <dd>{enabled ? "已启用" : "已关闭"}</dd>
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
