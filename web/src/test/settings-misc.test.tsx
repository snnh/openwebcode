import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PricingSection } from "../settings/sections/PricingSection";
import { PromptSection } from "../settings/sections/PromptSection";
import { TotpSection } from "../settings/sections/TotpSection";
import { ServerInfoSection } from "../settings/sections/ServerInfoSection";
import { GeneralSection } from "../settings/sections/GeneralSection";
import { api, ApiError } from "../lib/api";
import {
  desktopNotifyPermission,
  loadDesktopNotifyEnabled,
  maybeDesktopNotify,
  requestDesktopNotifyPermission,
  saveDesktopNotifyEnabled,
} from "../lib/desktop-notify";
import { setDesktopNotify, getDesktopNotify } from "../app/prefs-store";
import type { AuthStatus, PricingDocument, PromptOverrideView, Session, SettingsView, UpdateApplyState, VersionInfo } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

// 顶层清理合并（desktop-notify 原有 localStorage 清理）
beforeEach(() => {
  window.localStorage.clear();
});

// 顶层清理合并：prompt/totp 的 restoreAllMocks、desktop-notify 的 cleanup+unstubAllGlobals、
// settings-update 的 useRealTimers+restoreAllMocks（pricing 的清理保留在其 describe 内）
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ===== 以下 describe 合并自 pricing-section.test.tsx =====

const catalog: PricingDocument = {
  version: 1,
  updatedAt: "2026-07-14T00:00:00.000Z",
  entries: [],
};

function renderSection(): ReturnType<typeof renderWithClient> {
  return renderWithClient(<PricingSection />);
}

describe("PricingSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("submits a valid effective date and converts optional cache prices to zero", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T06:00:00.000Z"));
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalog);
    vi.spyOn(api, "models").mockResolvedValue([]);
    const save = vi.spyOn(api, "saveModelPricing").mockResolvedValue(catalog);
    const view = renderSection();

    fireEvent.click(await view.findByRole("button", { name: "添加条目" }));
    expect(view.getByLabelText("生效日期")).toHaveValue("2026-07-20");
    fireEvent.change(view.getByLabelText("provider"), { target: { value: "openai" } });
    fireEvent.change(view.getByLabelText("模型 id"), { target: { value: "deepseek-v4-flash" } });
    fireEvent.change(view.getByLabelText("输入单价"), { target: { value: "1" } });
    fireEvent.change(view.getByLabelText("输出单价"), { target: { value: "2" } });
    fireEvent.change(view.getByLabelText("缓存读"), { target: { value: "0.1" } });
    fireEvent.click(view.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      updatedAt: "2026-07-20T06:00:00.000Z",
      entries: [{
        provider: "openai",
        model: "deepseek-v4-flash",
        currency: "CNY",
        effectiveFrom: "2026-07-20",
        input: "1000000",
        output: "2000000",
        cacheRead: "100000",
        cacheWrite: "0",
      }],
    });
  });

  it("displays a structured remote pricing sync error", async () => {
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalog);
    vi.spyOn(api, "models").mockResolvedValue([]);
    const sync = vi.spyOn(api, "syncModelPricing").mockResolvedValue({ ok: false, error: "Remote document is invalid" });
    const view = renderSection();

    fireEvent.click(await view.findByRole("button", { name: "立即同步" }));

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(await view.findByText("Remote document is invalid")).toBeInTheDocument();
  });

  it("edits an existing entry and saves changes", async () => {
    const catalogWithEntry: PricingDocument = {
      version: 1,
      updatedAt: "2024-01-01T00:00:00Z",
      entries: [
        {
          provider: "openai",
          model: "gpt-4o",
          currency: "USD",
          effectiveFrom: "2024-06-01",
          input: "2000000",
          output: "6000000",
          cacheRead: "100000",
          cacheWrite: "0",
        },
      ],
    };
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalogWithEntry);
    vi.spyOn(api, "models").mockResolvedValue([]);
    const save = vi.spyOn(api, "saveModelPricing").mockResolvedValue(catalogWithEntry);
    const view = renderSection();

    // Click the Edit button on the existing row
    fireEvent.click(await view.findByRole("button", { name: "编辑" }));

    // Form should be pre-filled with micro→decimal converted values
    const inputPrice = view.getByLabelText("输入单价") as HTMLInputElement;
    const outputPrice = view.getByLabelText("输出单价") as HTMLInputElement;
    expect(inputPrice.value).toBe("2");
    expect(outputPrice.value).toBe("6");

    // Modify the output price and save
    fireEvent.change(outputPrice, { target: { value: "8" } });
    fireEvent.click(view.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][0] as PricingDocument;
    expect(saved.entries[0].output).toBe("8000000"); // 8 × 1_000_000
    expect(saved.entries[0].model).toBe("gpt-4o");
  });

  it("shows model suggestions from the catalog via datalist", async () => {
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalog);
    vi.spyOn(api, "models").mockResolvedValue([
      { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200000, capabilities: {} },
      { id: "gpt-4o", provider: "openai", contextWindow: 128000, capabilities: {} },
    ] as never);
    const view = renderSection();

    fireEvent.click(await view.findByRole("button", { name: "添加条目" }));

    // Datalist options should be rendered
    const modelDatalist = view.container.querySelector("#pricing-model-list");
    expect(modelDatalist).not.toBeNull();
    const options = modelDatalist!.querySelectorAll("option");
    expect(options.length).toBe(2);
  });
});

