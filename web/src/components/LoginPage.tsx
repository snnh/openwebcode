import { useState, type FormEvent, type ReactElement } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useI18n } from "../i18n";

/**
 * TOTP 全局登录页（提交⑥）：全屏门禁，验证通过前不进主界面。
 * 支持 6 位动态码与一次性恢复码两种入口；锁定（每 IP 5 次失败锁 60s）与错误提示如实展示。
 */
export function LoginPage({ onAuthenticated }: { onAuthenticated(): void }): ReactElement {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string>();
  const login = useMutation({
    mutationFn: (value: string) => api.login(value),
    onSuccess: () => onAuthenticated(),
    onError: (cause) => {
      if (cause instanceof ApiError && cause.status === 429) {
        setError(t("尝试次数过多，已临时锁定，请 1 分钟后再试。", "Too many attempts. Locked temporarily — try again in a minute."));
      } else if (cause instanceof ApiError && cause.status === 401) {
        setError(useRecovery
          ? t("恢复码不正确或已被使用。", "Recovery code is invalid or has already been used.")
          : t("动态码不正确，请重试。", "Invalid code. Please try again."));
      } else {
        setError(t("登录失败，请稍后重试。", "Login failed. Please try again later."));
      }
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = code.trim();
    if (value === "" || login.isPending) return;
    setError(undefined);
    login.mutate(value);
  };
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">OpenWebCode</h1>
        <p className="login-subtitle">{t("此实例已启用两步验证，请输入身份验证器中的动态码。", "Two-factor authentication is enabled. Enter the code from your authenticator app.")}</p>
        <label className="login-label" htmlFor="login-code">
          {useRecovery ? t("恢复码", "Recovery code") : t("动态码", "Verification code")}
        </label>
        <input
          id="login-code"
          className="login-input"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={useRecovery ? "xxxxx-xxxxx" : "000000"}
          autoComplete={useRecovery ? "off" : "one-time-code"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoFocus
        />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="btn primary login-submit" type="submit" disabled={login.isPending || code.trim() === ""}>
          {login.isPending ? t("验证中…", "Verifying…") : t("登录", "Sign in")}
        </button>
        <button
          className="btn login-switch"
          type="button"
          onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(undefined); }}
        >
          {useRecovery ? t("改用动态码", "Use a verification code instead") : t("无法使用验证器？使用恢复码", "Lost your authenticator? Use a recovery code")}
        </button>
      </form>
    </div>
  );
}
