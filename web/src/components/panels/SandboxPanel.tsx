import type { ReactElement } from "react";
import type { SandboxMode, SessionDetail } from "../../lib/contracts";
import { useI18n } from "../../i18n";

const SANDBOX_MODE_LABELS: Record<SandboxMode, [string, string]> = {
  appcontainer: ["应用容器（AppContainer）", "AppContainer"],
  wsb: ["Windows Sandbox", "Windows Sandbox"],
  jobobject: ["兼容模式（Job Object）", "Compatibility (Job Object)"],
  off: ["关闭", "Off"],
};

export function SandboxPanel({ session }: { session?: SessionDetail }): ReactElement {
  const { t } = useI18n();
  if (!session) return <div className="inspector-body"><p className="panel-empty">{t("选择会话以查看沙盒策略。", "Select a session to view its sandbox policy.")}</p></div>;
  if (!session.sandbox) return <div className="inspector-body"><p className="panel-empty">{t("未配置沙盒策略。", "No sandbox policy is configured.")}</p></div>;
  const { sandbox } = session;
  const enabled = (session.sandboxMode ?? "jobobject") !== "off" && sandbox.enabled;
  return (
    <div className="inspector-body">
      <h2>{t("沙盒策略", "Sandbox policy")}</h2>
      <dl>
        <dt>{t("模式", "Mode")}</dt>
        <dd>{t(...SANDBOX_MODE_LABELS[session.sandboxMode ?? "jobobject"])}</dd>
        <dt>{t("状态", "Status")}</dt>
        <dd>{enabled ? t("已启用", "Enabled") : t("已关闭", "Off")}</dd>
        <dt>{t("网络", "Network")}</dt>
        <dd>{sandbox.network === "allow" ? t("允许", "Allowed") : t("拒绝", "Denied")}</dd>
        <dt>{t("读取根", "Read roots")}</dt>
        <dd>{sandbox.readRoots.join("\n") || "—"}</dd>
        <dt>{t("写入根", "Write roots")}</dt>
        <dd>{sandbox.writeRoots.join("\n") || "—"}</dd>
        <dt>{t("拒绝路径", "Denied paths")}</dt>
        <dd>{sandbox.denyPaths.join("\n") || "—"}</dd>
      </dl>
    </div>
  );
}