// ===== 以下 describe 合并自 prompt-section.test.tsx =====

const globalView: PromptOverrideView = {
  builtinBase: "内置基线",
  builtinInitPrompt: "内置 init",
  builtinCompactOverviewPrompt: "内置概览压缩",
  builtinCompactToolcallsPrompt: "内置工具压缩",
  promptVersion: "v-test",
  identityOverride: "全局身份",
  baseOverride: "全局基线",
  customAppend: "全局追加",
  subAgentAppend: "全局子代理",
  initOverride: "全局 init",
  compactOverviewOverride: null,
  compactToolcallsOverride: null,
};

const projectView: PromptOverrideView = {
  builtinBase: "内置基线",
  builtinInitPrompt: "内置 init",
  builtinCompactOverviewPrompt: "内置概览压缩",
  builtinCompactToolcallsPrompt: "内置工具压缩",
  promptVersion: "v-test",
  identityOverride: null,
  baseOverride: "项目基线",
  customAppend: null,
  subAgentAppend: "项目子代理",
  initOverride: null,
  compactOverviewOverride: "项目概览压缩",
  compactToolcallsOverride: null,
};

const session = { id: "s1", cwd: "/work/demo", provider: "p", model: "m", title: "demo", createdAt: "", updatedAt: "" } as unknown as Session;

function stubPromptApis(): void {
  vi.spyOn(api, "sessions").mockResolvedValue([session]);
  vi.spyOn(api, "promptOverride").mockImplementation(async (opts) => (opts?.scope === "project" ? projectView : globalView));
  vi.spyOn(api, "savePromptOverride").mockResolvedValue({ ok: true });
}

