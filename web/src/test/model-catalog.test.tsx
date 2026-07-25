import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogSection } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { ModelProfile } from "../lib/contracts";

const multimodalModel: ModelProfile = {
  id: "multimodal-model",
  provider: "openai",
  displayName: "Multimodal model",
  source: "manual",
  contextWindow: 128_000,
  maxOutput: 16_384,
  capabilities: {
    thinking: ["adaptive"],
    effort: ["medium"],
    modalities: ["text", "image", "video"],
    imageOutput: true,
    tools: true,
  },
};

function renderCatalog(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ModelCatalogSection />
    </QueryClientProvider>,
  );
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

    fireEvent.click(screen.getByRole("checkbox", { name: "视频" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "图片输出" }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith("multimodal-model", expect.objectContaining({
      capabilities: expect.objectContaining({
        modalities: ["text", "image"],
        imageOutput: false,
      }),
    })));
  });

  it("runs remote catalog sync and displays its result", async () => {
    mockProfileQueries();
    const sync = vi.spyOn(api, "syncModels").mockResolvedValue({
      ok: true,
      count: 2,
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    const view = renderCatalog();

    fireEvent.click(await view.findByRole("button", { name: "立即同步" }));

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(await view.findByText(/已同步 2 个远程模型/)).toBeInTheDocument();
  });

  it("shows the last successful remote catalog sync", async () => {
    vi.spyOn(api, "models").mockResolvedValue([multimodalModel]);
    vi.spyOn(api, "modelSyncStatus").mockResolvedValue({
      count: 2,
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    vi.spyOn(api, "providerProfiles").mockResolvedValue({ modelProviders: [], webProviders: [], activeWeb: {} });
    const view = renderCatalog();

    expect(await view.findByText(/上次同步：/)).toHaveTextContent("2 个远程模型");
  });
});
