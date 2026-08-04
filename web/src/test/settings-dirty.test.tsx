import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../components/SettingsDialog";
import { I18nProvider } from "../i18n";
import { api } from "../lib/api";
import type { PricingDocument, PromptOverrideView, SettingsView } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

const settingsView: SettingsView = {
  groups: [{
    id: "updateCheck",
    label: "更新检查",
    fields: [
      { key: "updateCheckEnabled", label: "启用更新检查", type: "boolean", value: true, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
      { key: "updateCheckUrl", label: "更新检查 URL", type: "text", value: "https://example.com/releases", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
      { key: "updateCheckIntervalHours", label: "检查间隔（小时）", type: "number", value: 24, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
    ],
  }],
};

const pricingCatalog: PricingDocument = { version: 1, updatedAt: "2026-07-20T00:00:00.000Z", entries: [] };

const promptView: PromptOverrideView = {
  builtinBase: "内置基线",
  promptVersion: "v-test",
  baseOverride: null,
  customAppend: null,
};

beforeEach(() => {
  // jsdom 无布局：selectTab 的滚动复位打桩
  Element.prototype.scrollTo = function scrollTo() { /* no-op */ } as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function stubApis(): void {
  vi.spyOn(api, "settings").mockResolvedValue(settingsView);
  vi.spyOn(api, "health").mockResolvedValue({ status: "ok" });
  vi.spyOn(api, "version").mockResolvedValue({ server: "0.7.0", core: "0.7.0", githubRepo: "snnh/openwebcode" });
  vi.spyOn(api, "updateCheck").mockRejectedValue(new Error("not enabled"));
  vi.spyOn(api, "refreshUpdateCheck").mockRejectedValue(new Error("not enabled"));
  vi.spyOn(api, "modelPricing").mockResolvedValue(pricingCatalog);
  vi.spyOn(api, "promptOverride").mockResolvedValue(promptView);
}

function renderDialog(withI18n = false): void {
  stubApis();
  const dialog = (
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
    />
  );
  renderWithClient(withI18n ? <I18nProvider>{dialog}</I18nProvider> : dialog);
}

function activeTab(): string | null {
  return document.querySelector(".settings-tab.active")?.getAttribute("data-settings-tab") ?? null;
}

async function openTab(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() => expect(activeTab()).not.toBe("appearance"));
}

describe("设置页签切换与未保存改动确认", () => {
  it("编辑服务设置后切换页签：取消留在原页签，确认后丢弃并切换", async () => {
    renderDialog();
    await openTab("服务信息");
    fireEvent.change(await screen.findByLabelText("检查间隔（小时）"), { target: { value: "48" } });
    await waitFor(() => expect(screen.getByText("未保存")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    // 弹出放弃更改确认对话框；取消后留在原页签
    fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃更改" })).getByRole("button", { name: "取消" }));
    expect(activeTab()).toBe("info");

    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃更改" })).getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(activeTab()).toBe("shortcuts"));
  });

  it("无未保存改动时切换页签不弹确认", async () => {
    renderDialog();
    await openTab("服务信息");
    await screen.findByLabelText("检查间隔（小时）");
    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    await waitFor(() => expect(activeTab()).toBe("shortcuts"));
    expect(screen.queryByRole("dialog", { name: "放弃更改" })).toBeNull();
  });

  it("定价 JSON 编辑计入 dirty：切换页签需确认", async () => {
    renderDialog();
    await openTab("模型定价");
    fireEvent.click(await screen.findByRole("button", { name: "编辑 JSON" }));
    fireEvent.change(await screen.findByLabelText("定价目录 JSON"), { target: { value: "{}" } });

    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃更改" })).getByRole("button", { name: "取消" }));
    expect(activeTab()).toBe("pricing");

    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃更改" })).getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(activeTab()).toBe("shortcuts"));
  });

  it("提示词文本框编辑计入 dirty：切换页签与关闭对话框都需确认", async () => {
    renderDialog();
    await openTab("提示词");
    fireEvent.change(await screen.findByLabelText("追加指令"), { target: { value: "额外指令" } });

    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃更改" })).getByRole("button", { name: "取消" }));
    expect(activeTab()).toBe("prompt");

    // 关闭对话框（完成按钮）同样先确认
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(await screen.findByRole("dialog", { name: "放弃更改" })).toBeInTheDocument();
  });

  it("提示词未编辑时关闭对话框不弹确认", async () => {
    renderDialog();
    await openTab("提示词");
    await screen.findByLabelText("追加指令");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "放弃更改" })).toBeNull();
  });
});

describe("updateCheckIntervalHours 取值范围", () => {
  it("接受 0（仅手动检查）并保存", async () => {
    renderDialog();
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(settingsView);
    await openTab("服务信息");
    fireEvent.change(await screen.findByLabelText("检查间隔（小时）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务设置" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ updateCheckIntervalHours: 0 }));
  });

  it("拒绝超过 720 的值", async () => {
    renderDialog();
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(settingsView);
    await openTab("服务信息");
    fireEvent.change(await screen.findByLabelText("检查间隔（小时）"), { target: { value: "721" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务设置" }));
    expect(await screen.findByText(/不能超过 720 小时/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("更新检查字段英文标签", () => {
  it("en 界面显示英文标签", async () => {
    window.localStorage.setItem("owc-language", "en");
    renderDialog(true);
    fireEvent.click(screen.getByRole("button", { name: /Server info/ }));
    expect(await screen.findByText("Enable update check")).toBeInTheDocument();
    expect(screen.getByLabelText("Update check URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Check interval (hours)")).toBeInTheDocument();
  });
});
