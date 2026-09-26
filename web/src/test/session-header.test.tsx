import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BackgroundTaskInfo, SessionDetail } from "../lib/contracts";
import { api } from "../lib/api";
import { SessionHeader } from "../workbench/SessionHeader";
import { makeSession } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";
const noop = (): void => undefined;
const session = (overrides: Partial<SessionDetail> = {}): SessionDetail =>
  makeSession({ title: "重构登录模块", cwd: "D:/work/demo", provider: "anthropic", model: "claude-opus", ...overrides });
function renderHeader(props: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
  return renderWithClient(<SessionHeader session={session()} running={false} onAbort={noop} onConfig={noop} onCreateCheckpoint={noop} {...props} />);
}
const makeTask = (overrides: Partial<BackgroundTaskInfo>): BackgroundTaskInfo =>
  ({ taskId: "t1", status: "running", cmd: "npm test", startedAt: "2026-08-01T00:00:00.000Z", ...overrides }) as BackgroundTaskInfo;
const contextWith = (usage: Record<string, number>, unpricedTokens = 0) => ({
  preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" },
  ledger: { usage, cost: { usdMicroUnits: "1000000", cnyMicroUnits: "7200000", unpricedTokens }, policy: {}, entries: [] },
});
afterEach(() => vi.restoreAllMocks());
describe("SessionHeader 基础信息与运行态", () => {
  it("渲染标题、cwd 与 busy 状态文案；上下文水位 meter 显示已用百分比档位；成本摘要显示成本文案，未定价 tokens 以 * 标注并在 title 注明", () => {
    const { container } = renderHeader({
      agentState: "streaming",
      windowUsage: { estimatedTokens: 40_000, contextWindow: 200_000, utilization: 0.2, pinnedTokens: 0, segments: { system: 0, input: 0, toolCalls: 0, output: 0, other: 0 } },
      costSummary: { tokens: 1200, costLabel: "$0.05", tokenBudget: 2400, paused: false },
    });
    expect(screen.getByRole("heading", { name: "重构登录模块" })).toBeInTheDocument();
    expect(screen.getByText("D:/work/demo")).toBeInTheDocument(); expect(screen.getByText("正在输出")).toBeInTheDocument();
    const meter = screen.getByTestId("window-usage");
    expect(meter.textContent).toContain("20%"); expect(meter.getAttribute("data-level")).toBe("normal");
    expect(container.querySelector(".cost-summary")?.textContent).toContain("$0.05");
    cleanup();
    vi.spyOn(api, "context").mockResolvedValue(contextWith({ inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 }, 3_000) as never);
    const { container: unpriced } = renderHeader({ costSummary: { tokens: 150, costLabel: "¥0.01", paused: false, unpricedTokens: 3_000 } });
    expect(unpriced.querySelector(".cost-summary")?.textContent).toContain("¥0.01 *");
    expect(unpriced.querySelector(".cost-summary")?.getAttribute("title")).toContain("未定价");
  });
  it("中断按钮仅 busy 渲染并可回调；手动快照按钮仅托管工作区渲染；配置切换经 onConfig 下发", () => {
    const onAbort = vi.fn();
    const onConfig = vi.fn();
    renderHeader({ agentState: "executing_tools", onAbort, onConfig });
    fireEvent.click(screen.getByRole("button", { name: "中断" })); expect(onAbort).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("沙盒模式"), { target: { value: "jobobject" } }); expect(onConfig).toHaveBeenCalledWith({ sandboxMode: "jobobject" });
    cleanup();
    renderHeader({ agentState: "idle" });
    expect(screen.queryByRole("button", { name: "中断" })).toBeNull(); expect(screen.queryByRole("button", { name: "创建虚拟磁盘快照" })).toBeNull();
    cleanup();
    const onCreateCheckpoint = vi.fn();
    const managed = session({ workspace: { mode: "managed", backend: "vhdx", originCwd: "D:/work/demo", image: "D:/img.vhdx", mountPoint: "D:/mnt" } });
    renderWithClient(<SessionHeader session={managed} running={false} onAbort={noop} onConfig={noop} onCreateCheckpoint={onCreateCheckpoint} />);
    fireEvent.click(screen.getByRole("button", { name: "创建虚拟磁盘快照" })); expect(onCreateCheckpoint).toHaveBeenCalled();
  });
  it("linux 沙盒模式显示映射（未设置→bubblewrap，存量 jobobject→landlock）；在途 shell 命令冲突确认后以 force:true 重发", async () => {
    const capabilities = { platform: "linux", appcontainer: false, jobobject: true, off: true, wsb: { available: false, reason: "仅 Windows" }, bindLink: { available: false, reason: "仅 Windows" }, bwrap: { available: true } };
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue(capabilities);
    renderHeader();
    await waitFor(() => expect(screen.getByLabelText("沙盒模式")).toHaveValue("bubblewrap"));
    cleanup();
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue(capabilities);
    renderHeader({ session: session({ sandboxMode: "jobobject" }) });
    await waitFor(() => expect(screen.getByLabelText("沙盒模式")).toHaveValue("landlock"));
    cleanup();
    const onConfig = vi.fn().mockRejectedValueOnce(Object.assign(new Error("有 shell 命令在途"), { code: "SHELL_PENDING" })).mockResolvedValue(undefined);
    renderHeader({ onConfig });
    fireEvent.change(screen.getByLabelText("快照模式"), { target: { value: "manual" } });
    const dialog = await screen.findByRole("dialog", { name: "中断 shell 命令" });
    expect(dialog).toHaveTextContent("当前会话有 shell 命令正在执行或等待审批");
    fireEvent.click(within(dialog).getByRole("button", { name: "中断并应用" }));
    await waitFor(() => expect(onConfig).toHaveBeenLastCalledWith({ snapshotMode: "manual", force: true }));
  });
});
describe("SessionHeader 弹层与 pill", () => {
  it("后台任务弹层：运行中在前、已结束后随，耗时可读并逐秒走动；Esc 关闭并还焦", async () => {
    const now = Date.now();
    vi.spyOn(api, "tasks").mockResolvedValue([
      makeTask({ taskId: "settled-new", status: "done", finishedAt: new Date(now - 30_000).toISOString() }),
      makeTask({ taskId: "run-late", startedAt: new Date(now - 10_000).toISOString() }),
      makeTask({ taskId: "settled-old", status: "failed", finishedAt: new Date(now - 120_000).toISOString(), exitCode: 1 }),
      makeTask({ taskId: "run-early", startedAt: new Date(now - 30_000).toISOString() }),
    ]);
    renderHeader();
    const trigger = await screen.findByRole("button", { name: /^任务 \d+$/ });
    // 计时 interval 在弹层打开时创建：须先于点击启用假时钟
    vi.useFakeTimers();
    try {
      fireEvent.click(trigger);
      expect([...document.querySelectorAll(".task-dropdown .task-id")].map((el) => el.textContent)).toEqual(["run-early", "run-late", "settled-new", "settled-old"]);
      const before = document.querySelector(".task-elapsed")!.textContent;
      await act(async () => { vi.advanceTimersByTime(2100); });
      expect(Number.parseInt(before!, 10) + 2).toBe(Number.parseInt(document.querySelector(".task-elapsed")!.textContent!, 10));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(document.querySelector(".task-dropdown")).toBeNull(); expect(document.activeElement).toBe(trigger);
    } finally { vi.useRealTimers(); }
  });
  it("缓存 pill：口径标注 + title 明细 + data-tone 分档（good/bad）", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextWith({ inputTokens: 26_000, outputTokens: 100, cacheRead: 74_000, cacheWrite: 8_000 }) as never);
    renderHeader();
    const pill = await screen.findByTestId("cache-usage");
    expect(pill.textContent).toContain("缓存 74.0%"); expect(pill.textContent).toContain("累计");
    expect(pill.getAttribute("data-tone")).toBe("good"); expect(pill.getAttribute("title")).toContain("低价计费");
    cleanup();
    vi.spyOn(api, "context").mockResolvedValue(contextWith({ inputTokens: 90_000, outputTokens: 100, cacheRead: 10_000, cacheWrite: 0 }) as never);
    renderHeader();
    const low = await screen.findByTestId("cache-usage");
    expect(low.textContent).toContain("缓存 10.0%"); expect(low.getAttribute("data-tone")).toBe("bad");
  });
});
