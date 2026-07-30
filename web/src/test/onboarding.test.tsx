import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "../components/EmptyState";
import { NewSessionDialog } from "../components/NewSessionDialog";
import { ProviderProfilesSection, SettingsDialog, type SettingsTab } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { ProviderProfilesView, SettingsView } from "../lib/contracts";

const emptyProfiles: ProviderProfilesView = { modelProviders: [], webProviders: [], activeWeb: {} };
const emptySettings: SettingsView = { groups: [] };

// jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：打桩为 open 属性开关
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function withClient(node: React.ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function stubCapabilitiesFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sandbox/capabilities")) return json({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "未启用" } });
    if (url.endsWith("/api/managed-workspace/capability")) return json({ platform: "linux", backends: [] });
    return json({ error: "not mocked" }, 404);
  }));
}

function renderSettings(initialTab?: SettingsTab): ReturnType<typeof render> {
  vi.spyOn(api, "providerProfiles").mockResolvedValue(emptyProfiles);
  vi.spyOn(api, "settings").mockResolvedValue(emptySettings);
  // 模型目录页签会同时挂载 ProviderProfilesSection / ModelAccessSection / ModelCatalogSection
  vi.spyOn(api, "models").mockResolvedValue([]);
  vi.spyOn(api, "modelSyncStatus").mockResolvedValue({ count: 0 });
  return withClient(
    <SettingsDialog
      open
      {...(initialTab !== undefined ? { initialTab } : {})}
      preference="system"
      setPreference={() => undefined}
      accent="teal"
      setAccent={() => undefined}
      sendKey="enter"
      setSendKey={() => undefined}
      desktopNotify={false}
      setDesktopNotify={() => undefined}
      defaults={{}}
      setDefaults={() => undefined}
      providers={[]}
      models={[]}
      onResetLayout={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe("SettingsDialog 深链 initialTab", () => {
  it("不传 initialTab 时保持默认页签（外观）", async () => {
    renderSettings();
    await waitFor(() => expect(document.getElementById("settings-section-title")).toHaveTextContent("外观"));
    expect(screen.getByRole("button", { name: /外观/ })).toHaveAttribute("aria-current", "page");
  });

  it("initialTab=models 时打开模型目录页签", async () => {
    renderSettings("models");
    await waitFor(() => expect(document.getElementById("settings-section-title")).toHaveTextContent("模型目录"));
    expect(screen.getByRole("button", { name: /^模型目录$/ })).toHaveAttribute("aria-current", "page");
  });
});

describe("NewSessionDialog 引导跳转", () => {
  it.each<{ label: string; providers: string[]; button: RegExp }>([
    { label: "无 provider", providers: [], button: /前往配置/ },
    { label: "无模型", providers: ["test-stub"], button: /前往模型目录/ },
  ])("$label 提示带跳转按钮，点击回调 models 页签", async ({ providers, button }) => {
    stubCapabilitiesFetch();
    const onOpenSettings = vi.fn();
    render(
      <NewSessionDialog open providers={providers} models={[]} onClose={() => undefined} onCreate={() => undefined} onOpenSettings={onOpenSettings} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: button }));
    expect(onOpenSettings).toHaveBeenCalledWith("models");
  });

  it("未提供 onOpenSettings 时提示保持纯文本", async () => {
    stubCapabilitiesFetch();
    render(
      <NewSessionDialog open providers={[]} models={[]} onClose={() => undefined} onCreate={() => undefined} />,
    );
    expect(await screen.findByText(/还没有可用的 Provider/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /前往配置/ })).not.toBeInTheDocument();
  });
});

describe("EmptyState 快速开始引导", () => {
  it("无 provider 时显示三步引导并触发对应回调", () => {
    const onOpenSettings = vi.fn();
    const onCreate = vi.fn();
    render(
      <EmptyState sessions={[]} providers={[]} onSelect={() => undefined} onCreate={onCreate} onOpenSettings={onOpenSettings} />,
    );
    const guide = screen.getByText("快速开始").closest(".empty-guide");
    expect(guide).not.toBeNull();
    const steps = within(guide as HTMLElement);
    fireEvent.click(steps.getByRole("button", { name: /配置服务商与 API Key/ }));
    expect(onOpenSettings).toHaveBeenCalledWith("models");
    fireEvent.click(steps.getByRole("button", { name: /刷新模型目录/ }));
    expect(onOpenSettings).toHaveBeenCalledWith("models");
    fireEvent.click(steps.getByRole("button", { name: /新建会话/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it.each<{ label: string; providers: string[] | undefined }>([
    { label: "已有 provider", providers: ["test-stub"] },
    { label: "provider 列表加载中（undefined）", providers: undefined },
  ])("$label 时不显示引导", ({ providers }) => {
    render(
      <EmptyState sessions={[]} providers={providers} onSelect={() => undefined} onCreate={() => undefined} onOpenSettings={() => undefined} />,
    );
    expect(screen.queryByText("快速开始")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeInTheDocument();
  });
});

describe("ProviderProfilesSection 测试连接", () => {
  function renderProfiles(): ReturnType<typeof render> {
    vi.spyOn(api, "providerProfiles").mockResolvedValue(emptyProfiles);
    return withClient(<ProviderProfilesSection />);
  }

  it("成功：显示绿色结果与延迟，请求体取表单当前值", async () => {
    const test = vi.spyOn(api, "testModelProvider").mockResolvedValue({ ok: true, latencyMs: 123 });
    const view = renderProfiles();
    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "测试服务" } });
    fireEvent.change(view.getByPlaceholderText(/Base URL/), { target: { value: "https://api.example.test/v1" } });
    fireEvent.change(view.getAllByPlaceholderText("API Key")[0]!, { target: { value: "sk-test" } });
    fireEvent.click(view.getByRole("button", { name: "测试连接" }));

    expect(await view.findByText(/连接成功/)).toHaveTextContent("123 ms");
    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      id: "测试服务",
      interfaceType: "openai-chat-completions",
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-test",
    }));
  });

  it("失败：展示服务端返回的中文错误", async () => {
    vi.spyOn(api, "testModelProvider").mockResolvedValue({ ok: false, error: "认证失败（401），请检查 API Key" });
    const view = renderProfiles();
    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "测试服务" } });
    fireEvent.click(view.getByRole("button", { name: "测试连接" }));

    expect(await view.findByText("认证失败（401），请检查 API Key")).toBeInTheDocument();
  });

  it("429 限流：视为可达并显示提示", async () => {
    vi.spyOn(api, "testModelProvider").mockResolvedValue({ ok: true, latencyMs: 42, note: "服务可达，但当前被限流（429）" });
    const view = renderProfiles();
    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "测试服务" } });
    fireEvent.click(view.getByRole("button", { name: "测试连接" }));

    expect(await view.findByText(/服务可达，但当前被限流/)).toBeInTheDocument();
  });
});
