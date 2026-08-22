import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel } from "../workbench/BottomPanel";
import { CostPanel } from "../panels/CostPanel";
import { I18nProvider } from "../i18n";
import { PerfPanel } from "../panels/PerfPanel";
import { startFrameSampler, stopFrameSampler } from "../lib/perf-sampler";
import { api } from "../lib/api";
import type { CostReport, ExtensionInfo } from "../lib/contracts";
import { layoutStore } from "../workbench/layout";
import { sessionMeta, sessionStore } from "../app/session-store";
import { makeContextView, makeModelProfile, makeSession } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

// mock perf-sampler 避免 jsdom 中 requestAnimationFrame 问题
vi.mock("../lib/perf-sampler", () => ({
  startFrameSampler: vi.fn(),
  stopFrameSampler: vi.fn(),
  getFpsStats: () => ({ fps50: 60, fps95: 55, droppedFrames: 2, sampleCount: 280 }),
  isSamplerActive: () => true,
}));

// mock api 的 PerfPanel 接口，其余方法保留真实实现（bottom/cost 面板经 spyOn 打桩）
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      sessionPerf: vi.fn(),
      serverMetrics: vi.fn(),
      providerStats: vi.fn(),
    },
  };
});

const session = makeSession();

function evalExtension(enabled: boolean): ExtensionInfo {
  return { id: "owc-eval", enabled } as ExtensionInfo;
}

function mockBaseApis(extensions: ExtensionInfo[] = []): void {
  vi.spyOn(api, "extensions").mockResolvedValue(extensions);
  vi.spyOn(api, "sessions").mockResolvedValue([session]);
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "models").mockResolvedValue([makeModelProfile()]);
  vi.spyOn(api, "context").mockResolvedValue(makeContextView());
}

