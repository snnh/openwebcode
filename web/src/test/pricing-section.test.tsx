import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PricingSection } from "../settings/sections/PricingSection";
import { api } from "../lib/api";
import type { PricingDocument } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

const catalog: PricingDocument = {
  version: 1,
  updatedAt: "2026-07-14T00:00:00.000Z",
  entries: [],
};

function renderSection(): ReturnType<typeof renderWithClient> {
  return renderWithClient(<PricingSection />);
}

describe("PricingSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("submits a valid effective date and converts optional cache prices to zero", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T06:00:00.000Z"));
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalog);
    vi.spyOn(api, "models").mockResolvedValue([]);
    const save = vi.spyOn(api, "saveModelPricing").mockResolvedValue(catalog);
    const view = renderSection();

    fireEvent.click(await view.findByRole("button", { name: "添加条目" }));
    expect(view.getByLabelText("生效日期")).toHaveValue("2026-07-20");
    fireEvent.change(view.getByLabelText("provider"), { target: { value: "openai" } });
    fireEvent.change(view.getByLabelText("模型 id"), { target: { value: "deepseek-v4-flash" } });
    fireEvent.change(view.getByLabelText("输入单价"), { target: { value: "1" } });
    fireEvent.change(view.getByLabelText("输出单价"), { target: { value: "2" } });
    fireEvent.change(view.getByLabelText("缓存读"), { target: { value: "0.1" } });
    fireEvent.click(view.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      updatedAt: "2026-07-20T06:00:00.000Z",
      entries: [{
        provider: "openai",
        model: "deepseek-v4-flash",
        currency: "CNY",
        effectiveFrom: "2026-07-20",
        input: "1000000",
        output: "2000000",
        cacheRead: "100000",
        cacheWrite: "0",
      }],
    });
  });

  it("displays a structured remote pricing sync error", async () => {
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalog);
    vi.spyOn(api, "models").mockResolvedValue([]);
    const sync = vi.spyOn(api, "syncModelPricing").mockResolvedValue({ ok: false, error: "Remote document is invalid" });
    const view = renderSection();

    fireEvent.click(await view.findByRole("button", { name: "立即同步" }));

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(await view.findByText("Remote document is invalid")).toBeInTheDocument();
  });

  it("edits an existing entry and saves changes", async () => {
    const catalogWithEntry: PricingDocument = {
      version: 1,
      updatedAt: "2024-01-01T00:00:00Z",
      entries: [
        {
          provider: "openai",
          model: "gpt-4o",
          currency: "USD",
          effectiveFrom: "2024-06-01",
          input: "2000000",
          output: "6000000",
          cacheRead: "100000",
          cacheWrite: "0",
        },
      ],
    };
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalogWithEntry);
    vi.spyOn(api, "models").mockResolvedValue([]);
    const save = vi.spyOn(api, "saveModelPricing").mockResolvedValue(catalogWithEntry);
    const view = renderSection();

    // Click the Edit button on the existing row
    fireEvent.click(await view.findByRole("button", { name: "编辑" }));

    // Form should be pre-filled with micro→decimal converted values
    const inputPrice = view.getByLabelText("输入单价") as HTMLInputElement;
    const outputPrice = view.getByLabelText("输出单价") as HTMLInputElement;
    expect(inputPrice.value).toBe("2");
    expect(outputPrice.value).toBe("6");

    // Modify the output price and save
    fireEvent.change(outputPrice, { target: { value: "8" } });
    fireEvent.click(view.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][0] as PricingDocument;
    expect(saved.entries[0].output).toBe("8000000"); // 8 × 1_000_000
    expect(saved.entries[0].model).toBe("gpt-4o");
  });

  it("shows model suggestions from the catalog via datalist", async () => {
    vi.spyOn(api, "modelPricing").mockResolvedValue(catalog);
    vi.spyOn(api, "models").mockResolvedValue([
      { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200000, capabilities: {} },
      { id: "gpt-4o", provider: "openai", contextWindow: 128000, capabilities: {} },
    ] as never);
    const view = renderSection();

    fireEvent.click(await view.findByRole("button", { name: "添加条目" }));

    // Datalist options should be rendered
    const modelDatalist = view.container.querySelector("#pricing-model-list");
    expect(modelDatalist).not.toBeNull();
    const options = modelDatalist!.querySelectorAll("option");
    expect(options.length).toBe(2);
  });
});
