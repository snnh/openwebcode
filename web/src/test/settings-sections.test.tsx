import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAccessSection, ShortcutsSection } from "../components/SettingsDialog";
import { registerBuiltinCommands, type CommandActions } from "../commands/builtin";
import { resetCommands } from "../commands/registry";
import { DEFAULT_KEYBINDINGS } from "../commands/keybindings";
import { api } from "../lib/api";
import type { SettingsView } from "../lib/contracts";

function stubActions(): CommandActions {
  return {
    showCommands: vi.fn(), quickOpen: vi.fn(), toggleSidebar: vi.fn(), toggleBottomPanel: vi.fn(),
    showView: vi.fn(), openSettings: vi.fn(), newSession: vi.fn(), importSession: vi.fn(),
    deleteCurrentSession: vi.fn(), sendDraft: vi.fn(), abortRun: vi.fn(), toggleTheme: vi.fn(),
    focusComposer: vi.fn(), nextSession: vi.fn(), previousSession: vi.fn(),
    showKeyboardShortcuts: vi.fn(), cycleZone: vi.fn(), showNotifications: vi.fn(),
    saveEditorFile: vi.fn(), toggleEditorSplit: vi.fn(),
    diffAcceptHunk: vi.fn(), diffRejectHunk: vi.fn(),
  };
}

function withClient(node: React.ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function settingsWithHost(host: string): SettingsView {
  return {
    groups: [{
      id: "service",
      label: "服务",
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
    const view = withClient(<ShortcutsSection />);
    expect(view.getByText("显示所有命令")).toBeInTheDocument();
    expect(view.getByText("切换主侧边栏可见性")).toBeInTheDocument();
    // 每条默认键位一行
    expect(view.getAllByRole("row")).toHaveLength(DEFAULT_KEYBINDINGS.length);
    dispose();
  });

  it("命令未注册时回退显示命令 id", () => {
    const view = withClient(<ShortcutsSection />);
    expect(view.getByText("workbench.action.showCommands")).toBeInTheDocument();
  });
});

describe("设置分区：远程访问（Phase 5b §6.8）", () => {
  it("回环监听：展示地址并标注为安全默认", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("127.0.0.1"));
    const view = withClient(<RemoteAccessSection />);
    expect(await view.findByText("127.0.0.1:3210")).toBeInTheDocument();
    expect(view.getByText(/仅本机回环/)).toBeInTheDocument();
    expect(view.queryByRole("alert")).toBeNull();
    // token 配置说明展示（多处提及，至少一处）
    expect(view.getAllByText(/OWC_ACCESS_TOKEN/).length).toBeGreaterThan(0);
  });

  it("非回环监听：展示风险提示", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settingsWithHost("0.0.0.0"));
    const view = withClient(<RemoteAccessSection />);
    expect(await view.findByText("0.0.0.0:3210")).toBeInTheDocument();
    expect(view.getByRole("alert").textContent).toMatch(/风险/);
  });

  it("加载失败如实显示", async () => {
    vi.spyOn(api, "settings").mockRejectedValue(new Error("boom"));
    const view = withClient(<RemoteAccessSection />);
    expect(await view.findByText(/无法加载服务设置/)).toBeInTheDocument();
  });
});
