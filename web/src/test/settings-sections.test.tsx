import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../i18n";
import { EmptyState } from "../components/EmptyState";
import { SettingsDialog } from "../settings/SettingsDialog";
import { ModelCatalogSection } from "../settings/sections/ModelCatalogSection";
import { ModelCatalogSyncSection, ModelSelectionSection } from "../settings/sections/ModelSelectionSection";
import { ModelProvidersSection, WebProvidersSection } from "../settings/sections/ProviderProfilesSection";
import { ContextSection } from "../settings/sections/ContextSection";
import { GeneralSection } from "../settings/sections/GeneralSection";
import { RemoteAccessSection } from "../settings/sections/RemoteAccessSection";
import { ServerSettingsFields } from "../settings/sections/ServerSettingsFields";
import { ShortcutsSection } from "../settings/sections/ShortcutsSection";
import { SystemStorageSection } from "../settings/sections/SystemStorageSection";
import { registerBuiltinCommands, resetCommands, DEFAULT_KEYBINDINGS } from "../app/commands";
import { api } from "../lib/api";
import { ui } from "../app/ui-store";
import type { ModelProfile, ProviderProfilesView, SettingsView } from "../lib/contracts";
import { stubActions } from "./helpers/stub-actions";
import { renderWithClient } from "./helpers/with-client";

function settingsWithHost(host: string): SettingsView {
  return {
    groups: [{
      id: "network",
      label: "监听与端口",
      fields: [
        { key: "host", label: "监听地址", type: "text", value: host, hasValue: true, source: "file", editable: true, restartRequired: true, nullable: false },
        { key: "port", label: "监听端口", type: "number", value: 3210, hasValue: true, source: "default", editable: true, restartRequired: true, nullable: false },
      ],
    }],
  };
}

// 顶层清理合并（provider-profiles 原有的 restoreAllMocks 并入）
afterEach(() => {
  resetCommands();
  vi.restoreAllMocks();
});

describe("设置分区：快捷键（Phase 5b）", () => {
  it("ShortcutsSection：列出默认键位；命令未注册回退显示 id", () => {
    // 全部默认键位与已注册命令标题
    const dispose = registerBuiltinCommands(() => stubActions());
    const registered = renderWithClient(<ShortcutsSection />);
    expect(registered.getByText("显示所有命令")).toBeInTheDocument();
    expect(registered.getByText("切换主侧边栏可见性")).toBeInTheDocument();
    // 每条默认键位一行
    expect(registered.getAllByRole("row")).toHaveLength(DEFAULT_KEYBINDINGS.length);
    dispose();
    registered.unmount();

    // 命令未注册时回退显示命令 id
    const fallback = renderWithClient(<ShortcutsSection />);
    expect(fallback.getByText("workbench.action.showCommands")).toBeInTheDocument();
  });
});

