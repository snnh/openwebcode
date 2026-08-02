import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { SettingsView } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

// jsdom 无布局：selectTab 的滚动复位打桩
beforeEach(() => {
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
      id: "modelSelection",
      label: "模型选择",
      fields: [
        { key: "defaultModel", label: "会话默认模型", type: "select", options: [{ value: "fast-1", label: "fast-1" }], value: null, hasValue: false, source: "default", editable: true, restartRequired: false, nullable: true },
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

function renderDialog(view: SettingsView = settingsView) {
  // 字段标签经 api.settings 异步拉取（SettingsDialog 打开时）
  vi.spyOn(api, "settings").mockResolvedValue(view);
  renderWithClient(
    <SettingsDialog
      open
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

  it.each([
    { query: "数据目录", tab: "服务信息" },
    { query: "远程模型目录", tab: "模型目录" },
    { query: "会话默认模型", tab: "模型选择" },
    { query: "默认货币", tab: "通用" },
    { query: "固定美元汇率", tab: "模型定价" },
    { query: "Fixed USD/CNY rate", tab: "模型定价" },
    { query: "更新检查 URL", tab: "服务信息" },
    { query: "监听端口", tab: "远程访问" },
    { query: "Listen Port", tab: "远程访问" },
  ])("匹配字段标签（$query）→ $tab 页签", async ({ query, tab }) => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: query } });
    await waitFor(() => expect(visibleTabs()).toEqual([tab]));
  });

  it("匹配分组名时该分组全部页签保留", () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "个人偏好" } });
    expect(visibleTabs()).toEqual(["外观", "通用", "会话默认", "快捷键"]);
  });

  it("匹配 AI 与服务分组名时五个页签全部保留", () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "AI 与服务" } });
    expect(visibleTabs()).toEqual(["模型目录", "模型选择", "联网服务", "模型定价", "提示词"]);
  });

  it("无匹配时展示空态；Esc 清空恢复全部页签", () => {
    renderDialog();
    const search = screen.getByRole("textbox", { name: "搜索设置" });
    fireEvent.change(search, { target: { value: "不存在的东西" } });
    expect(visibleTabs()).toEqual([]);
    expect(screen.getByText("无匹配")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(visibleTabs().length).toBe(13);
  });

  it("导航中不再包含服务设置页签", () => {
    renderDialog();
    expect(document.querySelector('[data-settings-tab="server"]')).toBeNull();
    expect(visibleTabs()).not.toContain("服务设置");
  });

  it("未识别分组的字段不进搜索结果（没有可渲染的归属页签）", async () => {
    renderDialog({
      groups: [{
        id: "mystery",
        label: "神秘分组",
        fields: [
          { key: "mysteryField", label: "神秘字段", type: "text", value: "x", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      }],
    });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "神秘字段" } });
    await waitFor(() => expect(screen.getByText("无匹配")).toBeInTheDocument());
    expect(visibleTabs()).toEqual([]);
  });
});
