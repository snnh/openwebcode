import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextPanel } from "../panels/ContextPanel";
import { compactionThresholdPercent, deriveWindowInfo, windowLevel } from "../lib/context-window";
import { api } from "../lib/api";
import type { ContextBuildStats, ContextView, ContextWatermark, ExtensionInfo, ModelProfile, SessionDetail, SettingsView } from "../lib/contracts";
import { sessionMeta, sessionStore } from "../app/session-store";
import { cleanup } from "@testing-library/react";
import { renderWithClient } from "./helpers/with-client";

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
      segments: { system: 0, input: 400, toolCalls: 700, output: 0, other: 100 },
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

function renderPanel(): void {
  renderWithClient(<ContextPanel sessionId={session.id} running={false} />);
}

/** 实时水位（旧实现由 App 经 props 下发；新实现自取 session-store） */
function setWatermark(info: { estimatedTokens: number; contextWindow: number; workingBudget: number; utilization: number; segments: ContextWatermark["segments"]; pinnedTokens: number; warning?: ContextWatermark["warning"] }): void {
  sessionMeta.setWatermark(session.id, {
    ...info,
    buildMs: 1,
    incremental: true,
  });
}

/** context-saver 扩展信息（面板仅当清单中 enabled: true 时渲染 saver 段落） */
function saverExtension(enabled: boolean): ExtensionInfo {
  return { id: "context-saver", enabled } as ExtensionInfo;
}

beforeEach(() => {
  sessionStore.set({ watermarks: {}, usages: {} });
  vi.spyOn(api, "session").mockResolvedValue(session);
  // 默认按扩展开启注入，覆盖 saver 段落渲染路径；关闭场景在用例内自行覆盖
  vi.spyOn(api, "extensions").mockResolvedValue([saverExtension(true)]);
});

afterEach(() => {
  sessionStore.set({ watermarks: {}, usages: {} });
  vi.restoreAllMocks();
});

describe("ContextPanel 选择性上下文", () => {
  it("选择性上下文：按段归因、pin/排除清单添加与移除", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: ["m-1"], excludes: ["**/*.log"] }));
    const update = vi.spyOn(api, "updateContextSelection").mockResolvedValue({ pins: ["m-1", "src/a.ts"], excludes: ["**/*.log"] });
    const view = renderWithClient(<ContextPanel sessionId={session.id} running={false} />);

    // 按段 token 归因与构建诊断
    expect(await view.findByText("按段 token 归因")).toBeInTheDocument();
    expect(view.getByText("工具调用")).toBeInTheDocument();
    expect(view.getByText(/增量复用/)).toBeInTheDocument();
    // 排除不是安全边界的提示
    expect(view.getByText(/排除不是安全边界/)).toBeInTheDocument();
    // 现有清单
    expect(view.getByText("m-1")).toBeInTheDocument();
    expect(view.getByText("**/*.log")).toBeInTheDocument();

    // 添加 pin
    fireEvent.change(view.getByLabelText("新增 pin"), { target: { value: "src/a.ts" } });
    fireEvent.click(view.getByRole("button", { name: "添加 pin" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(session.id, { pins: ["m-1", "src/a.ts"], excludes: ["**/*.log"] }));
    view.unmount();

    // 移除排除路径
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: ["**/*.log", "docs/**"] }));
    const updateRemove = vi.spyOn(api, "updateContextSelection").mockResolvedValue({ pins: [], excludes: ["docs/**"] });
    const removeView = renderWithClient(<ContextPanel sessionId={session.id} running={false} />);
    expect(await removeView.findByText("**/*.log")).toBeInTheDocument();
    const row = removeView.getByText("**/*.log").closest(".context-entry")!;
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() => expect(updateRemove).toHaveBeenCalledWith(session.id, { pins: [], excludes: ["docs/**"] }));
  });
});

