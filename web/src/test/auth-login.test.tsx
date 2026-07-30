import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "../components/AuthGate";
import { LoginPage } from "../components/LoginPage";
import { api, ApiError } from "../lib/api";
import type { AuthStatus } from "../lib/contracts";

function withClient(node: React.ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function authStatus(partial: Partial<AuthStatus>): AuthStatus {
  return { totpEnabled: true, authenticated: false, terminalAvailable: false, gateReasons: [], ...partial };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("登录页（TOTP 提交⑥）", () => {
  it("渲染动态码输入并提交登录", async () => {
    const login = vi.spyOn(api, "login").mockResolvedValue({ ok: true });
    const onAuthenticated = vi.fn();
    const view = withClient(<LoginPage onAuthenticated={onAuthenticated} />);
    const input = view.getByLabelText("动态码");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(view.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith("123456");
  });

  it("动态码错误与锁定提示如实展示", async () => {
    vi.spyOn(api, "login").mockRejectedValue(new ApiError(401, "Invalid code"));
    const view = withClient(<LoginPage onAuthenticated={vi.fn()} />);
    fireEvent.change(view.getByLabelText("动态码"), { target: { value: "000000" } });
    fireEvent.click(view.getByRole("button", { name: "登录" }));
    expect(await view.findByRole("alert")).toHaveTextContent("动态码不正确");

    vi.spyOn(api, "login").mockRejectedValue(new ApiError(429, "Too many attempts"));
    fireEvent.click(view.getByRole("button", { name: "登录" }));
    expect(await view.findByRole("alert")).toHaveTextContent(/锁定/);
  });

  it("恢复码入口切换", async () => {
    const login = vi.spyOn(api, "login").mockResolvedValue({ ok: true });
    const onAuthenticated = vi.fn();
    const view = withClient(<LoginPage onAuthenticated={onAuthenticated} />);
    fireEvent.click(view.getByRole("button", { name: /使用恢复码/ }));
    const input = view.getByLabelText("恢复码");
    fireEvent.change(input, { target: { value: "abcde-12345" } });
    fireEvent.click(view.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith("abcde-12345");
  });
});

describe("登录门禁 AuthGate（TOTP 提交⑥）", () => {
  it("totpEnabled 且未认证：渲染登录页，主界面不挂载", async () => {
    // 登录成功后 invalidate 会重拉 status，第二次起返回已认证
    vi.spyOn(api, "authStatus")
      .mockResolvedValueOnce(authStatus({}))
      .mockResolvedValue(authStatus({ authenticated: true, terminalAvailable: true }));
    vi.spyOn(api, "login").mockResolvedValue({ ok: true });
    const view = withClient(<AuthGate><div>main-ui</div></AuthGate>);
    expect(await view.findByLabelText("动态码")).toBeInTheDocument();
    expect(view.queryByText("main-ui")).toBeNull();
    // 登录成功后进入主界面
    fireEvent.change(view.getByLabelText("动态码"), { target: { value: "123456" } });
    fireEvent.click(view.getByRole("button", { name: "登录" }));
    expect(await view.findByText("main-ui")).toBeInTheDocument();
  });

  it("已认证或 TOTP 未启用：直接渲染主界面", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({ authenticated: true, terminalAvailable: true }));
    const view = withClient(<AuthGate><div>main-ui</div></AuthGate>);
    expect(await view.findByText("main-ui")).toBeInTheDocument();
    expect(view.queryByLabelText("动态码")).toBeNull();
  });

  it("TOTP 未启用：authenticated 视为真，不出现登录页", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({ totpEnabled: false, authenticated: true, gateReasons: ["totp_disabled"] }));
    const view = withClient(<AuthGate><div>main-ui</div></AuthGate>);
    expect(await view.findByText("main-ui")).toBeInTheDocument();
  });
});
