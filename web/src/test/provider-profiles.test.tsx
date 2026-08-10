import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelProvidersSection, WebProvidersSection } from "../settings/sections/ProviderProfilesSection";
import { api } from "../lib/api";
import type { ProviderProfilesView } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

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

afterEach(() => vi.restoreAllMocks());

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
