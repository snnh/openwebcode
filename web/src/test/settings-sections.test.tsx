import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogSyncSection, ModelSelectionSection } from "../settings/sections/ModelSelectionSection";
import { ContextSection } from "../settings/sections/ContextSection";
import { GeneralSection } from "../settings/sections/GeneralSection";
import { RemoteAccessSection } from "../settings/sections/RemoteAccessSection";
import { ServerSettingsFields } from "../settings/sections/ServerSettingsFields";
import { ShortcutsSection } from "../settings/sections/ShortcutsSection";
import { SystemStorageSection } from "../settings/sections/SystemStorageSection";
import { registerBuiltinCommands, resetCommands, DEFAULT_KEYBINDINGS } from "../app/commands";
import { api } from "../lib/api";
import type { SettingsView } from "../lib/contracts";
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

afterEach(() => {
  resetCommands();
  vi.restoreAllMocks();
});

describe("设置分区：快捷键（Phase 5b）", () => {
  it("列出全部默认键位与已注册命令标题", () => {
    const dispose = registerBuiltinCommands(() => stubActions());
    const view = renderWithClient(<ShortcutsSection />);
    expect(view.getByText("显示所有命令")).toBeInTheDocument();
    expect(view.getByText("切换主侧边栏可见性")).toBeInTheDocument();
    // 每条默认键位一行
    expect(view.getAllByRole("row")).toHaveLength(DEFAULT_KEYBINDINGS.length);
    dispose();
  });

  it("命令未注册时回退显示命令 id", () => {
    const view = renderWithClient(<ShortcutsSection />);
    expect(view.getByText("workbench.action.showCommands")).toBeInTheDocument();
  });
});

