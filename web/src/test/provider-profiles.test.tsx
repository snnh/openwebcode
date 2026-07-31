import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderProfilesSection } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { ProviderProfilesView } from "../lib/contracts";

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

function renderProfiles(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderProfilesSection />
    </QueryClientProvider>,
  );
}

describe("ProviderProfilesSection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows multiple profiles with masked secrets and selects web capabilities independently", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue(profiles);
    const select = vi.spyOn(api, "selectWebProvider").mockResolvedValue({ ...profiles, activeWeb: { search: "Jina", fetch: "Jina" } });
    const view = renderProfiles();

    expect(await view.findByText("主服务")).toBeInTheDocument();
    expect(view.getByText("备用")).toBeInTheDocument();
    expect(view.getByText("sk-main…1234")).toBeInTheDocument();
    expect(view.queryByText(/secret/i)).not.toBeInTheDocument();

    fireEvent.change(view.getByLabelText("Web Search"), { target: { value: "Jina" } });
    await waitFor(() => expect(select).toHaveBeenCalledWith("search", "Jina"));
  });

  it("creates a named model provider without combining it with a separate provider selector", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
    const create = vi.spyOn(api, "createModelProvider").mockResolvedValue(profiles);
    const view = renderProfiles();

    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "本地 Ollama" } });
    fireEvent.change(view.getAllByPlaceholderText("API Key")[0]!, { target: { value: "local-key" } });
    fireEvent.click(view.getAllByRole("button", { name: "保存服务商" })[0]!);

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: "本地 Ollama",
      enabled: true,
      interfaceType: "openai-chat-completions",
      apiKey: "local-key",
    })));
  });

  it("sends parsed extraBody JSON and blocks invalid JSON", async () => {
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
    const create = vi.spyOn(api, "createModelProvider").mockResolvedValue(profiles);
    const view = renderProfiles();

    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "qwen" } });
    fireEvent.change(view.getByPlaceholderText(/自定义请求体/), { target: { value: '{"temperature": 0.7, "max_tokens": 8192}' } });
    fireEvent.click(view.getAllByRole("button", { name: "保存服务商" })[0]!);
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: "qwen",
      extraBody: { temperature: 0.7, max_tokens: 8192 },
    })));

    create.mockClear();
    fireEvent.change(await view.findByPlaceholderText("服务商名称"), { target: { value: "bad" } });
    fireEvent.change(view.getByPlaceholderText(/自定义请求体/), { target: { value: "{not json" } });
    fireEvent.click(view.getAllByRole("button", { name: "保存服务商" })[0]!);
    expect(await view.findByText("自定义请求体不是合法的 JSON 对象")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});