describe("ContextPanel 上下文窗口", () => {
  const windowUsage = {
    estimatedTokens: 45_000,
    contextWindow: 128_000,
    workingBudget: 120_000,
    utilization: 0.375,
    segments: { system: 2_500, input: 22_000, toolCalls: 18_000, output: 0, other: 2_500 },
    pinnedTokens: 800,
  };

  it("展示占用 meter、分段堆叠图例与 pin 占用", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    setWatermark(windowUsage);

    renderPanel();

    expect(await screen.findByText("上下文窗口")).toBeInTheDocument();
    const meter = screen.getByRole("meter", { name: "上下文窗口占用" });
    expect(meter).toHaveAttribute("aria-valuenow", "38");
    // 分段图例（避免与“按段 token 归因”的同名行混淆，限定在 legend 列表内）
    const legend = document.querySelector(".segment-legend")!;
    expect(legend.textContent).toContain("输入 22,000");
    expect(legend.textContent).toContain("工具调用 18,000");
    expect(legend.textContent).toContain("系统提示词 2,500");
    expect(legend.textContent).toContain("其它 2,500");
    expect(legend.textContent).toContain("pin 占用 800");
    // 堆叠条分段使用各自的调色板类
    expect(document.querySelector(".segment-bar .seg-input")).not.toBeNull();
    expect(document.querySelector(".segment-bar .seg-toolCalls")).not.toBeNull();
  });

  it.each([
    ["compact_recommended", 0.72, "上下文接近上限，建议压缩", "level-warn", false],
    ["force_compact", 0.9, "已达强制压缩水位，本轮已自动压缩", "level-danger", true],
  ] as const)("水位 %s 时提示对应文案，meter 分级 %s", async (_warning, utilization, text, meterClass, hintDanger) => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    setWatermark({ ...windowUsage, utilization, warning: _warning });

    renderPanel();
    const hint = await screen.findByText(text);
    // force_compact 的提示带 danger 强调，compact_recommended 不带
    if (hintDanger) expect(hint.className).toContain("danger");
    expect(screen.getByRole("meter", { name: "上下文窗口占用" }).className).toContain(meterClass);
  });

  it("无实时水位时由 REST stats + 模型档案播种", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    const models: ModelProfile[] = [
      { id: "test-model", provider: "test", contextWindow: 128_000, capabilities: { thinking: ["disabled"], effort: ["low"], modalities: ["text"], imageOutput: false, tools: true } },
    ];
    vi.spyOn(api, "models").mockResolvedValue(models);

    renderPanel();

    // stats.totalTokens = 1200，workingBudget = contextWindow = 128000 → 约 1%
    expect(await screen.findByText("上下文窗口")).toBeInTheDocument();
    const meter = await screen.findByRole("meter", { name: "上下文窗口占用" });
    expect(meter).toHaveAttribute("aria-valuenow", "1");
  });
});

describe("ContextPanel 缓存命中", () => {
  const windowUsage = {
    estimatedTokens: 45_000,
    contextWindow: 128_000,
    workingBudget: 120_000,
    utilization: 0.375,
    segments: { system: 0, input: 45_000, toolCalls: 0, output: 0, other: 0 },
    pinnedTokens: 0,
  };

  function contextViewWithUsage(usage: ContextView["ledger"]["usage"]): ContextView {
    const view = contextView({ pins: [], excludes: [] });
    return { ...view, ledger: { ...view.ledger, usage } };
  }

  it("缓存行：本轮+累计渲染、全 0 不渲染、仅累计回退", async () => {
    // 本轮与累计命中行
    // 累计 74k / (26k + 74k) = 74%
    vi.spyOn(api, "context").mockResolvedValue(contextViewWithUsage({ inputTokens: 26_000, outputTokens: 100, cacheRead: 74_000, cacheWrite: 8_000 }));
    setWatermark(windowUsage);
    // 本轮 98k / (21k + 98k) ≈ 82%
    sessionMeta.setUsage(session.id, { inputTokens: 21_000, outputTokens: 500, cacheRead: 98_000, cacheWrite: 12_000 });
    const full = renderWithClient(<ContextPanel sessionId={session.id} running={false} />);

    const row = await full.findByTestId("ctx-cache");
    expect(row.textContent).toContain("本轮 82%");
    expect(row.querySelector(".pill")!.getAttribute("title")).toContain("本轮缓存命中 82");
    expect(row.querySelector(".pill")!.getAttribute("title")).toContain("写入 12k");
    // 累计 pill 带命中率分档 data-tone（74% → good 不标色）
    expect(row.querySelectorAll(".pill")[1]!.getAttribute("data-tone")).toBe("good");
    expect(row.textContent).toContain("累计 74%");
    full.unmount();

    // 本轮与累计读写全为 0 时不渲染缓存行
    vi.spyOn(api, "context").mockResolvedValue(contextViewWithUsage({ inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 }));
    sessionMeta.setUsage(session.id, { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 });
    const zero = renderWithClient(<ContextPanel sessionId={session.id} running={false} />);
    await zero.findByText("上下文窗口");
    expect(zero.queryByTestId("ctx-cache")).toBeNull();
    zero.unmount();
    sessionStore.set({ watermarks: {}, usages: {} });

    // 无本轮事件但累计有缓存活动时只显示累计行
    setWatermark(windowUsage);
    vi.spyOn(api, "context").mockResolvedValue(contextViewWithUsage({ inputTokens: 26_000, outputTokens: 100, cacheRead: 74_000, cacheWrite: 8_000 }));
    const cumulativeOnly = renderWithClient(<ContextPanel sessionId={session.id} running={false} />);
    const onlyRow = await cumulativeOnly.findByTestId("ctx-cache");
    expect(onlyRow.textContent).not.toContain("本轮");
    expect(onlyRow.textContent).toContain("累计 74%");
  });
});

