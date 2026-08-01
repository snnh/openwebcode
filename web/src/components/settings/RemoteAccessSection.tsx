import { useMemo, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import { api, ApiError } from "../../lib/api";
import { writeClipboard } from "../../lib/clipboard";
import { useI18n } from "../../i18n";
import { ServerSettingsFields } from "./ServerSettingsFields";
import { TotpSection } from "./TotpSection";
import { NETWORK_SETTINGS_GROUP } from "./shared";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REMOTE_ACCESS_QUERY_KEY = ["remote-access"] as const;

/**
 * 远程访问分区：监听地址/端口编辑（network 分组）、访问令牌状态与一键访问链接
 * （复制/扫码/再生成），非回环监听时持续展示风险提示。
 * 令牌由服务端自动生成并持久化（OWC_ACCESS_TOKEN 可显式覆盖）；origins 缺省
 * 同源自动放行，显式 OWC_ALLOWED_ORIGINS 时维持严格列表。
 */
export function RemoteAccessSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const remoteAccess = useQuery({ queryKey: REMOTE_ACCESS_QUERY_KEY, queryFn: api.remoteAccess, retry: false });
  const [copiedUrl, setCopiedUrl] = useState<string>();
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string>();

  const regenerate = useMutation({
    mutationFn: api.regenerateToken,
    onSuccess: () => {
      setConfirmingRegenerate(false);
      setRegenerateError(undefined);
      void queryClient.invalidateQueries({ queryKey: REMOTE_ACCESS_QUERY_KEY });
    },
    onError: (cause: unknown) => {
      setRegenerateError(cause instanceof ApiError
        ? cause.message
        : t("重新生成失败，请稍后重试。", "Could not regenerate the token. Please try again later."));
    },
  });

  // QR 用 qrcode-generator 前端渲染（SVG 字符串，内容是首条访问链接）
  const qrSvg = useMemo(() => {
    const url = remoteAccess.data?.urls[0];
    if (!url) return undefined;
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag(4, 8);
  }, [remoteAccess.data]);

  if (settings.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (settings.isError || !settings.data) return <p className="panel-empty">{t("无法加载服务设置。", "Could not load server settings.")}</p>;
  const network = settings.data.groups.find((group) => group.id === NETWORK_SETTINGS_GROUP);
  const hostField = network?.fields.find((field) => field.key === "host");
  const portField = network?.fields.find((field) => field.key === "port");
  const host = String(hostField?.value ?? hostField?.masked ?? "127.0.0.1");
  const loopback = LOOPBACK_HOSTS.has(host);
  const info = remoteAccess.data;
  const urls = info?.urls ?? [];

  return (
    <>
      <dl className="server-info">
        <dt>{t("监听地址", "Listen address")}</dt>
        <dd className="mono">{host}{portField?.value != null ? `:${String(portField.value)}` : ""}</dd>
        <dt>{t("访问范围", "Exposure")}</dt>
        <dd>{loopback ? t("仅本机回环（默认，安全）", "Loopback only (default, safe)") : t("非回环监听：局域网/外部可达", "Non-loopback: reachable from the LAN/network")}</dd>
        <dt>{t("访问令牌", "Access token")}</dt>
        <dd>
          {info?.authEnabled && info.maskedToken
            ? <>
                <code className="mono">{info.maskedToken}</code>
                {" "}{info.tokenSource === "generated"
                  ? t("（自动生成并持久化；OWC_ACCESS_TOKEN 可覆盖）", "(auto-generated and persisted; OWC_ACCESS_TOKEN overrides)")
                  : t("（由 OWC_ACCESS_TOKEN 环境变量配置）", "(configured via the OWC_ACCESS_TOKEN environment variable)")}
              </>
            : t("未启用（回环监听无需认证）", "Disabled (loopback listeners need no authentication)")}
        </dd>
      </dl>

      {urls.length > 0 && (
        <>
          <h3>{t("访问链接", "Access links")}</h3>
          <p className="settings-note">{t(
            "在局域网设备的浏览器打开任一链接即可登录（链接携带访问令牌，打开后写入 HttpOnly Cookie）。请像保管密码一样保管这些链接。",
            "Open any of these links in a browser on a LAN device to sign in (the link carries the access token and stores an HttpOnly cookie). Treat the links like passwords.",
          )}</p>
          <div className="access-links">
            {urls.map((url) => (
              <div className="access-link-row" key={url}>
                <code className="mono">{url}</code>
                <button className="btn" onClick={() => { void writeClipboard(url).then((ok) => setCopiedUrl(ok ? url : undefined)); }}>
                  {copiedUrl === url ? t("已复制", "Copied") : t("复制", "Copy")}
                </button>
              </div>
            ))}
            {qrSvg && <div className="totp-qr" aria-label={t("访问链接二维码", "Access link QR code")} dangerouslySetInnerHTML={{ __html: qrSvg }} />}
          </div>
          {info?.tokenSource === "generated" && (
            confirmingRegenerate ? (
              <div className="totp-code-row">
                <span className="settings-note">{t("重新生成后旧链接与已登录设备立即失效，确定继续？", "Regenerating invalidates the old links and signed-in devices immediately. Continue?")}</span>
                <button className="btn primary" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
                  {regenerate.isPending ? t("生成中…", "Generating…") : t("确认重新生成", "Confirm regenerate")}
                </button>
                <button className="btn" onClick={() => { setConfirmingRegenerate(false); setRegenerateError(undefined); }}>{t("取消", "Cancel")}</button>
              </div>
            ) : (
              <p><button className="btn" onClick={() => { setConfirmingRegenerate(true); setRegenerateError(undefined); }}>{t("重新生成访问令牌…", "Regenerate access token…")}</button></p>
            )
          )}
          {regenerateError && <p className="settings-error" role="alert">{regenerateError}</p>}
        </>
      )}

      {!loopback && (
        <p className="settings-error" role="alert">{t(
          "风险：当前服务对网络可达。任何人持有访问令牌即可操作你的会话与工具；请只在受信网络中暴露。",
          "Risk: the server is reachable from the network. Anyone with the access token can drive your sessions and tools; only expose it on trusted networks.",
        )}</p>
      )}
      <ServerSettingsFields showGroup={(groupId) => groupId === NETWORK_SETTINGS_GROUP} onDirtyChange={onDirtyChange} />
      <p className="settings-note">{t(
        "移动端/局域网访问：将上方监听地址改为 0.0.0.0 并重启服务即可——访问令牌自动生成，访问链接见上方（也可在服务端控制台查看）。如需固定令牌或限定浏览器来源，可用 OWC_ACCESS_TOKEN / OWC_ALLOWED_ORIGINS 环境变量显式覆盖。",
        "Mobile/LAN access: set the listen address above to 0.0.0.0 and restart — the access token is auto-generated and the access links appear above (also printed to the server console). To pin a token or restrict browser origins, override with the OWC_ACCESS_TOKEN / OWC_ALLOWED_ORIGINS environment variables.",
      )}</p>
      <TotpSection />
    </>
  );
}
