interface UpdateCheckSnapshot {
  latestVersion: string;
  isNewer: boolean;
  htmlUrl: string;
  publishedAt: string;
  checkedAt: string;
}

export interface UpdateCheckResponse {
  snapshot: UpdateCheckSnapshot | null;
}

export type UpdateApplyStatus = "idle" | "downloading" | "verifying" | "applying" | "restarting" | "done" | "error";

export interface UpdateApplyState {
  status: UpdateApplyStatus;
  version: string;
  /** 0..1，未知为 null */
  progress: number | null;
  message: string;
  error?: string;
  startedAt: string;
}

/** TOTP 全局登录认证（提交⑥）：/api/auth/status 返回 */
export interface AuthStatus {
  totpEnabled: boolean;
  authenticated: boolean;
  /** 终端门槛（提交⑦预埋）：TOTP 已开启且监听地址回环或局域网 */
  terminalAvailable: boolean;
  gateReasons: string[];
}

export interface TotpSetupResponse {
  secret: string;
  otpauthUrl: string;
}

export interface TotpConfirmResponse {
  /** 恢复码明文仅此一次返回 */
  recoveryCodes: string[];
}

/** 远程访问（局域网/移动端）：GET /api/remote-access 返回 */
export interface RemoteAccessInfo {
  host: string;
  port: number | null;
  authEnabled: boolean;
  tokenSource: "env" | "generated" | null;
  maskedToken: string | null;
  /** 带 ?token= 的一键访问链接；仅认证模式下非空 */
  urls: string[];
}

/** POST /api/remote-access/regenerate-token 返回 */
export interface RegenerateTokenResponse {
  maskedToken: string;
  urls: string[];
  note: string;
}
