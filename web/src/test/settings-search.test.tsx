import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../settings/SettingsDialog";
import { ExtensionRow, localizeConfigFields } from "../settings/sections/ExtensionsSection";
import { parseConfigSchema } from "../settings/sections/ExtensionConfigForm";
import { ui } from "../app/ui-store";
import { I18nProvider } from "../i18n";
import { api } from "../lib/api";
import type { ExtensionInfo, PersonaDetail, PersonaSummary, PricingDocument, PromptOverrideView, SettingsView } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

// jsdom 无布局：selectTab 的滚动复位打桩
beforeEach(() => {
  Element.prototype.scrollTo = function scrollTo() { /* no-op */ } as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  ui.closeSettings();
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
  ui.openSettings();
  renderWithClient(
    <SettingsDialog />,
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

  it("匹配 AI 与服务分组名时六个页签全部保留", () => {
    renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), { target: { value: "AI 与服务" } });
    expect(visibleTabs()).toEqual(["模型目录", "模型选择", "上下文", "联网服务", "模型定价", "提示词"]);
  });

  it("无匹配时展示空态；Esc 清空恢复全部页签", () => {
    renderDialog();
    const search = screen.getByRole("textbox", { name: "搜索设置" });
    fireEvent.change(search, { target: { value: "不存在的东西" } });
    expect(visibleTabs()).toEqual([]);
    expect(screen.getByText("无匹配")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(visibleTabs().length).toBe(15);
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

const dirtySettingsView: SettingsView = {
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

function stubApis(): void {
  vi.spyOn(api, "settings").mockResolvedValue(dirtySettingsView);
  vi.spyOn(api, "health").mockResolvedValue({ status: "ok" });
  vi.spyOn(api, "version").mockResolvedValue({ server: "0.7.0", core: "0.7.0", githubRepo: "snnh/openwebcode" });
  vi.spyOn(api, "updateCheck").mockRejectedValue(new Error("not enabled"));
  vi.spyOn(api, "refreshUpdateCheck").mockRejectedValue(new Error("not enabled"));
  vi.spyOn(api, "modelPricing").mockResolvedValue(pricingCatalog);
  vi.spyOn(api, "models").mockResolvedValue([]);
  vi.spyOn(api, "promptOverride").mockResolvedValue(promptView);
}

function renderDirtyDialog(withI18n = false): void {
  stubApis();
  ui.openSettings();
  const dialog = (
    <SettingsDialog />
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
    renderDirtyDialog();
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
    renderDirtyDialog();
    await openTab("服务信息");
    await screen.findByLabelText("检查间隔（小时）");
    fireEvent.click(screen.getByRole("button", { name: /快捷键/ }));
    await waitFor(() => expect(activeTab()).toBe("shortcuts"));
    expect(screen.queryByRole("dialog", { name: "放弃更改" })).toBeNull();
  });

  it("定价 JSON 编辑计入 dirty：切换页签需确认", async () => {
    renderDirtyDialog();
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
    renderDirtyDialog();
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
    renderDirtyDialog();
    await openTab("提示词");
    await screen.findByLabelText("追加指令");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "放弃更改" })).toBeNull();
  });
});

describe("updateCheckIntervalHours 取值范围", () => {
  it("接受 0（仅手动检查）并保存", async () => {
    renderDirtyDialog();
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(dirtySettingsView);
    await openTab("服务信息");
    fireEvent.change(await screen.findByLabelText("检查间隔（小时）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务设置" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ updateCheckIntervalHours: 0 }));
  });

  it("拒绝超过 720 的值", async () => {
    renderDirtyDialog();
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(dirtySettingsView);
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
    renderDirtyDialog(true);
    fireEvent.click(screen.getByRole("button", { name: /Server info/ }));
    expect(await screen.findByText("Enable update check")).toBeInTheDocument();
    expect(screen.getByLabelText("Update check URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Check interval (hours)")).toBeInTheDocument();
  });
});

function extensionFixture(overrides: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: "test-ext",
    name: "测试扩展",
    version: "0.1.0",
    description: "测试用扩展",
    apiVersion: "1",
    permissions: [],
    enabled: true,
    builtIn: true,
    status: "running",
    config: {},
    ...overrides,
  };
}

