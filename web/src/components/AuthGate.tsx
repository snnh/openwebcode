import { useEffect, type ReactElement, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, onUnauthorized } from "../lib/api";
import type { AuthStatus } from "../lib/contracts";
import { LoginPage } from "./LoginPage";

export const AUTH_STATUS_QUERY_KEY = ["auth-status"] as const;

/**
 * TOTP 登录门禁（提交⑥）：启动时查询 /api/auth/status，totpEnabled 且未认证时
 * 以全屏登录页替换主界面（App 不挂载，WS 与业务查询都不会发起）。
 * 运行期任意 API 返回 401（如服务端重启后票据失效）也统一回落到登录页。
 */
export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: AUTH_STATUS_QUERY_KEY, queryFn: api.authStatus, retry: false, staleTime: 5 * 60_000 });
  useEffect(() => onUnauthorized(() => {
    queryClient.setQueryData<AuthStatus>(AUTH_STATUS_QUERY_KEY, (previous) =>
      previous ? { ...previous, authenticated: false } : previous);
  }), [queryClient]);
  if (status.data?.totpEnabled && !status.data.authenticated) {
    return (
      <LoginPage
        onAuthenticated={() => {
          queryClient.setQueryData<AuthStatus>(AUTH_STATUS_QUERY_KEY, (previous) =>
            previous ? { ...previous, authenticated: true } : previous);
          // 登录成功：重新拉取全部业务数据（未认证期间这些查询要么未发起要么 401）
          void queryClient.invalidateQueries();
        }}
      />
    );
  }
  return <>{children}</>;
}
