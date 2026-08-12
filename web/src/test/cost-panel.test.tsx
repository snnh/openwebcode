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

    expect(await screen.findByText(/按日/)).toBeInTheDocument();
    expect(screen.getByText(/按会话/)).toBeInTheDocument();
    // 汇总卡片（输入/输出主读数为紧凑格式，小字保留精确值）
    expect(screen.getByText("输入 / 输出")).toBeInTheDocument();
    expect(screen.getByText(/1,000 \/ 200/)).toBeInTheDocument();
    // 缓存命中卡与命中%列
    expect(screen.getByTestId("cache-hit-card")).toHaveTextContent("33%");
    expect(screen.getAllByRole("columnheader", { name: "命中%" })).toHaveLength(2);
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
    await screen.findByText(/按日/);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await screen.findByText(/按日/);
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith({}));
  });

  it("加载失败显示行内错误", async () => {
    vi.spyOn(api, "costReport").mockRejectedValue(new Error("boom"));
    renderWithClient(<CostPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("成本报表加载失败：boom");
  });
});

describe("CostPanel 缓存节省卡", () => {
  it("totals 带 cacheSavings 时渲染节省卡（偏好币种）", async () => {
    vi.spyOn(api, "costReport").mockResolvedValue(report({
      totals: {
        runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100,
        usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0,
        cacheSavings: { cnyMicroUnits: "2400000", usdMicroUnits: "330000" },
      },
    }));
    renderWithClient(<CostPanel />);
    const card = await screen.findByTestId("cache-savings-card");
    expect(card).toHaveTextContent("≈¥2.4");
    expect(card.textContent).not.toContain("*");
  });

  it("节省估算不完整时标 * 并在 title 注明", async () => {
    vi.spyOn(api, "costReport").mockResolvedValue(report({
      totals: {
        runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100,
        usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0,
        cacheSavings: { cnyMicroUnits: "2400000" },
        cacheSavingsIncomplete: true,
      },
    }));
    renderWithClient(<CostPanel />);
    const card = await screen.findByTestId("cache-savings-card");
    expect(card.textContent).toContain("*");
    expect(card.querySelector("b")!.getAttribute("title")).toContain("不完整");
  });

  it("无缓存活动时命中/节省卡整卡消失", async () => {
    vi.spyOn(api, "costReport").mockResolvedValue(report({
      totals: { runs: 1, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0, usdMicroUnits: "1000", cnyMicroUnits: "7000", unpricedTokens: 0 },
    }));
    renderWithClient(<CostPanel />);
    await screen.findByText(/按日/);
    expect(screen.queryByTestId("cache-hit-card")).toBeNull();
    expect(screen.queryByTestId("cache-savings-card")).toBeNull();
  });
});

describe("CostPanel 表格分页", () => {
  function manyDays(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, "0")}`,
      runs: 1, inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheWrite: 0,
      usdMicroUnits: "1000", cnyMicroUnits: "7000", unpricedTokens: 0,
      providers: [{ provider: "p", model: `m-${index}`, runs: 1, inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheWrite: 0, usdMicroUnits: "1000", cnyMicroUnits: "7000", unpricedTokens: 0 }],
    }));
  }

  it("超过每页组数出现分页器：翻页切换组、每页条数可改", async () => {
    vi.spyOn(api, "costReport").mockResolvedValue(report({ days: manyDays(25) }));
    renderWithClient(<CostPanel />);
    await screen.findByText(/按日/);
    // 默认每页 10 组：第一页 m-0..m-9，分页器显示 3 页
    expect(screen.getByText("p · m-0")).toBeInTheDocument();
    expect(screen.getByText("p · m-9")).toBeInTheDocument();
    expect(screen.queryByText("p · m-10")).toBeNull();
    const pager = screen.getAllByLabelText("下一页")[0]!;
    fireEvent.click(pager);
    expect(screen.getByText("p · m-10")).toBeInTheDocument();
    expect(screen.queryByText("p · m-9")).toBeNull();
    expect(screen.getByText(/第 2 \/ 3 页/)).toBeInTheDocument();
    // 每页 50 → 全部 25 组一页装下
    fireEvent.change(screen.getAllByLabelText("每页组数")[0]!, { target: { value: "50" } });
    expect(screen.getByText("p · m-0")).toBeInTheDocument();
    expect(screen.getByText("p · m-24")).toBeInTheDocument();
  });

  it("组数不超过每页时不渲染分页器", async () => {
    vi.spyOn(api, "costReport").mockResolvedValue(report());
    renderWithClient(<CostPanel />);
    await screen.findByText(/按日/);
    expect(screen.queryByLabelText("下一页")).toBeNull();
  });
});