describe("设置分区：远程访问（Phase 5b §6.8）", () => {
  it("远程访问：回环展示为安全默认、非回环展示风险提示", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("127.0.0.1"));
    const loopback = renderWithClient(<RemoteAccessSection />);
    expect(await loopback.findByText("127.0.0.1:3210")).toBeInTheDocument();
    expect(loopback.getByText(/仅本机回环/)).toBeInTheDocument();
    expect(loopback.queryByRole("alert")).toBeNull();
    // token 配置说明展示（多处提及，至少一处）
    expect(loopback.getAllByText(/OWC_ACCESS_TOKEN/).length).toBeGreaterThan(0);
    loopback.unmount();

    // 非回环监听：展示风险提示
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("0.0.0.0"));
    const exposed = renderWithClient(<RemoteAccessSection />);
    expect(await exposed.findByText("0.0.0.0:3210")).toBeInTheDocument();
    expect(exposed.getByRole("alert").textContent).toMatch(/风险/);
  });

  it("加载失败如实显示", async () => {
    vi.spyOn(api, "settings").mockRejectedValue(new Error("boom"));
    const view = renderWithClient(<RemoteAccessSection />);
    expect(await view.findByText(/无法加载服务设置/)).toBeInTheDocument();
  });

  it("监听地址/端口：可编辑带重启徽标 vs 环境变量锁定只读", async () => {
    // 可编辑并带重启徽标
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("127.0.0.1"));
    const editable = renderWithClient(<RemoteAccessSection />);
    // 分组标题
    expect(await editable.findByRole("heading", { name: "监听与端口", level: 4 })).toBeInTheDocument();
    // 可编辑输入框（aria-label 为字段标签）
    expect(editable.getByLabelText("监听地址")).toBeEnabled();
    expect(editable.getByLabelText("监听端口")).toBeEnabled();
    // host source=file → 已覆盖徽标；两者 restartRequired → 重启后生效徽标
    expect(editable.getByText("已覆盖")).toBeInTheDocument();
    expect(editable.getAllByText("重启后生效")).toHaveLength(2);
    expect(editable.getByRole("button", { name: "保存服务设置" })).toBeInTheDocument();
    editable.unmount();

    // 环境变量控制 → 只读
    const envLocked: SettingsView = {
      groups: [{
        id: "network",
        label: "监听与端口",
        fields: [
          { key: "host", label: "监听地址", type: "text", value: "0.0.0.0", hasValue: true, source: "env", editable: false, restartRequired: true, nullable: false },
          { key: "port", label: "监听端口", type: "number", value: 3210, hasValue: true, source: "default", editable: true, restartRequired: true, nullable: false },
        ],
      }],
    };
    vi.spyOn(api, "settings").mockResolvedValue(envLocked);
    const locked = renderWithClient(<RemoteAccessSection />);
    expect(await locked.findByLabelText("监听地址")).toBeDisabled();
    expect(locked.getByText("环境变量")).toBeInTheDocument();
    expect(locked.getByText(/由环境变量控制，界面内不可修改/)).toBeInTheDocument();
  });
});