describe("设置分区：远程访问（Phase 5b §6.8）", () => {
  it("回环监听：展示地址并标注为安全默认", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("127.0.0.1"));
    const view = renderWithClient(<RemoteAccessSection />);
    expect(await view.findByText("127.0.0.1:3210")).toBeInTheDocument();
    expect(view.getByText(/仅本机回环/)).toBeInTheDocument();
    expect(view.queryByRole("alert")).toBeNull();
    // token 配置说明展示（多处提及，至少一处）
    expect(view.getAllByText(/OWC_ACCESS_TOKEN/).length).toBeGreaterThan(0);
  });

  it("非回环监听：展示风险提示", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("0.0.0.0"));
    const view = renderWithClient(<RemoteAccessSection />);
    expect(await view.findByText("0.0.0.0:3210")).toBeInTheDocument();
    expect(view.getByRole("alert").textContent).toMatch(/风险/);
  });

  it("加载失败如实显示", async () => {
    vi.spyOn(api, "settings").mockRejectedValue(new Error("boom"));
    const view = renderWithClient(<RemoteAccessSection />);
    expect(await view.findByText(/无法加载服务设置/)).toBeInTheDocument();
  });

  it("监听地址/端口字段在远程访问页签可编辑并带重启徽标", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("127.0.0.1"));
    const view = renderWithClient(<RemoteAccessSection />);
    // 分组标题
    expect(await view.findByRole("heading", { name: "监听与端口", level: 4 })).toBeInTheDocument();
    // 可编辑输入框（aria-label 为字段标签）
    expect(view.getByLabelText("监听地址")).toBeEnabled();
    expect(view.getByLabelText("监听端口")).toBeEnabled();
    // host source=file → 已覆盖徽标；两者 restartRequired → 重启后生效徽标
    expect(view.getByText("已覆盖")).toBeInTheDocument();
    expect(view.getAllByText("重启后生效")).toHaveLength(2);
    expect(view.getByRole("button", { name: "保存服务设置" })).toBeInTheDocument();
  });

  it("环境变量控制的监听地址在远程访问页签保持只读", async () => {
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
    const view = renderWithClient(<RemoteAccessSection />);
    expect(await view.findByLabelText("监听地址")).toBeDisabled();
    expect(view.getByText("环境变量")).toBeInTheDocument();
    expect(view.getByText(/由环境变量控制，界面内不可修改/)).toBeInTheDocument();
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

  it("执行器/存储/更新检查分组渲染在服务信息分区（系统与存储）", async () => {
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
  });

  it("env-lock 与重启徽标在服务信息分区保持", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<SystemStorageSection />);
    expect(await view.findByLabelText("执行器路径")).toBeDisabled();
    expect(view.getByText("环境变量")).toBeInTheDocument();
    expect(view.getByText(/由环境变量控制，界面内不可修改/)).toBeInTheDocument();
    // dataDir 与 corePath 均 restartRequired
    expect(view.getAllByText("重启后生效")).toHaveLength(2);
  });

  it("模型选择分组渲染在模型选择分区", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ModelSelectionSection />);
    expect(await view.findByLabelText("会话默认模型")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "模型选择", level: 4 })).toBeInTheDocument();
    // 其他分组不渲染
    expect(view.queryByLabelText("远程模型目录 URL")).toBeNull();
    expect(view.queryByLabelText("数据目录")).toBeNull();
    expect(view.queryByLabelText("监听地址")).toBeNull();
  });

  it("模型目录与同步分组渲染在模型目录分区", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ModelCatalogSyncSection />);
    expect(await view.findByLabelText("远程模型目录 URL")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "模型目录与同步", level: 4 })).toBeInTheDocument();
    // 其他分组不渲染
    expect(view.queryByLabelText("会话默认模型")).toBeNull();
    expect(view.queryByLabelText("数据目录")).toBeNull();
    expect(view.queryByLabelText("监听地址")).toBeNull();
  });

  it("汇率分组渲染在定价页签字段组件", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ServerSettingsFields showGroup={(groupId) => groupId === "exchangeRate"} />);
    expect(await view.findByLabelText("固定美元汇率")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "汇率", level: 4 })).toBeInTheDocument();
    expect(view.queryByLabelText("数据目录")).toBeNull();
  });

  it("通用分组渲染在通用页签字段组件（重排后仅语言/货币/模式）", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ServerSettingsFields showGroup={(groupId) => groupId === "general"} />);
    expect(await view.findByLabelText("默认货币")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "通用", level: 4 })).toBeInTheDocument();
    expect(view.getByText("启用 Chat 模式")).toBeInTheDocument();
    expect(view.queryByLabelText("数据目录")).toBeNull();
    // 重排后离线模式/自动压缩水位不再随通用分组渲染
    expect(view.queryByText("离线模式")).toBeNull();
    expect(view.queryByLabelText("自动压缩水位（%）")).toBeNull();
  });

  it("会话默认分组渲染在会话默认页签字段组件", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ServerSettingsFields showGroup={(groupId) => groupId === "defaults"} />);
    expect(await view.findByLabelText("默认思考力度")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "会话默认", level: 4 })).toBeInTheDocument();
    expect(view.queryByLabelText("默认货币")).toBeNull();
    expect(view.queryByLabelText("自动压缩水位（%）")).toBeNull();
  });

  it("上下文分组渲染在上下文页签字段组件", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ServerSettingsFields showGroup={(groupId) => groupId === "context"} />);
    expect(await view.findByLabelText("自动压缩水位（%）")).toBeInTheDocument();
    expect(view.getByLabelText("单条消息最大轮次")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "上下文与运行", level: 4 })).toBeInTheDocument();
    expect(view.queryByLabelText("默认货币")).toBeNull();
  });

  it("离线模式开关随联网分组渲染，镜像布尔字段写法", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ServerSettingsFields showGroup={(groupId) => groupId === "webSearch"} />);
    expect(await view.findByText("离线模式")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "联网", level: 4 })).toBeInTheDocument();
    expect(view.getByLabelText("联网搜索模式")).toBeInTheDocument();
    // 布尔字段渲染为 checkbox（无 aria-label，文案在字段头部），默认关
    const toggle = view.getByRole("checkbox");
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(view.getByText("关闭")).toBeInTheDocument();
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