beforeEach(() => {
  window.localStorage.clear();
  layoutStore.set({ bottomOpen: false, bottomTab: "context", bottomHeight: 260 });
  sessionStore.set({ watermarks: {}, usages: {} });
  vi.clearAllMocks();
  // PerfPanel 数据 mock：实现必须在每个测试前重新装载——vi.restoreAllMocks() 会清掉
  // vi.mock 工厂里预设的 mockResolvedValue，导致其后测试中 sessionPerf 无实现、records 为空
  // （单跑通过、全量顺序跑失败的典型写死测试）。放在 beforeEach 保证每测试独立。
  api.sessionPerf.mockResolvedValue({
    records: [
      {
        runId: "run-1",
        sessionId: "s1",
        startedAt: "2026-07-25T00:00:00Z",
        finishedAt: "2026-07-25T00:00:05Z",
        turnCount: 3,
        stages: { contextBuildMs: 12.5, providerCallMs: 3200, toolExecMs: 850, totalMs: 4062.5 },
      },
    ],
  });
  api.serverMetrics.mockResolvedValue({
    events: { published: 1234, retained: 100, retainedBytes: 524288, oversizedNotRetained: 0 },
    websocket: { clients: 2, slowClientDisconnects: 0, failedClientSends: 0 },
  });
  api.providerStats.mockResolvedValue({ files: { active: 0, queued: 0, maxConcurrent: 2 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BottomPanel 页签与开合", () => {
  it("渲染页签条；eval 扩展未启用时不显示评测页签，启用后显示", async () => {
    mockBaseApis();
    const view = renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    expect(screen.getByRole("button", { name: "上下文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "时间线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "子代理" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "沙盒" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "成本" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "性能" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "评测" })).toBeNull();
    view.unmount();

    mockBaseApis([evalExtension(true)]);
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    expect(await screen.findByRole("button", { name: "评测" })).toBeInTheDocument();
  });

  it("点页签打开面板并加载对应内容；再点同页签收起", async () => {
    mockBaseApis();
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    expect(layoutStore.get().bottomOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    expect(layoutStore.get().bottomOpen).toBe(true);
    // 上下文面板内容（异步 lazy + 查询）出现
    expect(await screen.findByText("上下文用量")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    expect(layoutStore.get().bottomOpen).toBe(false);
  });

  it("切换页签保持展开；折叠按钮开合面板", async () => {
    mockBaseApis();
    vi.spyOn(api, "costReport").mockResolvedValue({
      preferences: { currency: "CNY" },
      totals: { runs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
      days: [],
      sessions: [],
    } as never);
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);

    fireEvent.click(screen.getByRole("button", { name: "成本" }));
    expect(layoutStore.get().bottomOpen).toBe(true);
    expect(layoutStore.get().bottomTab).toBe("cost");
    expect(await screen.findByText(/所选范围内还没有模型调用记录/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(layoutStore.get().bottomOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "展开面板" }));
    expect(layoutStore.get().bottomOpen).toBe(true);
  });

  it("eval 页签选中后扩展被禁用，自动回退到上下文页签", async () => {
    mockBaseApis();
    layoutStore.set({ bottomTab: "eval" });
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    await waitFor(() => expect(layoutStore.get().bottomTab).toBe("context"));
  });

  it("拖拽柄键盘 ArrowUp/Down 调整面板高度", async () => {
    mockBaseApis();
    layoutStore.set({ bottomOpen: true });
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    const resize = screen.getByRole("button", { name: /调整面板高度/ });
    fireEvent.keyDown(resize, { key: "ArrowUp" });
    expect(layoutStore.get().bottomHeight).toBe(300);
    fireEvent.keyDown(resize, { key: "ArrowDown" });
    expect(layoutStore.get().bottomHeight).toBe(260);
  });
});

describe("BottomPanel 状态项", () => {
  it("桌面端：状态点+文案、tokens·成本、窗口占用 %", async () => {
    mockBaseApis();
    sessionMeta.setUsage(session.id, { inputTokens: 1_200, outputTokens: 80, cacheRead: 0, cacheWrite: 0 });
    sessionMeta.setWatermark(session.id, {
      estimatedTokens: 45_000,
      contextWindow: 128_000,
      workingBudget: 120_000,
      utilization: 0.375,
      segments: { system: 0, input: 45_000, toolCalls: 0, output: 0, other: 0 },
      pinnedTokens: 0,
      buildMs: 1,
      incremental: true,
    });
    renderWithClient(<BottomPanel sessionId={session.id} agentState="streaming" mobile={false} />);
    const status = screen.getByLabelText("会话状态");
    expect(status).toHaveTextContent("正在输出");
    await waitFor(() => expect(status).toHaveTextContent("1.3k tok"));
    expect(status).toHaveTextContent("窗口 38%");
  });

  it("空闲态显示空闲；无会话时不渲染状态项", () => {
    mockBaseApis();
    renderWithClient(<BottomPanel mobile={false} />);
    expect(screen.queryByLabelText("会话状态")).toBeNull();
  });
});

describe("BottomPanel 移动端", () => {
  it("常驻三个页签，其余收进第二行；展开后可点选", async () => {
    mockBaseApis();
    renderWithClient(<BottomPanel sessionId={session.id} mobile={true} />);
    expect(screen.getByRole("button", { name: "上下文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "时间线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "成本" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "子代理" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "更多面板标签" }));
    const subagents = await screen.findByRole("button", { name: "子代理" });
    fireEvent.click(subagents);
    expect(layoutStore.get().bottomTab).toBe("subagents");
    expect(layoutStore.get().bottomOpen).toBe(true);
  });

  it("移动端状态项只显示状态点（无 tokens/窗口列）", async () => {
    mockBaseApis();
    renderWithClient(<BottomPanel sessionId={session.id} agentState="streaming" mobile={true} />);
    const status = screen.getByLabelText("会话状态");
    expect(status).toHaveTextContent("正在输出");
    await waitFor(() => expect(api.context).toHaveBeenCalled());
    expect(status).not.toHaveTextContent("tok");
  });
});

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
  it("totals 带 cacheSavings 渲染节省卡（偏好币种）；incomplete 标 * 并在 title 注明", async () => {
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
    // 不完整估算：标 * + title 注明
    cleanup();
    vi.spyOn(api, "costReport").mockResolvedValue(report({
      totals: {
        runs: 2, inputTokens: 1_000, outputTokens: 200, cacheRead: 500, cacheWrite: 100,
        usdMicroUnits: "1500000", cnyMicroUnits: "10500000", unpricedTokens: 0,
        cacheSavings: { cnyMicroUnits: "2400000" },
        cacheSavingsIncomplete: true,
      },
    }));
    renderWithClient(<CostPanel />);
    const incompleteCard = await screen.findByTestId("cache-savings-card");
    expect(incompleteCard.textContent).toContain("*");
    expect(incompleteCard.querySelector("b")!.getAttribute("title")).toContain("不完整");
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

function renderPanel(sessionId?: string) {
  return renderWithClient(
    <I18nProvider>
      <PerfPanel sessionId={sessionId} />
    </I18nProvider>,
  );
}

describe("PerfPanel", () => {
  it("渲染帧率区域显示采样数据", () => {
    renderPanel("s1");
    expect(screen.getByText("FPS p50")).toBeDefined();
    expect(screen.getByText("60")).toBeDefined();
  });

  it("展示 Turn 阶段耗时记录与 Provider 并发", async () => {
    renderPanel("s1");
    // 耗时文本由 fixture 与格式化逻辑共同决定：只断言结构（turns · 秒数），不锁死具体值
    expect(await screen.findByText(/3 turns · \d+(\.\d+)?s/)).toBeDefined();
    expect(await screen.findByText(/files: 0\/2 (活跃|active)/)).toBeDefined();
    expect(await screen.findByText("1234")).toBeDefined();
  });

  it("无会话时显示提示", () => {
    renderPanel(undefined);
    expect(screen.getByText(/选择会话以查看性能数据|Select a session/)).toBeDefined();
  });

  it("可暂停并持久化实时性能监控", () => {
    renderPanel("s1");
    const toggle = screen.getByRole("switch", { name: /实时性能监控|Live performance monitoring/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(startFrameSampler).toHaveBeenCalled();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(stopFrameSampler).toHaveBeenCalled();
    expect(window.localStorage.getItem("owc-perf-monitoring")).toBe("false");
    expect(screen.getByText(/实时采样与数据刷新已暂停|Live sampling and data refresh are paused/)).toBeDefined();
  });

  it("刷新后保持暂停且不启动采样或轮询", () => {
    window.localStorage.setItem("owc-perf-monitoring", "false");
    renderPanel("s1");

    expect(screen.getByRole("switch", { name: /实时性能监控|Live performance monitoring/ })).toHaveAttribute("aria-checked", "false");
    expect(startFrameSampler).not.toHaveBeenCalled();
    expect(api.sessionPerf).not.toHaveBeenCalled();
    expect(api.serverMetrics).not.toHaveBeenCalled();
    expect(api.providerStats).not.toHaveBeenCalled();
  });
});