describe("PromptSection", () => {
  it("PromptSection：默认全局渲染七面；项目作用域切换与回切", async () => {
    stubPromptApis();
    const view = renderWithClient(<PromptSection sessionCwd="/work/demo" />);
    // 默认全局作用域渲染七个配置面并加载全局值
    await waitFor(() => expect(view.getByLabelText("身份行")).toHaveValue("全局身份"));
    expect(view.getByLabelText("基线覆盖")).toHaveValue("全局基线");
    expect(view.getByLabelText("追加指令")).toHaveValue("全局追加");
    expect(view.getByLabelText("子代理附加指令")).toHaveValue("全局子代理");
    expect(view.getByLabelText("/init 提示词")).toHaveValue("全局 init");
    expect(view.getByLabelText("压缩提示词（概览）")).toHaveValue("");
    expect(view.getByLabelText("压缩提示词（工具调用）")).toHaveValue("");

    // 切到当前项目作用域后按项目值渲染，切回全局恢复
    fireEvent.click(view.getByRole("button", { name: /当前项目/ }));
    await waitFor(() => expect(view.getByLabelText("基线覆盖")).toHaveValue("项目基线"));
    expect(api.promptOverride).toHaveBeenCalledWith({ scope: "project", cwd: "/work/demo" });
    expect(view.getByLabelText("身份行")).toHaveValue("");
    expect(view.getByLabelText("子代理附加指令")).toHaveValue("项目子代理");

    fireEvent.click(view.getByRole("button", { name: "全局" }));
    await waitFor(() => expect(view.getByLabelText("基线覆盖")).toHaveValue("全局基线"));
  });

  it("保存按当前作用域提交（空串转 null；项目携带 cwd）并上报 dirty", async () => {
    // 全局作用域：七个面（空串转 null）并上报 dirty
    stubPromptApis();
    const onDirtyChange = vi.fn();
    const global = renderWithClient(<PromptSection sessionCwd="/work/demo" onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(global.getByLabelText("追加指令")).toHaveValue("全局追加"));

    fireEvent.change(global.getByLabelText("追加指令"), { target: { value: "改成新的追加" } });
    fireEvent.change(global.getByLabelText("压缩提示词（概览）"), { target: { value: "自定义概览压缩" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(global.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.savePromptOverride).toHaveBeenCalledWith({
      scope: "global",
      identityOverride: "全局身份",
      baseOverride: "全局基线",
      customAppend: "改成新的追加",
      subAgentAppend: "全局子代理",
      initOverride: "全局 init",
      compactOverviewOverride: "自定义概览压缩",
      compactToolcallsOverride: null,
    }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    global.unmount();

    // 项目作用域：保存携带 cwd
    stubPromptApis();
    const project = renderWithClient(<PromptSection sessionCwd="/work/demo" />);
    await waitFor(() => expect(project.getByLabelText("基线覆盖")).toHaveValue("全局基线"));
    fireEvent.click(project.getByRole("button", { name: /当前项目/ }));
    await waitFor(() => expect(project.getByLabelText("基线覆盖")).toHaveValue("项目基线"));

    fireEvent.change(project.getByLabelText("身份行"), { target: { value: "项目身份" } });
    fireEvent.click(project.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.savePromptOverride).toHaveBeenCalledWith({
      scope: "project",
      cwd: "/work/demo",
      identityOverride: "项目身份",
      baseOverride: "项目基线",
      customAppend: null,
      subAgentAppend: "项目子代理",
      initOverride: null,
      compactOverviewOverride: "项目概览压缩",
      compactToolcallsOverride: null,
    }));
  });

  it("无会话时禁用项目档并给出说明", async () => {
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "promptOverride").mockResolvedValue(globalView);
    renderWithClient(<PromptSection />);
    await waitFor(() => expect(screen.getByLabelText("基线覆盖")).toHaveValue("全局基线"));
    expect(screen.getByRole("button", { name: "当前项目" })).toBeDisabled();
    expect(screen.getByText(/项目作用域不可用/)).toBeInTheDocument();
  });
});

// ===== 以下 describe 合并自 desktop-notify.test.tsx =====

/** 可控的 Notification 假实现：静态 permission/requestPermission + 实例记录 */
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(public readonly title: string, public readonly options?: { body?: string }) {
    FakeNotification.instances.push(this);
  }
}

function stubNotification(permission: NotificationPermission): void {
  FakeNotification.permission = permission;
  FakeNotification.instances = [];
  FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
  vi.stubGlobal("Notification", FakeNotification);
}

describe("桌面通知开关持久化", () => {
  it("默认关；save/load 往返", () => {
    expect(loadDesktopNotifyEnabled()).toBe(false);
    saveDesktopNotifyEnabled(true);
    expect(loadDesktopNotifyEnabled()).toBe(true);
    saveDesktopNotifyEnabled(false);
    expect(loadDesktopNotifyEnabled()).toBe(false);
  });
});

describe("desktopNotifyPermission / requestDesktopNotifyPermission", () => {
  it("desktopNotifyPermission：unsupported/已拒·已允许如实返回/default 才发起授权请求", async () => {
    // 浏览器不支持 Notification 时返回 unsupported（jsdom 无 Notification；确保全局干净）
    vi.stubGlobal("Notification", undefined);
    expect(desktopNotifyPermission()).toBe("unsupported");

    // 已拒绝/已允许状态如实返回
    stubNotification("denied");
    expect(desktopNotifyPermission()).toBe("denied");
    stubNotification("granted");
    expect(desktopNotifyPermission()).toBe("granted");

    // 仅 default 状态发起浏览器授权请求
    stubNotification("granted");
    expect(await requestDesktopNotifyPermission()).toBe("granted");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    stubNotification("default");
    FakeNotification.requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    expect(await requestDesktopNotifyPermission()).toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe("maybeDesktopNotify 失焦门控", () => {
  it.each<{ label: string; enabled: boolean; hidden: boolean; permission: NotificationPermission }>([
    { label: "开关关", enabled: false, hidden: true, permission: "granted" },
    { label: "页面可见", enabled: true, hidden: false, permission: "granted" },
    { label: "浏览器拒绝", enabled: true, hidden: true, permission: "denied" },
  ])("不弹：$label", ({ enabled, hidden, permission }) => {
    stubNotification(permission);
    vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
    expect(maybeDesktopNotify(enabled, { title: "t", body: "b" })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("开启 + 失焦 + 已授权：弹出通知，点击聚焦窗口并回调", () => {
    stubNotification("granted");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const focus = vi.fn();
    vi.stubGlobal("focus", focus);
    const onClick = vi.fn();
    expect(maybeDesktopNotify(true, { title: "权限待批准", body: "会话A：bash", onClick })).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("权限待批准");
    expect(FakeNotification.instances[0]!.options?.body).toBe("会话A：bash");
    FakeNotification.instances[0]!.onclick?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("通用设置：桌面通知开关", () => {
  function renderSection(overrides: { desktopNotify?: boolean } = {}) {
    vi.spyOn(api, "settings").mockResolvedValue({ groups: [] } as unknown as SettingsView);
    setDesktopNotify(overrides.desktopNotify ?? false);
    return renderWithClient(<GeneralSection />);
  }

  it("浏览器已拒绝：设置项如实展示拒绝状态", async () => {
    stubNotification("denied");
    const view = renderSection();
    expect(await view.findByText(/浏览器已拒绝桌面通知权限/)).toBeInTheDocument();
    expect(view.getByRole("checkbox", { name: /页面在后台时弹出系统通知/ })).not.toBeChecked();
  });

  it("开启时请求授权：通过与拒绝两条路径", async () => {
    // 授权通过后打开开关
    stubNotification("default");
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = "granted";
      return "granted" as NotificationPermission;
    });
    const granted = renderSection();
    fireEvent.click(granted.getByRole("checkbox", { name: /页面在后台时弹出系统通知/ }));
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getDesktopNotify()).toBe(true));
    granted.unmount();

    // 开启被拒：开关保持关闭
    stubNotification("default");
    FakeNotification.requestPermission = vi.fn(async () => "denied" as NotificationPermission);
    const denied = renderSection();
    fireEvent.click(denied.getByRole("checkbox", { name: /页面在后台时弹出系统通知/ }));
    await vi.waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalled());
    expect(getDesktopNotify()).toBe(false);
  });
});

// ===== 以下 describe 合并自 totp-settings.test.tsx =====

function authStatus(partial: Partial<AuthStatus>): AuthStatus {
  return { totpEnabled: false, authenticated: true, terminalAvailable: false, gateReasons: ["totp_disabled"], ...partial };
}

const RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `code${index}-xxxxx`);

describe("设置 → 远程访问：TOTP 向导（提交⑥）", () => {
  it("未启用 → 扫码 → 验码 → 一次性展示恢复码", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({}));
    const setup = vi.spyOn(api, "totpSetup").mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/OpenWebCode?secret=JBSWY3DPEHPK3PXP" });
    const confirm = vi.spyOn(api, "totpConfirm").mockResolvedValue({ recoveryCodes: RECOVERY_CODES });
    const view = renderWithClient(<TotpSection />);
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
    const view = renderWithClient(<TotpSection />);
    fireEvent.click(await view.findByRole("button", { name: "启用两步验证" }));
    fireEvent.change(await view.findByLabelText("动态码"), { target: { value: "000000" } });
    fireEvent.click(view.getByRole("button", { name: "确认启用" }));
    expect(await view.findByRole("alert")).toHaveTextContent("动态码不正确");
  });

  it("已启用：展示禁用入口（需输码）与终端门槛全满足状态", async () => {
    vi.spyOn(api, "authStatus").mockResolvedValue(authStatus({ totpEnabled: true, terminalAvailable: true, gateReasons: [] }));
    const disable = vi.spyOn(api, "totpDisable").mockResolvedValue({ ok: true });
    const view = renderWithClient(<TotpSection />);
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
    const view = renderWithClient(<TotpSection />);
    expect((await view.findByText(/监听地址为回环或局域网/)).textContent).toContain("❌");
    expect(view.getByText(/终端功能暂不可用/)).toBeInTheDocument();
  });
});

// ===== 以下 describe 合并自 settings-update.test.tsx =====

function makeState(partial: Partial<UpdateApplyState>): UpdateApplyState {
  return {
    status: "downloading",
    version: "0.6.0",
    progress: null,
    message: "",
    startedAt: "2026-07-27T00:00:00.000Z",
    ...partial,
  };
}

function versionWithRelease(isNewer: boolean): VersionInfo {
  return {
    server: "0.5.2",
    core: "0.5.2",
    githubRepo: "openwebcode/openwebcode",
    latestRelease: {
      version: "0.6.0",
      isNewer,
      htmlUrl: "https://example.com/release",
      publishedAt: "2026-07-26T00:00:00.000Z",
      checkedAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

function stubBaseQueries(isNewer = true): void {
  vi.spyOn(api, "health").mockResolvedValue({ status: "ok" });
  vi.spyOn(api, "version").mockResolvedValue(versionWithRelease(isNewer));
  vi.spyOn(api, "updateCheck").mockResolvedValue({ snapshot: null });
  vi.spyOn(api, "refreshUpdateCheck").mockResolvedValue({ snapshot: null });
}

describe("设置：在线更新（update apply）", () => {
  it("更新检查：有新版本显示按钮、已是最新不显示", async () => {
    // 有新版本
    stubBaseQueries(true);
    const newer = renderWithClient(<ServerInfoSection />);
    expect(await newer.findByRole("button", { name: "立即更新" })).toBeInTheDocument();
    newer.unmount();

    // 已是最新
    stubBaseQueries(false);
    const current = renderWithClient(<ServerInfoSection />);
    expect(await current.findByText(/已是最新/)).toBeInTheDocument();
    expect(current.queryByRole("button", { name: "立即更新" })).toBeNull();
  });

  it("点击后进入下载状态并展示进度", async () => {
    stubBaseQueries(true);
    const start = vi.spyOn(api, "updateApplyStart")
      .mockResolvedValue({ state: makeState({ status: "downloading", progress: 0.4 }) });
    vi.spyOn(api, "updateApplyStatus").mockResolvedValue({ state: makeState({ status: "downloading", progress: 0.4 }) });
    const view = renderWithClient(<ServerInfoSection />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(start).toHaveBeenCalledTimes(1);
    const button = await view.findByRole("button", { name: /下载中 40%/ });
    expect(button).toBeDisabled();
    const bar = view.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
  });

  it("轮询同步服务端状态（downloading → verifying）", async () => {
    stubBaseQueries(true);
    vi.spyOn(api, "updateApplyStart")
      .mockResolvedValue({ state: makeState({ status: "downloading", progress: null }) });
    vi.spyOn(api, "updateApplyStatus")
      .mockResolvedValue({ state: makeState({ status: "verifying" }) });
    const view = renderWithClient(<ServerInfoSection />);
    const button = await view.findByRole("button", { name: "立即更新" });
    // 初始查询就绪后再切 fake timers，仅接管轮询 interval
    vi.useFakeTimers();
    fireEvent.click(button);
    await act(async () => {});
    expect(view.getByRole("button", { name: "下载中" })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(view.getByRole("button", { name: "校验中…" })).toBeDisabled();
  });

  it("error 状态展示错误并允许重试", async () => {
    stubBaseQueries(true);
    const start = vi.spyOn(api, "updateApplyStart")
      .mockResolvedValueOnce({ state: makeState({ status: "error", error: "签名不匹配" }) })
      .mockResolvedValueOnce({ state: makeState({ status: "downloading", progress: null }) });
    const view = renderWithClient(<ServerInfoSection />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(await view.findByRole("alert")).toHaveTextContent("签名不匹配");
    const retry = view.getByRole("button", { name: "重试" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(start).toHaveBeenCalledTimes(2);
    expect(await view.findByRole("button", { name: "下载中" })).toBeDisabled();
  });

  it.each<{ status: UpdateApplyState["status"]; hint: RegExp }>([
    { status: "restarting", hint: /服务即将重启，更新后请刷新页面/ },
    { status: "done", hint: /更新已应用，请手动重启服务后刷新页面/ },
  ])("$status 状态提示对应文案", async ({ status, hint }) => {
    stubBaseQueries(true);
    vi.spyOn(api, "updateApplyStart")
      .mockResolvedValue({ state: makeState({ status }) });
    vi.spyOn(api, "updateApplyStatus")
      .mockResolvedValue({ state: makeState({ status }) });
    const view = renderWithClient(<ServerInfoSection />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(await view.findByText(hint)).toBeInTheDocument();
  });

  it("POST 被拒绝（400/409/501）时展示错误", async () => {
    stubBaseQueries(true);
    vi.spyOn(api, "updateApplyStart").mockRejectedValue(new Error("已有更新进行中"));
    const view = renderWithClient(<ServerInfoSection />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(await view.findByRole("alert")).toHaveTextContent("已有更新进行中");
  });
});