/** env-sim 扩展行：persona 单字段 schema */
function envSimExtension(): ExtensionInfo {
  return extensionFixture({
    id: "env-sim",
    configSchema: {
      type: "object",
      properties: { persona: { type: "string", title: "人格预设" } },
    },
    config: {},
  });
}

function stubPersonas(personas: PersonaSummary[]): void {
  vi.spyOn(api, "envSimPersonas").mockResolvedValue({ personas, directory: "D:\\data\\env-sim\\personas" });
}

function personaFixture(overrides: Partial<PersonaDetail> = {}): PersonaDetail {
  return {
    id: "claude",
    name: "Claude 风格",
    builtin: true,
    identity: "You are Claude Code, Anthropic's agentic coding tool.",
    basePrompt: "base body",
    productSections: [],
    hideBuiltIns: [],
    aliases: [],
    ...overrides,
  };
}

describe("扩展类型化配置表单", () => {
  const typedSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      mode: { type: "string", title: "模式", enum: ["fast", "slow"] },
      verbose: { type: "boolean", title: "详细输出" },
      limit: { type: "number", title: "上限" },
    },
  };

  it("按 configSchema 渲染 select/checkbox/number，保存时提交合并后的配置", async () => {
    const configure = vi.spyOn(api, "configureExtension").mockResolvedValue(extensionFixture({}));
    const extension = extensionFixture({
      configSchema: typedSchema,
      config: { mode: "fast", verbose: true, limit: 5, extra: "keep" },
    });
    const view = renderWithClient(<ExtensionRow extension={extension} />);

    const modeSelect = view.getByLabelText("模式");
    expect(modeSelect.tagName).toBe("SELECT");
    expect(view.getByLabelText("详细输出")).toBeChecked();
    expect(view.getByLabelText("上限")).toHaveValue(5);
    // 有 schema 时不再渲染原始 JSON 编辑
    expect(view.container.querySelector("textarea.extension-json")).toBeNull();

    fireEvent.change(modeSelect, { target: { value: "slow" } });
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith("test-ext", {
      config: { mode: "slow", verbose: true, limit: 5, extra: "keep" },
    }));
  });

  it("env-sim：persona 选项来自 personas 接口，含（不模拟）与目录提示", async () => {
    stubPersonas([
      { id: "claude", name: "Claude 风格", builtin: true },
      { id: "my-preset", name: "我的预设", builtin: false },
    ]);    const configure = vi.spyOn(api, "configureExtension").mockResolvedValue(extensionFixture({}));
    const view = renderWithClient(<ExtensionRow extension={envSimExtension()} />);

    // 空选项 + 内置/自定义预设
    await view.findByRole("option", { name: "Claude 风格" });
    expect(view.getByRole("option", { name: "我的预设" })).toBeInTheDocument();
    expect(view.getByRole("option", { name: "（不模拟）" })).toBeInTheDocument();
    // 目录提示
    expect(view.getByText(/D:\\data\\env-sim\\personas/)).toBeInTheDocument();

    fireEvent.change(view.getByLabelText("人格预设"), { target: { value: "my-preset" } });
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith("env-sim", { config: { persona: "my-preset" } }));
  });

  it("env-sim：内置预设被覆盖时标记「已自定义」，提供「还原内置」按钮", async () => {
    stubPersonas([
      { id: "claude", name: "Claude 风格", builtin: true, overridden: true },
      { id: "my-preset", name: "我的预设", builtin: false },
    ]);
    vi.spyOn(api, "envSimPersona").mockResolvedValue(personaFixture({ identity: "You are MY Claude." }));
    const remove = vi.spyOn(api, "deleteEnvSimPersona").mockResolvedValue({ ok: true });
    const view = renderWithClient(<ExtensionRow extension={envSimExtension()} />);
    // 内置被覆盖：选项名带「已自定义」标记
    await view.findByRole("option", { name: "Claude 风格（已自定义）" });
    // 未选中时不显示还原按钮
    expect(view.queryByRole("button", { name: "还原内置预设" })).toBeNull();
    fireEvent.change(view.getByLabelText("人格预设"), { target: { value: "claude" } });
    await vi.waitFor(() => expect(view.getByRole("button", { name: "还原内置预设" })).toBeInTheDocument());
    // 两段确认后调用删除端点（删除覆盖文件即还原）
    fireEvent.click(view.getByRole("button", { name: "还原内置预设" }));
    fireEvent.click(view.getByRole("button", { name: "再次点击确认还原" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("claude"));
    // 纯自定义预设不受影响：删除语义仍是「删除此自定义预设」
    fireEvent.change(view.getByLabelText("人格预设"), { target: { value: "my-preset" } });
    await vi.waitFor(() => expect(view.getByRole("button", { name: "删除此自定义预设" })).toBeInTheDocument());
  });

  it("env-sim：新建预设表单提示内置 id 覆盖语义", async () => {
    stubPersonas([{ id: "claude", name: "Claude 风格", builtin: true }]);
    const view = renderWithClient(<ExtensionRow extension={envSimExtension()} />);
    fireEvent.click(view.getByRole("button", { name: "新建预设" }));
    expect(view.getByText(/id 与内置预设相同时即自定义该内置/)).toBeInTheDocument();
  });

  it("env-sim：选中预设后展示详情预览（身份行 + 工具形态摘要）", async () => {
    stubPersonas([{ id: "claude", name: "Claude 风格", builtin: true }]);
    const personaQuery = vi.spyOn(api, "envSimPersona").mockResolvedValue(personaFixture({
      hideBuiltIns: ["remember", "spawn_swarm"],
      aliases: [
        { from: "bash", as: "Bash" },
        { from: "read_file", as: "Read" },
      ],
    }));
    const view = renderWithClient(<ExtensionRow extension={envSimExtension()} />);
    await view.findByRole("option", { name: "Claude 风格" });

    // 未选中时没有预览
    expect(view.queryByTestId("persona-preview")).toBeNull();
    fireEvent.change(view.getByLabelText("人格预设"), { target: { value: "claude" } });
    await vi.waitFor(() => expect(personaQuery).toHaveBeenCalledWith("claude"));
    const preview = await view.findByTestId("persona-preview");
    expect(preview).toHaveTextContent("You are Claude Code");
    expect(preview).toHaveTextContent(/Bash/);
    expect(preview).toHaveTextContent(/2 个内置工具/);
  });

  it("无 configSchema 时回退到原始 JSON 编辑", () => {
    const extension = extensionFixture({ config: { a: 1 } });
    const view = renderWithClient(<ExtensionRow extension={extension} />);
    expect(view.getByText("配置 JSON")).toBeInTheDocument();
    const textarea = view.container.querySelector("textarea.extension-json");
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("无 configSchema 且配置为空时不渲染配置编辑区", () => {
    const extension = extensionFixture({ config: {} });
    const view = renderWithClient(<ExtensionRow extension={extension} />);
    expect(view.queryByText("配置 JSON")).toBeNull();
    expect(view.queryByText("配置")).toBeNull();
    expect(view.container.querySelector("textarea.extension-json")).toBeNull();
  });

  it("integer 字段渲染 min/max/step，保存为整数；非整数中止保存并报错", async () => {
    const configure = vi.spyOn(api, "configureExtension").mockResolvedValue(extensionFixture({}));
    const extension = extensionFixture({
      configSchema: {
        type: "object",
        properties: { maxPages: { type: "integer", minimum: 1, maximum: 300, title: "页数", description: "每次最多转换页数" } },
      },
      config: { maxPages: 4 },
    });
    const view = renderWithClient(<ExtensionRow extension={extension} />);

    const input = view.getByLabelText("页数");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "300");
    expect(input).toHaveAttribute("step", "1");
    expect(input).toHaveValue(4);
    expect(view.getByText("每次最多转换页数")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await vi.waitFor(() => expect(view.getByText(/必须是整数/)).toBeInTheDocument());
    expect(configure).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith("test-ext", { config: { maxPages: 8 } }));
  });

  it("嵌套 object 组与字符串字典：分组渲染，保存合并且保留未覆盖键", async () => {
    const configure = vi.spyOn(api, "configureExtension").mockResolvedValue(extensionFixture({}));
    const extension = extensionFixture({
      id: "content-lens",
      configSchema: {
        type: "object",
        properties: {
          targetLang: { type: "string", title: "目标语言" },
          translate: {
            type: "object",
            title: "翻译",
            properties: {
              mode: { type: "string", enum: ["manual", "auto", "off"], title: "触发方式" },
              glossary: { type: "object", additionalProperties: { type: "string" }, title: "术语表" },
            },
          },
        },
      },
      config: {
        targetLang: "zh-CN",
        translate: { mode: "manual", layout: "sideBySide", glossary: { 上下文: "context" } },
        explain: { webSearch: true },
      },
    });
    const view = renderWithClient(<ExtensionRow extension={extension} />);

    expect(view.getByText("翻译")).toBeInTheDocument();
    expect(view.getByLabelText("目标语言")).toHaveValue("zh-CN");
    expect(view.getByLabelText("触发方式")).toHaveValue("manual");
    expect(view.getByLabelText("术语表")).toHaveValue("上下文=context");

    fireEvent.change(view.getByLabelText("触发方式"), { target: { value: "auto" } });
    fireEvent.change(view.getByLabelText("术语表"), { target: { value: "上下文=context\n代理=agent" } });
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith("content-lens", {
      config: {
        targetLang: "zh-CN",
        translate: { mode: "auto", layout: "sideBySide", glossary: { 上下文: "context", 代理: "agent" } },
        explain: { webSearch: true },
      },
    }));
  });

  it("字典字段缺 = 的行中止保存并报错", async () => {
    const configure = vi.spyOn(api, "configureExtension").mockResolvedValue(extensionFixture({}));
    const extension = extensionFixture({
      configSchema: {
        type: "object",
        properties: {
          glossary: { type: "object", additionalProperties: { type: "string" }, title: "术语表" },
        },
      },
      config: {},
    });
    const view = renderWithClient(<ExtensionRow extension={extension} />);
    fireEvent.change(view.getByLabelText("术语表"), { target: { value: "没有等号的一行" } });
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await vi.waitFor(() => expect(view.getByText(/键=值/)).toBeInTheDocument());
    expect(configure).not.toHaveBeenCalled();
  });

  it("env-sim：新建预设表单提交结构化字段并选中新预设", async () => {
    vi.spyOn(api, "envSimPersonas")
      .mockResolvedValueOnce({
        personas: [{ id: "claude", name: "Claude 风格", builtin: true }],
        directory: "D:\\data\\env-sim\\personas",
      })
      .mockResolvedValue({
        personas: [
          { id: "claude", name: "Claude 风格", builtin: true },
          { id: "my-persona", name: "我的人格", builtin: false },
        ],
        directory: "D:\\data\\env-sim\\personas",
      });
    const save = vi.spyOn(api, "saveEnvSimPersona").mockResolvedValue(personaFixture({
      id: "my-persona",
      name: "我的人格",
      builtin: false,
      identity: "You are Mine.",
      basePrompt: "mine base",
    }));
    const view = renderWithClient(<ExtensionRow extension={envSimExtension()} />);
    await view.findByRole("option", { name: "Claude 风格" });

    fireEvent.click(view.getByRole("button", { name: "新建预设" }));
    const creator = await view.findByTestId("persona-creator");
    fireEvent.change(view.getByLabelText(/预设 id/), { target: { value: "my-persona" } });
    fireEvent.change(view.getByLabelText("显示名称"), { target: { value: "我的人格" } });
    fireEvent.change(view.getByLabelText("身份行"), { target: { value: "You are Mine." } });
    fireEvent.change(view.getByLabelText("基线提示词"), { target: { value: "mine base" } });
    // aliases 非法 JSON 先报错不上送
    fireEvent.change(view.getByLabelText(/aliases/), { target: { value: "{ not json" } });
    fireEvent.click(view.getByRole("button", { name: "保存预设" }));
    await vi.waitFor(() => expect(creator).toHaveTextContent(/JSON/));
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(view.getByLabelText(/aliases/), { target: { value: "[]" } });
    fireEvent.click(view.getByRole("button", { name: "保存预设" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({
      id: "my-persona",
      name: "我的人格",
      identity: "You are Mine.",
      basePrompt: "mine base",
      aliases: [],
    }));
    // 创建成功后自动选中新预设
    await vi.waitFor(() => expect(view.getByLabelText("人格预设")).toHaveValue("my-persona"));
  });

  it("env-sim：自定义预设出现删除按钮，两段确认后调用删除接口", async () => {
    stubPersonas([{ id: "my-preset", name: "我的预设", builtin: false }]);
    vi.spyOn(api, "envSimPersona").mockResolvedValue(personaFixture({
      id: "my-preset",
      name: "我的预设",
      builtin: false,
      identity: "You are Mine.",
      basePrompt: "mine base",
    }));
    const remove = vi.spyOn(api, "deleteEnvSimPersona").mockResolvedValue({ ok: true });
    const view = renderWithClient(<ExtensionRow extension={envSimExtension()} />);
    await view.findByRole("option", { name: "我的预设" });
    fireEvent.change(view.getByLabelText("人格预设"), { target: { value: "my-preset" } });

    const deleteButton = await view.findByRole("button", { name: "删除此自定义预设" });
    fireEvent.click(deleteButton);
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "再次点击确认删除" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("my-preset"));
    // 删除后选择回落到「不模拟」
    await vi.waitFor(() => expect(view.getByLabelText("人格预设")).toHaveValue(""));
  });
});

describe("localizeConfigFields 英文字段映射", () => {
  it("按字段 key 覆盖 title/description，递归嵌套组", () => {
    const fields = parseConfigSchema({
      type: "object",
      properties: {
        targetLang: { type: "string", title: "目标语言", description: "输出语言" },
        translate: {
          type: "object",
          title: "翻译",
          properties: {
            mode: { type: "string", title: "触发方式", enum: ["manual", "auto", "off"] },
          },
        },
      },
    });
    expect(fields).not.toBeNull();
    const localized = localizeConfigFields(fields, {
      targetLang: { title: "Target language", description: "Output language" },
      translate: { title: "Translation" },
      mode: { title: "Trigger" },
    });
    expect(localized).not.toBeNull();
    const [targetLang, translate] = localized!;
    expect(targetLang).toMatchObject({ key: "targetLang", title: "Target language", description: "Output language" });
    expect(translate).toMatchObject({ key: "translate", title: "Translation" });
    // 组级覆盖未给 description 时保留 schema 原值（此处原本就没有）
    expect(translate!.children).toHaveLength(1);
    expect(translate!.children![0]).toMatchObject({ key: "mode", title: "Trigger" });
  });

  it("无覆盖表或字段为 null 时原样返回", () => {
    expect(localizeConfigFields(null, { a: { title: "A" } })).toBeNull();
    const fields = parseConfigSchema({ type: "object", properties: { a: { type: "string" } } });
    expect(localizeConfigFields(fields, undefined)).toBe(fields);
  });
});

describe("parseConfigSchema x-model-picker", () => {
  it("解析模型选择器标记（vision-tools 配置由扩展 json 生成）；无标记字段不产生 modelPicker", () => {
    const fields = parseConfigSchema({
      type: "object",
      properties: {
        model: { type: "string", title: "视觉模型", description: "用于描述图片的模型", "x-model-picker": true },
        prompt: { type: "string", title: "描述提示词", default: "" },
        maxTokens: { type: "integer", minimum: 128, title: "输出上限（tokens）", description: "留空不限制" },
      },
      required: ["model"],
    });
    expect(fields).not.toBeNull();
    const model = fields!.find((field) => field.key === "model");
    expect(model).toMatchObject({ key: "model", modelPicker: true, title: "视觉模型" });
    expect(fields!.find((field) => field.key === "prompt")?.modelPicker).toBeUndefined();
  });
});