describe("ContextPanel 空态", () => {
  it("sessionId 为 undefined 时显示引导空态", () => {
    renderWithClient(<ContextPanel running={false} />);
    expect(screen.getByText("选择会话以查看上下文。")).toBeInTheDocument();
  });
});

describe("ContextPanel context-saver 扩展门控", () => {
  it("context-saver 扩展门控：开启渲染 saver 段落、关闭保留压缩区", async () => {
    // 扩展开启时渲染驱逐策略、选择性上下文与上下文条目，压缩区同在
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    const enabled = renderWithClient(<ContextPanel sessionId={session.id} running={false} />);

    expect(await enabled.findByText("驱逐策略")).toBeInTheDocument();
    expect(enabled.getByText(/选择性上下文/)).toBeInTheDocument();
    expect(enabled.getByText("上下文条目")).toBeInTheDocument();
    // 手动压缩是核心能力，不随扩展开关
    expect(enabled.getByText("压缩")).toBeInTheDocument();
    expect(enabled.getByRole("button", { name: "压缩工具调用" })).toBeInTheDocument();
    enabled.unmount();

    // 扩展关闭时不渲染 saver 段落，但压缩区保留
    vi.spyOn(api, "extensions").mockResolvedValue([saverExtension(false)]);
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    const disabled = renderWithClient(<ContextPanel sessionId={session.id} running={false} />);

    // 等核心段落就绪后再断言 saver 段落默认
    expect(await disabled.findByText("压缩")).toBeInTheDocument();
    expect(disabled.getByRole("button", { name: "压缩工具调用" })).toBeInTheDocument();
    expect(disabled.getByRole("button", { name: "概览压缩" })).toBeInTheDocument();
    expect(disabled.queryByText("驱逐策略")).toBeNull();
    expect(disabled.queryByText(/选择性上下文/)).toBeNull();
    expect(disabled.queryByText("上下文条目")).toBeNull();
  });
});

describe("ContextPanel 手动压缩反馈", () => {
  it.each([
    ["压缩工具调用", "概览压缩", { changed: true, mode: "toolcalls" }],
    ["概览压缩", "压缩工具调用", { changed: false, mode: "overview", reason: "无区段可压缩" }],
  ] as const)("点击「%s」后按钮进入压缩中并禁用，完成后恢复", async (buttonName, otherButtonName, result) => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    let resolveCompact!: (v: { changed: boolean; mode: string; reason?: string }) => void;
    vi.spyOn(api, "compactContext").mockReturnValue(new Promise((r) => { resolveCompact = r; }));

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: buttonName }));

    // 被点击按钮改名「压缩中…」，另一按钮保持原名且禁用
    expect(await screen.findByRole("button", { name: "压缩中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: otherButtonName })).toBeDisabled();

    resolveCompact(result);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "压缩工具调用" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "概览压缩" })).toBeEnabled();
    });
  });
});

describe("ContextPanel 驱逐读数", () => {
  it("stats.evicted 存在时渲染已驱逐行（含条数与召回说明），默认时不渲染", async () => {
    const view = contextView({ pins: [], excludes: [] });
    view.stats = { ...view.stats!, evicted: { tokens: 12_400, count: 8 } };
    vi.spyOn(api, "context").mockResolvedValue(view);
    renderPanel();
    const row = await screen.findByTestId("ctx-evicted");
    expect(row.textContent).toContain("已驱逐 12,400 tokens（8 条工具结果）");
    expect(row.getAttribute("title")).toContain("read_artifact");
    // 默认（无驱逐条目/旧 server）不渲染
    cleanup();
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: [] }));
    renderPanel();
    await screen.findByText(/上下文窗口|Context window/);
    expect(screen.queryByTestId("ctx-evicted")).toBeNull();
  });
});

const model: ModelProfile = {
  id: "test-model",
  provider: "test",
  contextWindow: 128_000,
  capabilities: { thinking: ["disabled"], effort: ["low"], modalities: ["text"], imageOutput: false, tools: true },
};

const stats: ContextBuildStats = {
  totalTokens: 48_000,
  segments: { system: 2_000, input: 24_000, toolCalls: 20_000, output: 0, other: 2_000 },
  pinnedTokens: 500,
  buildMs: 1.2,
  incremental: true,
};

const watermark: ContextWatermark = {
  estimatedTokens: 45_000,
  contextWindow: 128_000,
  workingBudget: 120_000,
  utilization: 0.375,
  segments: stats.segments,
  pinnedTokens: 500,
  buildMs: 0.8,
  incremental: true,
};

