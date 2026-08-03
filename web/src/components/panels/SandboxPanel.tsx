import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { SandboxMode, SessionDetail } from "../../lib/contracts";
import { useI18n } from "../../i18n";

const SANDBOX_MODE_LABELS: Record<SandboxMode, [string, string]> = {
  appcontainer: ["应用容器（AppContainer）", "AppContainer"],
  wsb: ["Windows Sandbox", "Windows Sandbox"],
  jobobject: ["兼容模式（Job Object）", "Compatibility (Job Object)"],
  off: ["关闭", "Off"],
};

/** 非 Windows 平台默认档由 Landlock 强制，jobobject 枚举值不变、仅换文案。 */
const SANDBOX_MODE_LABELS_LINUX: Partial<Record<SandboxMode, [string, string]>> = {
  jobobject: ["强制模式（Landlock）", "Enforced (Landlock)"],
};

export function SandboxPanel({ session }: { session?: SessionDetail }): ReactElement {
  const { t } = useI18n();
  const sandboxCaps = useQuery({
    queryKey: ["sandbox-capabilities"],
    queryFn: api.sandboxCapabilities,
    staleTime: 60_000,
  });
  if (!session) return <div className="inspector-body"><p className="panel-empty">{t("选择会话以查看沙盒策略。", "Select a session to view its sandbox policy.")}</p></div>;
  if (!session.sandbox) return <div className="inspector-body"><p className="panel-empty">{t("未配置沙盒策略。", "No sandbox policy is configured.")}</p></div>;
  const { sandbox } = session;
  const enabled = (session.sandboxMode ?? "jobobject") !== "off" && sandbox.enabled;
  const isWindows = sandboxCaps.data?.platform === undefined || sandboxCaps.data.platform === "win32";
  const mode = session.sandboxMode ?? "jobobject";
  const modeLabel = (!isWindows && SANDBOX_MODE_LABELS_LINUX[mode]) || SANDBOX_MODE_LABELS[mode];
  return (
    <div className="inspector-body">
      <h2>{t("沙盒策略", "Sandbox policy")}</h2>
      <dl>
        <dt>{t("模式", "Mode")}</dt>
        <dd>{t(...modeLabel)}</dd>
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
        {sandbox.bindLinks && sandbox.bindLinks.length > 0 && (
          <>
            <dt>{t("目录绑定", "Bind links")}</dt>
            <dd>{sandbox.bindLinks.map((link) => `${link.virtPath} ← ${link.backingPath}${link.readOnly ? t("（只读）", " (read-only)") : ""}`).join("\n")}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
