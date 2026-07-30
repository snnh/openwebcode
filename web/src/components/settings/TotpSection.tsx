import { useMemo, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import { api, ApiError } from "../../lib/api";
import type { TotpSetupResponse } from "../../lib/contracts";
import { writeClipboard } from "../../lib/clipboard";
import { useI18n } from "../../i18n";
import { AUTH_STATUS_QUERY_KEY } from "../AuthGate";

type WizardStage = "idle" | "scan" | "recovery" | "disable";

/**
 * TOTP 两步验证管理（提交⑥，远程访问分区）：启用向导（扫码 → 验码 → 一次性展示恢复码）、
 * 已启用状态的禁用入口（需输码），以及终端门槛状态块（提交⑦预埋，仅展示）。
 */
export function TotpSection(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: AUTH_STATUS_QUERY_KEY, queryFn: api.authStatus, retry: false });
  const [stage, setStage] = useState<WizardStage>("idle");
  const [setup, setSetup] = useState<TotpSetupResponse>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: AUTH_STATUS_QUERY_KEY }); };
  const mutationError = (fallback: string) => (cause: unknown) => {
    setError(cause instanceof ApiError && (cause.status === 400 || cause.status === 401)
      ? t("动态码不正确，请重试。", "Invalid code. Please try again.")
      : fallback);
  };
  const beginSetup = useMutation({
    mutationFn: api.totpSetup,
    onSuccess: (data) => { setSetup(data); setStage("scan"); setCode(""); setError(undefined); },
    onError: mutationError(t("无法开始设置，请稍后重试。", "Could not start setup. Please try again later.")),
  });
  const confirm = useMutation({
    mutationFn: (value: string) => api.totpConfirm(value),
    onSuccess: (data) => { setRecoveryCodes(data.recoveryCodes); setStage("recovery"); setCode(""); setError(undefined); refresh(); },
    onError: mutationError(t("确认失败，请重新扫码后重试。", "Confirmation failed. Please rescan and try again.")),
  });
  const disable = useMutation({
    mutationFn: (value: string) => api.totpDisable(value),
    onSuccess: () => { setStage("idle"); setCode(""); setError(undefined); refresh(); },
    onError: mutationError(t("禁用失败，请稍后重试。", "Could not disable TOTP. Please try again later.")),
  });

  // QR 用 qrcode-generator 前端渲染（SVG 字符串，内容是本地 otpauth URI）
  const qrSvg = useMemo(() => {
    if (stage !== "scan" || !setup) return undefined;
    const qr = qrcode(0, "M");
    qr.addData(setup.otpauthUrl);
    qr.make();
    return qr.createSvgTag(4, 8);
  }, [stage, setup]);

  if (status.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (status.isError || !status.data) return <p className="panel-empty">{t("无法加载认证状态。", "Could not load authentication status.")}</p>;
  const enabled = status.data.totpEnabled;
  const hostOk = !status.data.gateReasons.includes("host_not_loopback_or_lan");

  return (
    <>
      <h3>{t("两步验证（TOTP）", "Two-factor authentication (TOTP)")}</h3>
      {!enabled && stage === "idle" && (
        <>
          <p className="settings-note">{t(
            "启用后，打开 Web 界面需要先输入身份验证器（如 Microsoft Authenticator、1Password）中的 6 位动态码；CLI 的 bearer token 通道不受影响。",
            "Once enabled, opening the web UI requires the 6-digit code from an authenticator app (e.g. Microsoft Authenticator, 1Password). The CLI bearer token channel is unaffected.",
          )}</p>
          <p><button className="btn primary" disabled={beginSetup.isPending} onClick={() => beginSetup.mutate()}>
            {beginSetup.isPending ? t("生成中…", "Generating…") : t("启用两步验证", "Enable two-factor authentication")}
          </button></p>
        </>
      )}
      {stage === "scan" && setup && (
        <div className="totp-wizard">
          <p className="settings-note">{t("用身份验证器扫码，或手动输入密钥，然后填入应用中显示的 6 位动态码完成启用。", "Scan with your authenticator app (or enter the secret manually), then enter the 6-digit code shown in the app to finish.")}</p>
          {qrSvg && <div className="totp-qr" aria-label={t("TOTP 二维码", "TOTP QR code")} dangerouslySetInnerHTML={{ __html: qrSvg }} />}
          <p className="settings-note">{t("手动密钥：", "Manual secret: ")}<code className="mono">{setup.secret}</code></p>
          <label className="settings-note" htmlFor="totp-confirm-code">{t("动态码", "Verification code")}</label>
          <div className="totp-code-row">
            <input
              id="totp-confirm-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
            <button className="btn primary" disabled={confirm.isPending || code.trim() === ""} onClick={() => confirm.mutate(code.trim())}>
              {confirm.isPending ? t("校验中…", "Verifying…") : t("确认启用", "Confirm and enable")}
            </button>
            <button className="btn" onClick={() => { setStage("idle"); setCode(""); setError(undefined); }}>{t("取消", "Cancel")}</button>
          </div>
        </div>
      )}
      {stage === "recovery" && (
        <div className="totp-wizard">
          <p className="settings-error" role="alert">{t(
            "两步验证已启用。请立即保存以下恢复码——它们只显示这一次，每个恢复码只能使用一次。",
            "Two-factor authentication is now enabled. Save these recovery codes now — they are shown only once and each can be used only once.",
          )}</p>
          <ol className="totp-recovery-list">
            {recoveryCodes.map((value) => <li key={value} className="mono">{value}</li>)}
          </ol>
          <div className="totp-code-row">
            <button className="btn" onClick={() => { void writeClipboard(recoveryCodes.join("\n")).then((ok) => setCopied(ok)); }}>
              {copied ? t("已复制", "Copied") : t("复制全部恢复码", "Copy all recovery codes")}
            </button>
            <button className="btn primary" onClick={() => { setStage("idle"); setCopied(false); }}>{t("我已保存，完成", "I saved them — done")}</button>
          </div>
        </div>
      )}
      {enabled && stage === "idle" && (
        <>
          <p className="settings-note">{t("两步验证已启用：打开 Web 界面需要输入动态码或恢复码。", "Two-factor authentication is enabled: opening the web UI requires a verification or recovery code.")}</p>
          <p><button className="btn" onClick={() => { setStage("disable"); setCode(""); setError(undefined); }}>{t("禁用两步验证…", "Disable two-factor authentication…")}</button></p>
        </>
      )}
      {stage === "disable" && (
        <div className="totp-wizard">
          <p className="settings-note">{t("输入当前动态码或一个恢复码以禁用两步验证；禁用后凭据将被删除。", "Enter a current verification code or a recovery code to disable two-factor authentication; the credential will be deleted.")}</p>
          <div className="totp-code-row">
            <input
              aria-label={t("动态码或恢复码", "Verification or recovery code")}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="000000"
              autoComplete="off"
            />
            <button className="btn primary" disabled={disable.isPending || code.trim() === ""} onClick={() => disable.mutate(code.trim())}>
              {disable.isPending ? t("校验中…", "Verifying…") : t("确认禁用", "Confirm disable")}
            </button>
            <button className="btn" onClick={() => { setStage("idle"); setCode(""); setError(undefined); }}>{t("取消", "Cancel")}</button>
          </div>
        </div>
      )}
      {error && <p className="settings-error" role="alert">{error}</p>}

      <h3>{t("终端门槛状态", "Terminal gate status")}</h3>
      <ul className="totp-gate-list">
        <li>{enabled ? "✅" : "❌"} {t("TOTP 已开启", "TOTP enabled")}</li>
        <li>{hostOk ? "✅" : "❌"} {t("监听地址为回环或局域网", "Listen address is loopback or LAN")}</li>
      </ul>
      <p className="settings-note">{status.data.terminalAvailable
        ? t("终端功能可用（门槛均已满足）。", "Terminal is available (all gate conditions met).")
        : t("终端功能暂不可用：需同时满足以上两项。", "Terminal is not available yet: both conditions above must be met.")}</p>
    </>
  );
}
