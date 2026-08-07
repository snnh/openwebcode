import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRow, localizeConfigFields } from "../settings/sections/ExtensionsSection";
import { parseConfigSchema } from "../settings/sections/ExtensionConfigForm";
import { api } from "../lib/api";
import type { ExtensionInfo } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

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
    const view = renderWithClient(<ExtensionRow extension={extension} />);

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
    const view = renderWithClient(<ExtensionRow extension={extension} />);
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
    const save = vi.spyOn(api, "saveEnvSimPersona").mockResolvedValue({
      id: "my-persona",
      name: "我的人格",
      builtin: false,
      identity: "You are Mine.",
      basePrompt: "mine base",
      productSections: [],
      hideBuiltIns: [],
      aliases: [],
    });
    const extension = extensionFixture({
      id: "env-sim",
      configSchema: { type: "object", properties: { persona: { type: "string", title: "人格预设" } } },
      config: {},
    });
    const view = renderWithClient(<ExtensionRow extension={extension} />);
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
    vi.spyOn(api, "envSimPersonas").mockResolvedValue({
      personas: [{ id: "my-preset", name: "我的预设", builtin: false }],
      directory: "D:\\data\\env-sim\\personas",
    });
    vi.spyOn(api, "envSimPersona").mockResolvedValue({
      id: "my-preset",
      name: "我的预设",
      builtin: false,
      identity: "You are Mine.",
      basePrompt: "mine base",
      productSections: [],
      hideBuiltIns: [],
      aliases: [],
    });
    const remove = vi.spyOn(api, "deleteEnvSimPersona").mockResolvedValue({ ok: true });
    const extension = extensionFixture({
      id: "env-sim",
      configSchema: { type: "object", properties: { persona: { type: "string", title: "人格预设" } } },
      config: {},
    });
    const view = renderWithClient(<ExtensionRow extension={extension} />);
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
