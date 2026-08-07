import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostPanel } from "../panels/CostPanel";
import { api } from "../lib/api";
import type { CostReport } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

function report(overrides: Partial<CostReport> = {}): CostReport {
  return {
    preferences: { language: "zh", currency: "CNY", currencyLabel: "￥" },
    totals: { runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100, usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0 },
    days: [{
      date: "2026-07-30",
      runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100, usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0,
      providers: [{ provider: "anthropic", model: "claude-opus-4-8", runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100, usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0 }],
    }],
    sessions: [{
      sessionId: "s-1", title: "样例会话",
      runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100, usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0,
      providers: [{ provider: "anthropic", model: "claude-opus-4-8", runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100, usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0 }],
    }],
    ...overrides,
  } as CostReport;
}

afterEach(() => vi.restoreAllMocks());

describe("CostPanel", () => {
  it("加载中 → 展示汇总卡片与按日/按会话表格", async () => {
    vi.spyOn(api, "costReport").mockResolvedValue(report());
    renderWithClient(<CostPanel />);

    expect(await screen.findByText("按日")).toBeInTheDocument();
    expect(screen.getByText("按会话")).toBeInTheDocument();
    // 汇总卡片
    expect(screen.getByText("输入 / 输出")).toBeInTheDocument();
    expect(screen.getByText("1,000 / 200")).toBeInTheDocument();
    // 表格行
    expect(screen.getAllByText("anthropic · claude-opus-4-8")).toHaveLength(2);
    expect(screen.getByText("样例会话")).toBeInTheDocument();
    expect(screen.getByText("2026-07-30")).toBeInTheDocument();
  });

  it("范围内无调用时显示空态", async () => {
    vi.spyOn(api, "costReport").mockResolvedValue(report({
      totals: { runs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
      days: [],
      sessions: [],
    }));
    renderWithClient(<CostPanel />);
    expect(await screen.findByText(/所选范围内还没有模型调用记录/)).toBeInTheDocument();
  });

  it("切换范围重新取数（7d 带 from/to，全部不带）", async () => {
    const spy = vi.spyOn(api, "costReport").mockResolvedValue(report());
    renderWithClient(<CostPanel />);
    await screen.findByText("按日");
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await screen.findByText("按日");
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith({}));
  });

  it("加载失败显示行内错误", async () => {
    vi.spyOn(api, "costReport").mockRejectedValue(new Error("boom"));
    renderWithClient(<CostPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("成本报表加载失败：boom");
  });
});
