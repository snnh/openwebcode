import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TotpSection } from "../components/settings/TotpSection";
import { api, ApiError } from "../lib/api";
import type { AuthStatus } from "../lib/contracts";

function withClient(node: React.ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function authStatus(partial: Partial<AuthStatus>): AuthStatus {
  return { totpEnabled: false, authenticated: true, terminalAvailable: false, gateReasons: ["totp_disabled"], ...partial };
}

const RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `code${index}-xxxxx`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("设置 → 远程访问：TOTP 向导（提交⑥）", () => {
  it("未启用 → 扫码 → 验码 → 一次性展示恢复码", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({}));
    const setup = vi.spyOn(api, "totpSetup").mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/OpenWebCode?secret=JBSWY3DPEHPK3PXP" });
    const confirm = vi.spyOn(api, "totpConfirm").mockResolvedValue({ recoveryCodes: RECOVERY_CODES });
    const view = withClient(<TotpSection />);
    // 门槛状态：TOTP ❌，监听地址 ✅（gateReasons 无 host_not_loopback_or_lan）
    expect(await view.findByText("启用两步验证")).toBeInTheDocument();
    expect(view.getByText(/TOTP 已开启/).textContent).toContain("❌");
    expect(view.getByText(/监听地址为回环或局域网/).textContent).toContain("✅");
    expect(view.getByText(/终端功能暂不可用/)).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "启用两步验证" }));
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    // QR 与手动密钥展示
    expect(await view.findByLabelText("TOTP 二维码")).toBeInTheDocument();
    expect(view.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();

    fireEvent.change(view.getByLabelText("动态码"), { target: { value: "123456" } });
    fireEvent.click(view.getByRole("button", { name: "确认启用" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("123456"));
    // 恢复码一次性展示 + 复制与完成按钮
    expect(await view.findByText(/只显示这一次/)).toBeInTheDocument();
    expect(view.container.querySelectorAll(".totp-recovery-list li")).toHaveLength(10);
    expect(view.getByRole("button", { name: "复制全部恢复码" })).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "我已保存，完成" }));
    expect(await view.findByRole("button", { name: "启用两步验证" })).toBeInTheDocument();
  });

  it("验码失败如实提示", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({}));
    vi.spyOn(api, "totpSetup").mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/OpenWebCode?secret=JBSWY3DPEHPK3PXP" });
    vi.spyOn(api, "totpConfirm").mockRejectedValue(new ApiError(400, "Invalid code"));
    const view = withClient(<TotpSection />);
    fireEvent.click(await view.findByRole("button", { name: "启用两步验证" }));
    fireEvent.change(await view.findByLabelText("动态码"), { target: { value: "000000" } });
    fireEvent.click(view.getByRole("button", { name: "确认启用" }));
    expect(await view.findByRole("alert")).toHaveTextContent("动态码不正确");
  });

  it("已启用：展示禁用入口（需输码）与终端门槛全满足状态", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({ totpEnabled: true, terminalAvailable: true, gateReasons: [] }));
    const disable = vi.spyOn(api, "totpDisable").mockResolvedValue({ ok: true });
    const view = withClient(<TotpSection />);
    expect(await view.findByText(/两步验证已启用/)).toBeInTheDocument();
    expect(view.getByText(/TOTP 已开启/).textContent).toContain("✅");
    expect(view.getByText(/监听地址为回环或局域网/).textContent).toContain("✅");
    expect(view.getByText(/终端功能可用/)).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: /禁用两步验证/ }));
    fireEvent.change(view.getByLabelText("动态码或恢复码"), { target: { value: "654321" } });
    fireEvent.click(view.getByRole("button", { name: "确认禁用" }));
    await waitFor(() => expect(disable).toHaveBeenCalledWith("654321"));
  });

  it("非回环/局域网监听：门槛第二项为 ❌", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({ totpEnabled: true, gateReasons: ["host_not_loopback_or_lan"] }));
    const view = withClient(<TotpSection />);
    expect((await view.findByText(/监听地址为回环或局域网/)).textContent).toContain("❌");
    expect(view.getByText(/终端功能暂不可用/)).toBeInTheDocument();
  });
});