describe("deriveWindowInfo", () => {
  it("deriveWindowInfo：水位优先/stats 播种/窗口未知仅 tokens/全缺失 undefined", () => {
    // 优先使用 WS 实时水位
    const live = deriveWindowInfo(watermark, stats, model);
    expect(live?.estimatedTokens).toBe(45_000);
    expect(live?.contextWindow).toBe(128_000);
    expect(live?.utilization).toBeCloseTo(0.375);

    // 无水位时由 REST stats + 模型档案播种（workingBudget = 上下文窗口）
    const seeded = deriveWindowInfo(undefined, stats, model);
    expect(seeded?.estimatedTokens).toBe(48_000);
    expect(seeded?.contextWindow).toBe(128_000);
    expect(seeded?.workingBudget).toBe(128_000);
    expect(seeded?.utilization).toBeCloseTo(0.375);
    expect(seeded?.pinnedTokens).toBe(500);

    // 模型窗口未知时仅返回 tokens，不给百分比
    const partial = deriveWindowInfo(undefined, stats, undefined);
    expect(partial?.estimatedTokens).toBe(48_000);
    expect(partial?.contextWindow).toBeUndefined();
    expect(partial?.utilization).toBeUndefined();

    // 水位与 stats 都缺失时返回 undefined
    expect(deriveWindowInfo(undefined, undefined, model)).toBeUndefined();
  });
});

describe("windowLevel", () => {
  it("windowLevel：0.7/0.85 默认档与自定义阈值精确边界", () => {
    // 默认档
    expect(windowLevel(undefined)).toBe("normal");
    expect(windowLevel(0.35)).toBe("normal");
    expect(windowLevel(0.7)).toBe("warn");
    expect(windowLevel(0.84)).toBe("warn");
    expect(windowLevel(0.85)).toBe("danger");
    expect(windowLevel(1.1)).toBe("danger");

    // 默认阈值参数与旧硬编码 0.85/0.7 行为一致
    for (const utilization of [0.54, 0.7, 0.8499, 0.85, 1]) {
      expect(windowLevel(utilization)).toBe(windowLevel(utilization, 85));
    }
    expect(windowLevel(undefined, 70)).toBe("normal");

    // 自定义阈值：danger = threshold/100，warn = (threshold−15)/100，精确边界
    // threshold = 70 → danger >= 0.70，warn >= 0.55
    expect(windowLevel(0.54, 70)).toBe("normal");
    expect(windowLevel(0.55, 70)).toBe("warn");
    expect(windowLevel(0.68, 70)).toBe("warn");
    expect(windowLevel(0.69, 70)).toBe("warn");
    expect(windowLevel(0.7, 70)).toBe("danger");
    expect(windowLevel(1, 70)).toBe("danger");
    // threshold = 50（下限）→ danger >= 0.50，warn >= 0.35
    expect(windowLevel(0.34, 50)).toBe("normal");
    expect(windowLevel(0.35, 50)).toBe("warn");
    expect(windowLevel(0.5, 50)).toBe("danger");
    // threshold = 95（上限）→ danger >= 0.95，warn >= 0.80
    expect(windowLevel(0.79, 95)).toBe("normal");
    expect(windowLevel(0.8, 95)).toBe("warn");
    expect(windowLevel(0.94, 95)).toBe("warn");
    expect(windowLevel(0.95, 95)).toBe("danger");
  });
});

describe("compactionThresholdPercent", () => {
  function settingsWith(value: unknown): SettingsView {
    return {
      groups: [{
        id: "context",
        label: "上下文与运行",
        fields: [
          { key: "compactionThresholdPercent", label: "自动压缩水位（%）", type: "number", value: value as number, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
        ],
      }],
    };
  }

  it("读取合法字段值（50–100）", () => {
    expect(compactionThresholdPercent(settingsWith(50))).toBe(50);
    expect(compactionThresholdPercent(settingsWith(70))).toBe(70);
    expect(compactionThresholdPercent(settingsWith(100))).toBe(100);
  });

  it("设置缺失/越界回落 85", () => {
    expect(compactionThresholdPercent(undefined)).toBe(85);
    expect(compactionThresholdPercent({ groups: [] })).toBe(85);
    expect(compactionThresholdPercent(settingsWith(undefined))).toBe(85);
    expect(compactionThresholdPercent(settingsWith(null))).toBe(85);
    expect(compactionThresholdPercent(settingsWith(49))).toBe(85);
    expect(compactionThresholdPercent(settingsWith(101))).toBe(85);
    expect(compactionThresholdPercent(settingsWith("70"))).toBe(85);
  });
});
