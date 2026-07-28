import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextPanel } from "../components/panels/ContextPanel";
import { api } from "../lib/api";
import type { ContextWindowInfo } from "../lib/context-window";
import type { ContextView, ContextUsage, ModelProfile, SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "s-1",
  cwd: "D:\\work",
  provider: "test",
  model: "test-model",
  title: "上下文会话",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  messages: [],
};

function contextView(selection: { pins: string[]; excludes: string[] }): ContextView {
  return {
    selection,
    stats: {
      totalTokens: 1200,
      segments: { system: 0, compactionSummary: 100, toolResults: 700, messages: 400, repoMap: 0, other: 0 },
      pinnedTokens: 50,
      buildMs: 1.5,
      incremental: true,
    },
    ledger: {
      usage: { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 },
      cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
      entries: [],
    },
    preferences: { language: "zh", currency: "CNY", currencyLabel: "RMB" },
  };
}

function renderPanel(windowUsage?: ContextWindowInfo, latestUsage?: ContextUsage): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ContextPanel sessionId={session.id} session={session} running={false} {...(windowUsage ? { windowUsage } : {})} {...(latestUsage ? { latestUsage } : {})} onNotice={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("ContextPanel 选择性上下文", () => {
  afterEach(() => vi.restoreAllMocks());

  it("展示按段归因、pin/排除清单，并支持添加与移除", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: ["m-1"], excludes: ["**/*.log"] }));
    const update = vi.spyOn(api, "updateContextSelection").mockResolvedValue({ pins: ["m-1", "src/a.ts"], excludes: ["**/*.log"] });

    renderPanel();

    // 按段 token 归因与构建诊断
    expect(await screen.findByText("按段 token 归因")).toBeInTheDocument();
    expect(screen.getByText("工具结果")).toBeInTheDocument();
    expect(screen.getByText(/增量复用/)).toBeInTheDocument();
    // 排除不是安全边界的提示
    expect(screen.getByText(/排除不是安全边界/)).toBeInTheDocument();
    // 现有清单
    expect(screen.getByText("m-1")).toBeInTheDocument();
    expect(screen.getByText("**/*.log")).toBeInTheDocument();

    // 添加 pin
    fireEvent.change(screen.getByLabelText("新增 pin"), { target: { value: "src/a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 pin" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(session.id, { pins: ["m-1", "src/a.ts"], excludes: ["**/*.log"] }));
  });

  it("移除排除路径", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: ["**/*.log", "docs/**"] }));
    const update = vi.spyOn(api, "updateContextSelection").mockResolvedValue({ pins: [], excludes: ["docs/**"] });

    renderPanel();
    expect(await screen.findByText("**/*.log")).toBeInTheDocument();
    const row = screen.getByText("**/*.log").closest(".context-entry")!;
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() => expect(update).toHaveBeenCalledWith(session.id, { pins: [], excludes: ["docs/**"] }));
  });
});

