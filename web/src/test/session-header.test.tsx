import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { SessionDetail } from "../lib/contracts";
import { api } from "../lib/api";
import type { ContextWindowInfo } from "../lib/context-window";
import { SessionHeader } from "../workbench/SessionHeader";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "s1",
    title: "重构登录模块",
    cwd: "D:/work/demo",
    provider: "anthropic",
    model: "claude-opus",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messages: [],
    ...overrides,
  };
}

const SEGMENTS = { system: 0, compactionSummary: 0, toolResults: 0, messages: 0, repoMap: 0, other: 0 };

function renderHeader(props: Partial<Parameters<typeof SessionHeader>[0]> = {}): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <SessionHeader
        session={makeSession()}
        running={false}
        onAbort={noop}
        onConfig={noop}
        onCreateCheckpoint={noop}
        {...props}
      />
    </QueryClientProvider>
  );
  return render(element);
}

const noop = (): void => undefined;

describe("SessionHeader", () => {
  it("渲染标题与 cwd", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "重构登录模块" })).toBeInTheDocument();
    expect(screen.getByText("D:/work/demo")).toBeInTheDocument();
  });

  it("运行状态徽章：busy 态展示状态文案", () => {
    renderHeader({ agentState: "streaming" });
    expect(screen.getByText("正在输出")).toBeInTheDocument();
  });

  it("成本摘要：tokens 与成本文案 + 预算条", () => {
    const { container } = renderHeader({
      costSummary: { tokens: 1200, costLabel: "$0.05", tokenBudget: 2400, paused: false },
    });
    expect(container.querySelector(".cost-summary")?.textContent).toContain("$0.05");
    expect(container.querySelector(".budget-bar")).not.toBeNull();
  });

  it("上下文水位 meter：显示已用/窗口与百分比", () => {
    const windowUsage: ContextWindowInfo = {
      estimatedTokens: 40_000,
      contextWindow: 200_000,
      utilization: 0.2,
      segments: SEGMENTS,
      pinnedTokens: 0,
    };
    renderHeader({ windowUsage });
    const meter = screen.getByTestId("window-usage");
    expect(meter.textContent).toContain("20%");
    expect(meter.getAttribute("data-level")).toBe("normal");
  });

  it("busy 时渲染中断按钮并回调 onAbort；空闲时不渲染", () => {
    const onAbort = vi.fn();
    renderHeader({ agentState: "executing_tools", onAbort });
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("空闲时不渲染中断按钮", () => {
    renderHeader({ agentState: "idle" });
    expect(screen.queryByRole("button", { name: "中断" })).toBeNull();
  });

  it("托管工作区渲染手动快照按钮并回调 onCreateCheckpoint", () => {
    const onCreateCheckpoint = vi.fn();
    renderHeader({
      session: makeSession({ workspace: { mode: "managed", backend: "vhdx", originCwd: "D:/work/demo", image: "D:/img.vhdx", mountPoint: "D:/mnt" } }),
      onCreateCheckpoint,
    });
    fireEvent.click(screen.getByRole("button", { name: "创建虚拟磁盘快照" }));
    expect(onCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("非托管工作区不渲染手动快照按钮", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "创建虚拟磁盘快照" })).toBeNull();
  });

  it("配置切换经 onConfig 下发（沙盒模式下拉）", () => {
    const onConfig = vi.fn();
    renderHeader({ onConfig });
    fireEvent.change(screen.getByLabelText("沙盒模式"), { target: { value: "appcontainer" } });
    expect(onConfig).toHaveBeenCalledWith({ sandboxMode: "appcontainer" });
  });
});

describe("后台任务弹层", () => {
  function makeTask(overrides: Partial<import("../lib/contracts").BackgroundTaskInfo>): import("../lib/contracts").BackgroundTaskInfo {
    return {
      taskId: "t1",
      status: "running",
      cmd: "npm test",
      startedAt: "2026-08-01T00:00:00.000Z",
      ...overrides,
    } as import("../lib/contracts").BackgroundTaskInfo;
  }

  it("运行中在前（startedAt 升序）、已结束后随（finishedAt 降序）且带耗时", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue([
      makeTask({ taskId: "settled-new", status: "done", startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:05:00.000Z" }),
      makeTask({ taskId: "run-late", startedAt: "2026-08-01T00:02:00.000Z" }),
      makeTask({ taskId: "settled-old", status: "failed", startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z", exitCode: 1 }),
      makeTask({ taskId: "run-early", startedAt: "2026-08-01T00:01:00.000Z" }),
    ]);
    renderHeader();
    const trigger = await screen.findByRole("button", { name: /^任务 \d+$/ });
    fireEvent.click(trigger);
    const ids = Array.from(document.querySelectorAll(".task-dropdown .task-id")).map((el) => el.textContent);
    expect(ids).toEqual(["run-early", "run-late", "settled-new", "settled-old"]);
    expect(document.querySelectorAll(".task-dropdown .task-elapsed")).toHaveLength(4);
    // 已结束任务弱化（CSS 类标识），exit code 保留
    expect(document.querySelectorAll(".task-item:not(.task-running)")).toHaveLength(2);
  });

  it("运行中耗时每秒走动（interval 在弹层打开且有活任务时运行）", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue([
      makeTask({ taskId: "t-run", startedAt: new Date(Date.now() - 3000).toISOString() }),
    ]);
    renderHeader();
    const trigger = await screen.findByRole("button", { name: /^任务 \d+$/ });
    // 计时 interval 在弹层打开时创建：须先于点击启用假时钟，否则 interval 属真实时钟无法推进
    vi.useFakeTimers();
    try {
      fireEvent.click(trigger);
      const before = document.querySelector(".task-elapsed")!.textContent;
      expect(before).toMatch(/^\d+s$/);
      await act(async () => { vi.advanceTimersByTime(2100); });
      const after = document.querySelector(".task-elapsed")!.textContent;
      expect(Number.parseInt(before!, 10) + 2).toBe(Number.parseInt(after!, 10));
    } finally {
      vi.useRealTimers();
    }
  });

  it("Esc 与外部按下关闭弹层并还焦触发按钮", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue([makeTask({ taskId: "t-run" })]);
    renderHeader();
    const trigger = await screen.findByRole("button", { name: /^任务 \d+$/ });
    fireEvent.click(trigger);
    expect(document.querySelector(".task-dropdown")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".task-dropdown")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(document.querySelector(".task-dropdown")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
