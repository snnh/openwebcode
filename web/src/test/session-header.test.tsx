import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { SessionDetail } from "../lib/contracts";
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
