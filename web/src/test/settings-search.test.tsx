import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { SettingsView } from "../lib/contracts";

// jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：打桩为 open 属性开关
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
  // jsdom 无布局：selectTab 的滚动复位打桩
  Element.prototype.scrollTo = function scrollTo() { /* no-op */ } as typeof Element.prototype.scrollTo;
});

const settingsView: SettingsView = {
  groups: [
    {
      id: "network",
      label: "监听与端口",
      fields: [
        { key: "host", label: "监听地址", type: "text", value: "127.0.0.1", hasValue: true, source: "file", editable: true, restartRequired: true, nullable: false },
        { key: "port", label: "监听端口", type: "number", value: 3210, hasValue: true, source: "default", editable: true, restartRequired: true, nullable: false },
      ],
    },
    {
      id: "service",
      label: "存储",
      fields: [
        { key: "dataDir", label: "数据目录", type: "text", value: "../.openwebcode", hasValue: true, source: "default", editable: true, restartRequired: true, nullable: false },
      ],
    },
    {
      id: "models",
      label: "模型接入",
      fields: [
        { key: "catalogSyncUrl", label: "远程模型目录 URL", type: "text", value: null, hasValue: false, source: "default", editable: true, restartRequired: false, nullable: true },
      ],
    },
    {
      id: "general",
      label: "语言与货币",
      fields: [
        { key: "defaultCurrency", label: "默认货币", type: "select", options: [{ value: "USD", label: "USD" }, { value: "CNY", label: "CNY" }], value: "CNY", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
      ],
    },
    {
      id: "exchangeRate",
      label: "汇率",
      fields: [
        { key: "fixedUsdCnyRate", label: "固定美元汇率", type: "text", value: null, hasValue: false, source: "default", editable: true, restartRequired: true, nullable: true },
      ],
    },
    {
      id: "updateCheck",
      label: "更新检查",
      fields: [
        { key: "updateCheckUrl", label: "更新检查 URL", type: "text", value: "https://example.com/releases", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
      ],
    },
  ],
};

function renderDialog() {
  // 字段标签经 api.settings 异步拉取（SettingsDialog 打开时）
  vi.spyOn(api, "settings").mockResolvedValue(settingsView);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsDialog
        open
        preference="system"
        setPreference={() => undefined}
        accent="teal"
        setAccent={() => undefined}
        sendKey="enter"
        setSendKey={() => undefined}
        defaults={{}}
        setDefaults={() => undefined}
        providers={[]}
        models={[]}
        onResetLayout={() => undefined}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

function visibleTabs(): string[] {
  return Array.from(document.querySelectorAll(".settings-tab span:last-child")).map((node) => node.textContent ?? "");
}

describe("设置搜索", () => {
  it("按页签标题过滤导航，点击结果跳转对应页签", async () => {
    renderDialog();
    const search = screen.getByRole("textbox", { name: "搜索设置" });
    fireEvent.change(search, { target: { value: "快捷键" } });
    expect(visibleTabs()).toEqual(["快捷键"]);
    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    expect(await screen.findByRole("heading", { name: "键盘快捷方式", level: 3 })).toBeInTheDocument();
  });

  it("匹配存储分组字段中文标签（数据目录）→ 服务信息页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "数据目录" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["服务信息"]));
  });

  it("匹配模型接入分组字段中文标签 → 模型目录页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "远程模型目录" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["模型目录"]));
  });

  it("匹配语言与货币分组字段中文标签 → 通用页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "默认货币" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["通用"]));
  });

  it("匹配汇率分组字段中文标签 → 模型定价页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "固定美元汇率" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["模型定价"]));
  });

  it("匹配字段英文标签（SETTINGS_FIELD_EN）→ 模型定价页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "Fixed USD/CNY rate" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["模型定价"]));
  });

  it("匹配更新检查分组字段中文标签 → 服务信息页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "更新检查 URL" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["服务信息"]));
  });

  it("匹配 network 分组字段中文标签（监听端口）→ 远程访问页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "监听端口" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["远程访问"]));
  });

  it("匹配字段英文标签（SETTINGS_FIELD_EN）→ 远程访问页签", async () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "Listen Port" } });
    await waitFor(() => expect(visibleTabs()).toEqual(["远程访问"]));
  });

  it("匹配分组名时该分组全部页签保留", () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "个人偏好" } });
    expect(visibleTabs()).toEqual(["外观", "通用", "会话默认", "快捷键"]);
  });

  it("无匹配时展示空态；Esc 清空恢复全部页签", () => {
    renderDialog();
    const search = screen.getByRole("textbox", { name: "搜索设置" });
    fireEvent.change(search, { target: { value: "不存在的东西" } });
    expect(visibleTabs()).toEqual([]);
    expect(screen.getByText("无匹配")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(visibleTabs().length).toBe(11);
  });

  it("导航中不再包含服务设置页签", () => {
    renderDialog();
    expect(document.querySelector('[data-settings-tab="server"]')).toBeNull();
    expect(visibleTabs()).not.toContain("服务设置");
  });
});
