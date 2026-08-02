import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAccessSection, RemoteAccessSection, ServerSettingsFields, ShortcutsSection, SystemStorageSection } from "../components/SettingsDialog";
import { registerBuiltinCommands } from "../commands/builtin";
import { resetCommands } from "../commands/registry";
import { DEFAULT_KEYBINDINGS } from "../commands/keybindings";
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
          { key: "fastModelMaxTokens", label: "最大输出上限", type: "number", value: 4_096, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
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
        label: "语言与货币",
        fields: [
          { key: "defaultCurrency", label: "默认货币", type: "select", options: [{ value: "USD", label: "USD" }, { value: "CNY", label: "CNY" }], value: "CNY", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
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

  it("模型选择/模型目录与同步分组渲染在模型目录分区，模型选择在前", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ModelAccessSection />);
    expect(await view.findByLabelText("会话默认模型")).toBeInTheDocument();
    expect(view.getByLabelText("最大输出上限")).toBeInTheDocument();
    expect(view.getByLabelText("远程模型目录 URL")).toBeInTheDocument();
    // 两组标题齐全，模型选择排在模型目录与同步之前
    const headings = view.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["模型选择", "模型目录与同步"]);
    // 其他分组不渲染
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

  it("语言与货币分组渲染在通用页签字段组件", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(mixed);
    const view = renderWithClient(<ServerSettingsFields showGroup={(groupId) => groupId === "general"} />);
    expect(await view.findByLabelText("默认货币")).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "语言与货币", level: 4 })).toBeInTheDocument();
    expect(view.queryByLabelText("数据目录")).toBeNull();
  });
});