describe("设置分组迁移（服务设置页签移除后）", () => {
  const mixed: SettingsView = {
    groups: [
      {
        id: "service",
        label: "存储",
        fields: [
          { key: "dataDir", label: "数据目录", type: "text", value: "../.openwebcode", hasValue: true, source: "default", editable: true, restartRequired: true, nullable: false },
        ],
      },
      {
        id: "network",
        label: "监听与端口",
        fields: [
          { key: "host", label: "监听地址", type: "text", value: "127.0.0.1", hasValue: true, source: "default", editable: true, restartRequired: true, nullable: false },
          { key: "port", label: "监听端口", type: "number", value: 3210, hasValue: true, source: "default", editable: true, restartRequired: true, nullable: false },
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
        label: "模型目录与同步",
        fields: [
          { key: "catalogSyncUrl", label: "远程模型目录 URL", type: "text", value: null, hasValue: false, source: "default", editable: true, restartRequired: false, nullable: true },
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
        id: "general",
        label: "通用",
        fields: [
          { key: "defaultCurrency", label: "默认货币", type: "select", options: [{ value: "USD", label: "USD" }, { value: "CNY", label: "CNY" }], value: "CNY", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
          { key: "chatModeEnabled", label: "启用 Chat 模式", type: "boolean", value: false, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
      {
        id: "defaults",
        label: "会话默认",
        fields: [
          { key: "defaultEffort", label: "默认思考力度", type: "select", options: [{ value: "none", label: "none" }, { value: "low", label: "low" }], value: "none", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
      {
        id: "context",
        label: "上下文与运行",
        fields: [
          { key: "compactionThresholdPercent", label: "自动压缩水位（%）", type: "number", value: 85, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
          { key: "agentMaxTurns", label: "单条消息最大轮次", type: "number", value: 50, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
      {
        id: "webSearch",
        label: "联网",
        fields: [
          { key: "offlineMode", label: "离线模式", type: "boolean", value: false, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
          { key: "webSearchMode", label: "联网搜索模式", type: "select", options: [{ value: "local", label: "local" }], value: "local", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
      {
        id: "executor",
        label: "执行器",
        fields: [
          { key: "corePath", label: "执行器路径", type: "text", value: "owc-exec", hasValue: true, source: "env", editable: false, restartRequired: true, nullable: false },
        ],
      },
      {
        id: "updateCheck",
        label: "更新检查",
        fields: [
          { key: "updateCheckEnabled", label: "启用更新检查", type: "boolean", value: false, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
    ],
  };

  it("执行器/存储/更新检查归服务信息分区并保留 env-lock 与重启徽标", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<SystemStorageSection />);
    expect(await view.findByLabelText("数据目录")).toBeInTheDocument();
    expect(view.getByLabelText("执行器路径")).toBeInTheDocument();
    expect(view.getByText("启用更新检查")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "存储", level: 4 })).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "更新检查", level: 4 })).toBeInTheDocument();
    // 其他分组不渲染
    expect(view.queryByLabelText("监听地址")).toBeNull();
    expect(view.queryByLabelText("远程模型目录 URL")).toBeNull();
    expect(view.queryByLabelText("固定美元汇率")).toBeNull();

    // env-lock 与重启徽标保持
    expect(view.getByLabelText("执行器路径")).toBeDisabled();
    expect(view.getByText("环境变量")).toBeInTheDocument();
    expect(view.getByText(/由环境变量控制，界面内不可修改/)).toBeInTheDocument();
    // dataDir 与 corePath 均 restartRequired
    expect(view.getAllByText("重启后生效")).toHaveLength(2);
  });

  it("模型选择与模型目录分组渲染在各自分区", async () => {
    // 模型选择分区
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const selection = renderWithClient(<ModelSelectionSection />);
    expect(await selection.findByLabelText("会话默认模型")).toBeInTheDocument();
    expect(selection.getByRole("heading", { name: "模型选择", level: 4 })).toBeInTheDocument();
    // 其他分组不渲染
    expect(selection.queryByLabelText("远程模型目录 URL")).toBeNull();
    expect(selection.queryByLabelText("数据目录")).toBeNull();
    expect(selection.queryByLabelText("监听地址")).toBeNull();
    selection.unmount();

    // 模型目录分区
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const catalog = renderWithClient(<ModelCatalogSyncSection />);
    expect(await catalog.findByLabelText("远程模型目录 URL")).toBeInTheDocument();
    expect(catalog.getByRole("heading", { name: "模型目录与同步", level: 4 })).toBeInTheDocument();
    // 其他分组不渲染
    expect(catalog.queryByLabelText("会话默认模型")).toBeNull();
    expect(catalog.queryByLabelText("数据目录")).toBeNull();
    expect(catalog.queryByLabelText("监听地址")).toBeNull();
  });

  it.each<{ groupId: string; heading: string; present: string[]; absent: string[]; toggleRow?: boolean }>([
    { groupId: "exchangeRate", heading: "汇率", present: ["固定美元汇率"], absent: ["数据目录"] },
    { groupId: "general", heading: "通用", present: ["默认货币", "启用 Chat 模式"], absent: ["数据目录", "离线模式", "自动压缩水位（%）"] },
    { groupId: "defaults", heading: "会话默认", present: ["默认思考力度"], absent: ["默认货币", "自动压缩水位（%）"] },
    { groupId: "context", heading: "上下文与运行", present: ["自动压缩水位（%）", "单条消息最大轮次"], absent: ["默认货币"] },
    { groupId: "webSearch", heading: "联网", present: ["离线模式", "联网搜索模式"], absent: [], toggleRow: true },
  ])("$heading 分组归属各自分区渲染", async ({ groupId, heading, present, absent, toggleRow }) => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ServerSettingsFields showGroup={(groupId2) => groupId2 === groupId} />);
    expect(await view.findByRole("heading", { name: heading, level: 4 })).toBeInTheDocument();
    for (const text of present) expect(view.getByText(text)).toBeInTheDocument();
    for (const text of absent) expect(view.queryByText(text)).toBeNull();
    if (toggleRow) {
      // 布尔字段渲染为 checkbox（无 aria-label，文案在字段头部），默认关
      const toggle = view.getByRole("checkbox");
      expect(toggle).not.toBeChecked();
      expect(toggle).toBeEnabled();
      expect(view.getByText("关闭")).toBeInTheDocument();
    }
  });
});

describe("设置页重排：通用与上下文页签（Phase 4）", () => {
  const rearranged: SettingsView = {
    groups: [
      {
        id: "general",
        label: "通用",
        fields: [
          { key: "defaultLanguage", label: "默认语言", type: "select", options: [{ value: "zh-CN", label: "zh-CN" }], value: "zh-CN", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
          { key: "defaultCurrency", label: "默认货币", type: "select", options: [{ value: "USD", label: "USD" }, { value: "CNY", label: "CNY" }], value: "CNY", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
      {
        id: "context",
        label: "上下文与运行",
        fields: [
          { key: "compactionThresholdPercent", label: "自动压缩水位（%）", type: "number", value: 85, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
          { key: "agentMaxTurns", label: "单条消息最大轮次", type: "number", value: 50, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
      {
        id: "webSearch",
        label: "联网",
        fields: [
          { key: "offlineMode", label: "离线模式", type: "boolean", value: false, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      },
    ],
  };

  it("通用页签 h3 改为「语言、货币与模式」，且不再渲染离线模式/会话默认字段", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(rearranged);
    const view = renderWithClient(<GeneralSection />);
    expect(await view.findByLabelText("默认货币")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "语言、货币与模式", level: 3 })).toBeInTheDocument();
    expect(view.getByLabelText("默认语言")).toBeInTheDocument();
    expect(view.queryByText("离线模式")).toBeNull();
    expect(view.queryByLabelText("自动压缩水位（%）")).toBeNull();
  });

  it("上下文页签渲染自动压缩水位字段与说明", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(rearranged);
    const view = renderWithClient(<ContextSection />);
    expect(await view.findByLabelText("自动压缩水位（%）")).toBeInTheDocument();
    expect(view.getByLabelText("单条消息最大轮次")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "上下文与运行", level: 4 })).toBeInTheDocument();
    expect(view.getByText(/上下文占用达到水位时自动压缩/)).toBeInTheDocument();
    // 其他分组不渲染
    expect(view.queryByLabelText("默认货币")).toBeNull();
    expect(view.queryByText("离线模式")).toBeNull();
  });
});

// ===== 以下 describe 合并自 model-catalog.test.tsx =====

const multimodalModel: ModelProfile = {
  id: "multimodal-model",
  provider: "openai",
  displayName: "Multimodal model",
  source: "manual",
  contextWindow: 128_000,
  capabilities: {
    thinking: ["adaptive"],
    effort: ["medium"],
    modalities: ["text", "image", "video"],
    imageOutput: true,
    tools: true,
  },
};

function renderCatalog(): ReturnType<typeof renderWithClient> {
  return renderWithClient(<ModelCatalogSection />);
}

describe("ModelCatalogSection capabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ModelCatalogSection 还会查询 provider-profiles（编辑表单的可用服务商列表），
  // 不 mock 会打到真实 fetch，其时序依赖环境，曾导致 waitFor 偶发超时。
  function mockProfileQueries(): void {
    vi.spyOn(api, "models").mockResolvedValue([multimodalModel]);
    vi.spyOn(api, "modelSyncStatus").mockResolvedValue({ count: 0 });
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
  }

  it("shows image/video input and image output badges, then persists capabilities", async () => {
    mockProfileQueries();
    const save = vi.spyOn(api, "saveModel").mockResolvedValue(multimodalModel);
    const view = renderCatalog();

    expect(await view.findByText("图片输入")).toBeInTheDocument();
    expect(view.getByText("视频输入")).toBeInTheDocument();
    expect(view.getByText("图片输出")).toBeInTheDocument();

    fireEvent.doubleClick(view.getByText("Multimodal model").closest("tr")!);
    expect(screen.getByRole("checkbox", { name: "图片" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "视频" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "图片输出" })).toBeChecked();
    // 思维链回传：未声明时默认开（非 gpt/claude）
    expect(screen.getByRole("checkbox", { name: "思维链回传" })).toBeChecked();
    // effort 档位全集含 minimal（力度组以原始值渲染），声明项默认勾选
    expect(screen.getByRole("checkbox", { name: "minimal" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "medium" })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "视频" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "图片输出" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "思维链回传" }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith("multimodal-model", expect.objectContaining({
      capabilities: expect.objectContaining({
        modalities: ["text", "image"],
        imageOutput: false,
        reasoningContent: false,
      }),
    })));
  });

  it("round-trips the responsesEncryptedReplay capability checkbox", async () => {
    mockProfileQueries();
    const save = vi.spyOn(api, "saveModel").mockResolvedValue(multimodalModel);
    const view = renderCatalog();

    fireEvent.doubleClick(await view.findByText("Multimodal model").then((el) => el.closest("tr")!));
    // 未声明时默认关（server 默认 gpt/o 系开、其余关）
    const replay = screen.getByRole("checkbox", { name: "加密思维链回放（官方 OpenAI Responses）" });
    expect(replay).not.toBeChecked();

    fireEvent.click(replay);
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith("multimodal-model", expect.objectContaining({
      capabilities: expect.objectContaining({ responsesEncryptedReplay: true }),
    })));
  });

  it("模型目录远程同步：触发结果与上次同步展示", async () => {
    // 触发同步并展示结果
    mockProfileQueries();
    const sync = vi.spyOn(api, "syncModels").mockResolvedValue({
      ok: true,
      count: 2,
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    const first = renderCatalog();

    fireEvent.click(await first.findByRole("button", { name: "立即同步" }));

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(await first.findByText(/已同步 2 个远程模型/)).toBeInTheDocument();
    first.unmount();

    // 展示上次成功的远程同步
    vi.spyOn(api, "models").mockResolvedValue([multimodalModel]);
    vi.spyOn(api, "modelSyncStatus").mockResolvedValue({
      count: 2,
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
    const second = renderCatalog();

    expect(await second.findByText(/上次同步：/)).toHaveTextContent("2 个远程模型");
  });
});

// ===== 以下 describe 合并自 provider-profiles.test.tsx =====

const profiles: ProviderProfilesView = {
  modelProviders: [
    { id: "主服务", enabled: true, interfaceType: "openai-chat-completions", hasApiKey: true, maskedApiKey: "sk-main…1234" },
    { id: "备用", enabled: false, interfaceType: "anthropic-messages", promptCaching: true, hasApiKey: false },
  ],
  webProviders: [
    { id: "Brave 搜索", provider: "brave", capabilities: ["search"], hasApiKey: true, maskedApiKey: "brave-…5678" },
    { id: "Jina", provider: "jina", capabilities: ["search", "fetch"], hasApiKey: false },
    { id: "Tavily", provider: "tavily", capabilities: ["search", "fetch"], hasApiKey: true, maskedApiKey: "tvly-…1234" },
  ],
  activeWeb: { search: "Brave 搜索", fetch: "Jina" },
};

describe("ModelProvidersSection", () => {
  function renderProfiles(): ReturnType<typeof renderWithClient> {
    return renderWithClient(<ModelProvidersSection />);
  }

  it("shows multiple model profiles with masked secrets and no web provider section", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue(profiles);
    const view = renderProfiles();

    expect(await view.findByText("主服务")).toBeInTheDocument();
    expect(view.getByText("备用")).toBeInTheDocument();
    expect(view.getByText("sk-main…1234")).toBeInTheDocument();
    expect(view.queryByText(/secret/i)).not.toBeInTheDocument();
    // 联网服务商不在本分区
    expect(view.queryByText("联网服务商")).toBeNull();
    expect(view.queryByLabelText("联网搜索")).toBeNull();
  });

  it("creates a named model provider without combining it with a separate provider selector", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
    const create = vi.spyOn(api, "createModelProvider").mockResolvedValue(profiles);
    const view = renderProfiles();

    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "本地 Ollama" } });
    fireEvent.change(view.getByPlaceholderText("API Key"), { target: { value: "local-key" } });
    fireEvent.click(view.getByRole("button", { name: "保存服务商" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: "本地 Ollama",
      enabled: true,
      interfaceType: "openai-chat-completions",
      apiKey: "local-key",
    })));
  });

  it("applies a vendor preset, leaving only the API key to fill", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
    const create = vi.spyOn(api, "createModelProvider").mockResolvedValue(profiles);
    const view = renderProfiles();

    fireEvent.change(await view.findByLabelText("供应商预设"), { target: { value: "DeepSeek" } });
    expect(view.getByPlaceholderText("服务商名称")).toHaveValue("DeepSeek");
    expect(view.getByPlaceholderText("API Key")).toHaveValue("");

    fireEvent.change(view.getByPlaceholderText("API Key"), { target: { value: "sk-deepseek" } });
    fireEvent.click(view.getByRole("button", { name: "保存服务商" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: "DeepSeek",
      enabled: true,
      interfaceType: "openai-responses",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
    })));
  });

  it("sends parsed extraBody JSON and blocks invalid JSON", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
    const create = vi.spyOn(api, "createModelProvider").mockResolvedValue(profiles);
    const view = renderProfiles();

    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "qwen" } });
    fireEvent.change(view.getByPlaceholderText(/自定义请求体/), { target: { value: '{"temperature": 0.7, "max_tokens": 8192}' } });
    fireEvent.click(view.getByRole("button", { name: "保存服务商" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: "qwen",
      extraBody: { temperature: 0.7, max_tokens: 8192 },
    })));

    create.mockClear();
    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "bad" } });
    fireEvent.change(view.getByPlaceholderText(/自定义请求体/), { target: { value: "{not json" } });
    fireEvent.click(view.getByRole("button", { name: "保存服务商" }));
    expect(await view.findByText("自定义请求体不是合法的 JSON 对象")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("WebProvidersSection", () => {
  function renderProfiles(): ReturnType<typeof renderWithClient> {
    return renderWithClient(<WebProvidersSection />);
  }

  it("shows web profiles and selects web capabilities independently", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue(profiles);
    const select = vi.spyOn(api, "selectWebProvider").mockResolvedValue({ ...profiles, activeWeb: { search: "Jina", fetch: "Jina" } });
    const view = renderProfiles();

    // 名称同时出现在表格与能力下拉选项中，用脱敏密钥确认表格行渲染
    expect(await view.findByText("brave-…5678")).toBeInTheDocument();
    expect(view.getByText("tvly-…1234")).toBeInTheDocument();
    expect(view.getAllByText("Jina").length).toBeGreaterThan(0);
    // 模型服务商不在本分区
    expect(view.queryByText("模型服务商")).toBeNull();

    fireEvent.change(view.getByLabelText("联网搜索"), { target: { value: "Jina" } });
    await waitFor(() => expect(select).toHaveBeenCalledWith("search", "Jina"));
  });
});

// ===== 以下 describe 合并自 i18n.test.tsx =====

function Fixture() {
  const { language, setLanguage, t } = useI18n();
  return (
    <div>
      <span>{t("设置", "Settings")}</span>
      <button onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")}>switch</button>
    </div>
  );
}

describe("interface localization", () => {
  beforeEach(() => {
    window.localStorage.clear();
    HTMLElement.prototype.scrollTo = () => undefined;
  });

  it("loads a saved English preference and updates the document language", async () => {
    window.localStorage.setItem("owc-language", "en");
    render(<I18nProvider><Fixture /></I18nProvider>);

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByText("设置")).toBeInTheDocument();
    expect(window.localStorage.getItem("owc-language")).toBe("zh-CN");
  });

  it("renders product UI in English", () => {
    window.localStorage.setItem("owc-language", "en");
    render(<I18nProvider><EmptyState sessions={[]} onSelect={() => undefined} onCreate={() => undefined} /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Start a reversible coding job" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();
    expect(document.title).toBe("OpenWebCode · Coding Console");
  });

  it("switches languages from the settings UI and persists the choice", () => {
    window.localStorage.setItem("owc-language", "zh-CN");
    ui.openSettings();
    renderWithClient(
      <I18nProvider>
        <SettingsDialog />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByLabelText("界面语言"), { target: { value: "en" } });
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    expect(screen.getByText("Preferences")).toBeInTheDocument();
    expect(screen.getByText("AI & services")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Appearance" }), { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(window.localStorage.getItem("owc-language")).toBe("en");
  });
});
