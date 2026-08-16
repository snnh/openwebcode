import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SandboxCapability, SandboxMode } from "../lib/contracts";
import { useSessionQuery } from "../app/queries";
import { useI18n } from "../i18n";

const SANDBOX_MODE_LABELS: Record<SandboxMode, [string, string]> = {
  appcontainer: ["应用容器（AppContainer）", "AppContainer"],
  wsb: ["Windows Sandbox", "Windows Sandbox"],
  jobobject: ["兼容模式（Job Object）", "Compatibility (Job Object)"],
  landlock: ["强制模式（Landlock）", "Enforced (Landlock)"],
  bubblewrap: ["隔离模式（bubblewrap）", "Isolated (bubblewrap)"],
  off: ["关闭", "Off"],
};

const CAPABILITY_LABELS: Record<SandboxCapability, [string, string]> = {
  enforced: ["已强制", "Enforced"],
  partial: ["部分生效", "Partial"],
  advisory: ["仅提示", "Advisory"],
};

const CAPABILITY_PILL_CLASS: Record<SandboxCapability, string> = {
  enforced: "ok",
  partial: "amber",
  advisory: "danger",
};

/** 沙盒面板：会话沙盒策略 + 平台能力 + 最近一次 configureSession 上报的执行级别。会话详情自取（qk.session）。 */
export function SandboxPanel({ sessionId }: { sessionId?: string | undefined }): ReactElement {
  const { t } = useI18n();
  const sessionQuery = useSessionQuery(sessionId);
  const session = sessionQuery.data;
  const sandboxCaps = useQuery({
    queryKey: ["sandbox-capabilities"],
    queryFn: api.sandboxCapabilities,
    staleTime: 60_000,
  });
  // 执行级别：最近一次 configureSession 时 core 上报的 capability/reason；无记录显示 —
  const sandboxStatus = useQuery({
    queryKey: ["sandbox-status", sessionId],
    queryFn: () => api.sessionSandboxStatus(sessionId!),
    staleTime: 30_000,
    enabled: Boolean(session?.sandbox),
  });
  if (!sessionId || !session) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("选择会话以查看沙盒策略。", "Select a session to view its sandbox policy.")}</p></div>;
  if (!session.sandbox) return <div className="inspector-body"><p className="muted-empty panel-empty">{t("未配置沙盒策略。", "No sandbox policy is configured.")}</p></div>;
  const { sandbox } = session;
  const enabled = (session.sandboxMode ?? "jobobject") !== "off" && sandbox.enabled;
  const isWindows = sandboxCaps.data?.platform === undefined || sandboxCaps.data.platform === "win32";
  const mode = session.sandboxMode ?? "jobobject";
  // 存量 Linux 会话 meta.sandboxMode 可能是 jobobject，显示时按 landlock 处理（兼容映射）
  const displayMode: SandboxMode = !isWindows && mode === "jobobject" ? "landlock" : mode;
  const capability = sandboxStatus.data?.sandboxCapability;
  return (
    <div className="inspector-body">
      <h2>{t("沙盒策略", "Sandbox policy")}</h2>
      <dl>
        <dt>{t("模式", "Mode")}</dt>
        <dd>{t(...SANDBOX_MODE_LABELS[displayMode])}{session.kind === "local" && <span className="muted-empty"> · {t("本机会话：命令直接在本机执行，HOME 外文件路径需逐个允许", "local session: commands run directly on the host; file paths outside HOME require per-path approval")}</span>}</dd>
        <dt>{t("状态", "Status")}</dt>
        <dd>{enabled ? t("已启用", "Enabled") : t("已关闭", "Off")}</dd>
        <dt>{t("执行级别", "Enforcement")}</dt>
        <dd>
          {capability ? (
            <>
              <span className={`pill ${CAPABILITY_PILL_CLASS[capability]}`}>{t(...CAPABILITY_LABELS[capability])}</span>
              {sandboxStatus.data?.sandboxReason && <> <span className="muted-empty">{sandboxStatus.data.sandboxReason}</span></>}
            </>
          ) : "—"}
        </dd>
        <dt>{t("网络", "Network")}</dt>
        <dd>{sandbox.network === "allow" ? t("允许", "Allowed") : sandbox.network === "filtered" ? t("代理过滤（仅 Windows）", "Filtered via proxy (Windows only)") : t("拒绝", "Denied")}</dd>
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