describe("ContextPanel 上下文窗口", () => {
  afterEach(() => vi.restoreAllMocks());

  const windowUsage: ContextWindowInfo = {
    estimatedTokens: 45_000,
    contextWindow: 128_000,
    workingBudget: 120_000,
    utilization: 0.375,
    segments: { system: 1_000, compactionSummary: 2_000, toolResults: 18_000, messages: 22_000, repoMap: 1_500, other: 500 },
    pinnedTokens: 800,
  };

  it("展示占用 meter、分段堆叠图例与 pin 占用", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));

    renderPanel(windowUsage);

    expect(await screen.findByText("上下文窗口")).toBeInTheDocument();
    const meter = screen.getByRole("meter", { name: "上下文窗口占用" });
    expect(meter).toHaveAttribute("aria-valuenow", "38");
    // 分段图例（避免与“按段 token 归因”的同名行混淆，限定在 legend 列表内）
    const legend = document.querySelector(".segment-legend")!;
    expect(legend.textContent).toContain("对话消息 22,000");
    expect(legend.textContent).toContain("工具结果 18,000");
    expect(legend.textContent).toContain("Repo map 1,500");
    expect(legend.textContent).toContain("压缩摘要 2,000");
    expect(legend.textContent).toContain("pin 占用 800");
    // 堆叠条分段使用各自的调色板类
    expect(document.querySelector(".segment-bar .seg-messages")).not.toBeNull();
    expect(document.querySelector(".segment-bar .seg-toolResults")).not.toBeNull();
  });

  it("compact_recommended 与 force_compact 显示对应提示", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));

    renderPanel({ ...windowUsage, utilization: 0.72, warning: "compact_recommended" });
    expect(await screen.findByText("上下文接近上限，建议压缩")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "上下文窗口占用" }).className).toContain("level-warn");
  });

  it("force_compact 提示本轮已自动压缩，meter 为 danger", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));

    renderPanel({ ...windowUsage, utilization: 0.9, warning: "force_compact" });
    const hint = await screen.findByText("已达强制压缩水位，本轮已自动压缩");
    expect(hint.className).toContain("danger");
    expect(screen.getByRole("meter", { name: "上下文窗口占用" }).className).toContain("level-danger");
  });

  it("无实时水位时由 REST stats + 模型档案播种", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    const models: ModelProfile[] = [
      { id: "test-model", provider: "test", contextWindow: 128_000, maxOutput: 8_000, capabilities: { thinking: ["disabled"], effort: ["low"], modalities: ["text"], imageOutput: false, tools: true } },
    ];
    vi.spyOn(api, "models").mockResolvedValue(models);

    renderPanel();

    // stats.totalTokens = 1200，workingBudget = 128000 - 8000 = 120000 → 1%
    expect(await screen.findByText("上下文窗口")).toBeInTheDocument();
    const meter = await screen.findByRole("meter", { name: "上下文窗口占用" });
    expect(meter).toHaveAttribute("aria-valuenow", "1");
  });
});

describe("ContextPanel 缓存命中", () => {
  afterEach(() => vi.restoreAllMocks());

  const windowUsage: ContextWindowInfo = {
    estimatedTokens: 45_000,
    contextWindow: 128_000,
    workingBudget: 120_000,
    utilization: 0.375,
    segments: { system: 0, compactionSummary: 0, toolResults: 0, messages: 45_000, repoMap: 0, other: 0 },
    pinnedTokens: 0,
  };

  function contextViewWithUsage(usage: ContextView["ledger"]["usage"]): ContextView {
    const view = contextView({ pins: [], excludes: [] });
    return { ...view, ledger: { ...view.ledger, usage } };
  }

  it("展示本轮与累计缓存命中行", async () => {
    // 累计 74k / (26k + 74k) = 74%
    vi.spyOn(api, "context").mockResolvedValue(contextViewWithUsage({ inputTokens: 26_000, outputTokens: 100, cacheRead: 74_000, cacheWrite: 8_000 }));

    // 本轮 98k / (21k + 98k) ≈ 82%
    renderPanel(windowUsage, { inputTokens: 21_000, outputTokens: 500, cacheRead: 98_000, cacheWrite: 12_000 });

    const row = await screen.findByTestId("ctx-cache");
    expect(row.textContent).toContain("本轮缓存命中 82%");
    expect(row.textContent).toContain("读取 98k");
    expect(row.textContent).toContain("写入 12k");
    expect(row.textContent).toContain("累计缓存命中 74%");
  });

  it("本轮与累计读写全为 0 时不渲染缓存行", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextViewWithUsage({ inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 }));

    renderPanel(windowUsage, { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 });

    await screen.findByText("上下文窗口");
    expect(screen.queryByTestId("ctx-cache")).toBeNull();
  });

  it("无本轮事件但累计有缓存活动时只显示累计行", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextViewWithUsage({ inputTokens: 26_000, outputTokens: 100, cacheRead: 74_000, cacheWrite: 8_000 }));

    renderPanel(windowUsage);

    const row = await screen.findByTestId("ctx-cache");
    expect(row.textContent).not.toContain("本轮缓存命中");
    expect(row.textContent).toContain("累计缓存命中 74%");
  });
});
