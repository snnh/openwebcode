import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRow } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { ExtensionInfo } from "../lib/contracts";

function withClient(node: React.ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

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
    const view = withClient(<ExtensionRow extension={extension} />);

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
    vi.spyOn(api, "envSimPersonas").mockResolvedValue({
      personas: [
        { id: "claude", name: "Claude 风格", builtin: true },
        { id: "my-preset", name: "我的预设", builtin: false },
      ],
      directory: "D:\\data\\env-sim\\personas",
    });
    const configure = vi.spyOn(api, "configureExtension").mockResolvedValue(extensionFixture({}));
    const extension = extensionFixture({
      id: "env-sim",
      configSchema: {
        type: "object",
        properties: { persona: { type: "string", title: "人格预设" } },
      },
      config: {},
    });
    const view = withClient(<ExtensionRow extension={extension} />);

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

  it("env-sim：选中预设后展示详情预览（身份行 + 工具形态摘要）", async () => {
    vi.spyOn(api, "envSimPersonas").mockResolvedValue({
      personas: [{ id: "claude", name: "Claude 风格", builtin: true }],
      directory: "D:\\data\\env-sim\\personas",
    });
    const personaQuery = vi.spyOn(api, "envSimPersona").mockResolvedValue({
      id: "claude",
      name: "Claude 风格",
      builtin: true,
      identity: "You are Claude Code, Anthropic's agentic coding tool.",
      basePrompt: "base body",
      productSections: [],
      hideBuiltIns: ["remember", "spawn_swarm"],
      aliases: [
        { from: "bash", as: "Bash" },
        { from: "read_file", as: "Read" },
      ],
    });
    const extension = extensionFixture({
      id: "env-sim",
      configSchema: {
        type: "object",
        properties: { persona: { type: "string", title: "人格预设" } },
      },
      config: {},
    });
    const view = withClient(<ExtensionRow extension={extension} />);
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
    const view = withClient(<ExtensionRow extension={extension} />);
    expect(view.getByText("配置 JSON")).toBeInTheDocument();
    const textarea = view.container.querySelector("textarea.extension-json");
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});
