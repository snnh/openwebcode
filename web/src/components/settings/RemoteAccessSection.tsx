import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";
import { ServerSettingsFields } from "./ServerSettingsFields";
import { NETWORK_SETTINGS_GROUP } from "./shared";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 远程访问分区（0.4.0 Phase 5b §6.8）：展示监听地址与 token 认证配置状态，
 * 非回环监听时持续展示风险提示。监听地址/端口（network 分组）也在此编辑；
 * access token / allowed origins 仍仅由服务端环境变量配置。
 */
export function RemoteAccessSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  const { t } = useI18n();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  if (settings.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (settings.isError || !settings.data) return <p className="panel-empty">{t("无法加载服务设置。", "Could not load server settings.")}</p>;
  const network = settings.data.groups.find((group) => group.id === NETWORK_SETTINGS_GROUP);
  const hostField = network?.fields.find((field) => field.key === "host");
  const portField = network?.fields.find((field) => field.key === "port");
  const host = String(hostField?.value ?? hostField?.masked ?? "127.0.0.1");
  const loopback = LOOPBACK_HOSTS.has(host);
  return (
    <>
      <dl className="server-info">
        <dt>{t("监听地址", "Listen address")}</dt>
        <dd className="mono">{host}{portField?.value != null ? `:${String(portField.value)}` : ""}</dd>
        <dt>{t("访问范围", "Exposure")}</dt>
        <dd>{loopback ? t("仅本机回环（默认，安全）", "Loopback only (default, safe)") : t("非回环监听：局域网/外部可达", "Non-loopback: reachable from the LAN/network")}</dd>
        <dt>{t("Token 认证", "Token authentication")}</dt>
        <dd>{t("由服务端 OWC_ACCESS_TOKEN 环境变量配置；非回环监听时必须设置（服务端强制，未设置会拒绝启动）。", "Configured via the server's OWC_ACCESS_TOKEN environment variable; required for non-loopback listeners (enforced by the server at startup).")}</dd>
      </dl>
      {!loopback && (
        <p className="settings-error" role="alert">{t(
          "风险：当前服务对网络可达。请确认已设置 OWC_ACCESS_TOKEN 与 OWC_ALLOWED_ORIGINS，且只在受信网络中暴露；任何人持有 token 即可操作你的会话与工具。",
          "Risk: the server is reachable from the network. Make sure OWC_ACCESS_TOKEN and OWC_ALLOWED_ORIGINS are set and only expose it on trusted networks; anyone with the token can drive your sessions and tools.",
        )}</p>
      )}
      <ServerSettingsFields showGroup={(groupId) => groupId === NETWORK_SETTINGS_GROUP} onDirtyChange={onDirtyChange} />
      <p className="settings-note">{t(
        "移动端/局域网访问：将上方监听地址改为 0.0.0.0（需重启），并在服务端环境变量中配置 OWC_ACCESS_TOKEN（≥32 字符）与 OWC_ALLOWED_ORIGINS。浏览器首次用 ?token= 打开后会写入 HttpOnly Cookie。修改监听地址后重启服务生效。",
        "Mobile/LAN access: set the listen address above to 0.0.0.0 (restart required), and configure OWC_ACCESS_TOKEN (at least 32 characters) plus OWC_ALLOWED_ORIGINS as server environment variables. Opening the page once with ?token= stores an HttpOnly cookie. Restart the server after changing the listen address.",
      )}</p>
    </>
  );
}
