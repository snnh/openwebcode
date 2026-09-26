import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { conclusionExcerpt } from "../chat/SubagentRunCard";
import { SubagentTabStrip, SubagentTabView, subagentTabText } from "../chat/SubagentTabs";
import { useSubagentTabs, type SubagentTab } from "../hooks/use-subagent-tabs";
import type { LiveSubagentRun, SubagentStartedEvent } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";
vi.mock("../lib/api", () => ({
  api: { subagentTranscript: vi.fn(async (_sessionId: string, taskId: string) => ({
    id: taskId, prompt: `任务 ${taskId}`, agent: "explore", startedAt: "2026-08-01T00:00:00.000Z", turns: 3, toolsUsed: ["read"],
    conclusion: "## 结论\n第一行结论\n第二行细节\n第三行不该显示", messages: [] })) },
}));
const t = (chinese: string): string => chinese; const tab = (overrides: Partial<SubagentTab> & { toolCallId: string; seq: number }): SubagentTab => ({ prompt: "审查 a.ts", ...overrides });
const liveRun = (overrides: Partial<LiveSubagentRun> & { taskId: string; toolCallId: string }): LiveSubagentRun =>
  ({ prompt: "审查 a.ts", status: "running", turns: 1, toolsUsed: [], ...overrides });
describe("标签命名与结论摘录", () => {
  it("标签为「序号 · 代理名 · 任务摘要」、swarm 显示项数、缺代理名退化为序号 + 摘要；结论摘录压平空白并截断", () => {
    expect(subagentTabText(tab({ toolCallId: "c1", seq: 2, agent: "explore", prompt: "排查 web 面板性能问题并给出方案" }), t)).toBe("#2 explore · 排查 web 面板性能问…");
    expect(subagentTabText(tab({ toolCallId: "c2", seq: 3, swarmTotal: 4 }), t)).toBe("#3 Swarm 4 项");
    expect(subagentTabText(tab({ toolCallId: "c3", seq: 5, prompt: "扫描仓库" }), t)).toBe("#5 扫描仓库");
    expect(conclusionExcerpt("## 结论\n\n第一行\n第二行")).toBe("## 结论 第一行 第二行");
    expect(conclusionExcerpt("x".repeat(200))).toBe(`${"x".repeat(160)}…`);
  });
});
describe("SubagentTabStrip", () => {
  const tabs = [tab({ toolCallId: "call-1", seq: 1, agent: "explore" }), tab({ toolCallId: "call-2", seq: 2, agent: "explore", prompt: "改 tsconfig" })];
  const runs: Record<string, LiveSubagentRun> = { t1: liveRun({ taskId: "t1", toolCallId: "call-1" }), t2: liveRun({ taskId: "t2", toolCallId: "call-2", status: "done" }) };
  it("选中态标记、全部下拉跳转、关闭回调", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<SubagentTabStrip tabs={tabs} runs={runs} selected="call-2" onSelect={onSelect} onClose={onClose} />);
    expect(screen.getByRole("tab", { name: /#1 explore · 审查 a.ts/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /#2 explore · 改 tsconfig/ })).toHaveAttribute("aria-selected", "true");
    // 下拉只取跳转项，且放在横向滚动容器之外（否则绝对定位菜单会被 overflow 裁掉）
    const all = within(container.querySelector(".subagent-tab-all") as HTMLElement);
    const items = all.getAllByRole("button", { name: /^#\d/ });
    expect(items.map((item) => item.textContent)).toEqual(["#1 explore · 审查 a.ts", "#2 explore · 改 tsconfig"]);
    expect(container.querySelector(".subagent-tabs .subagent-tab-all")).toBeNull();
    fireEvent.click(items[1]!); expect(onSelect).toHaveBeenCalledWith("call-2");
    fireEvent.click(screen.getAllByRole("button", { name: "关闭标签 #2 explore · 改 tsconfig" })[0]!); expect(onClose).toHaveBeenCalledWith("call-2");
  });
});
describe("SubagentTabView", () => {
  it("组头显示完成/失败/运行中统计与生效模型（去重）；终态行显示结论摘要并可复制结论，运行中的行不显示摘要", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const runs: Record<string, LiveSubagentRun> = {
      t1: liveRun({ taskId: "t1", toolCallId: "call-1", status: "done", model: "deepseek-chat" }),
      t2: liveRun({ taskId: "t2", toolCallId: "call-1", status: "failed", model: "deepseek-chat" }),
    };
    const { container } = renderWithClient(<SubagentTabView sessionId="s1" toolCallId="call-1" runs={runs} />);
    const header = container.querySelector(".subagents-group-header") as HTMLElement;
    expect(header.textContent).toContain("完成 1 / 失败 1 / 运行中 0"); expect(within(header).getByTitle("deepseek-chat")).toBeInTheDocument();
    cleanup();
    const done = renderWithClient(<SubagentTabView sessionId="s1" toolCallId="call-1" runs={{ t1: liveRun({ taskId: "t1", toolCallId: "call-1", status: "done", model: "deepseek-chat" }) }} />);
    await waitFor(() => expect(done.container.querySelector(".subagent-transcript-summary-text")).not.toBeNull());
    expect(done.container.querySelector(".subagent-transcript-summary-text")!.textContent).toBe("## 结论 第一行结论 第二行细节 第三行不该显示");
    fireEvent.click(screen.getByRole("button", { name: "复制结论" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("## 结论\n第一行结论\n第二行细节\n第三行不该显示");
    cleanup();
    const running = renderWithClient(<SubagentTabView sessionId="s1" toolCallId="call-1" runs={{ t1: liveRun({ taskId: "t1", toolCallId: "call-1", status: "running" }) }} />);
    expect(running.container.querySelector(".subagent-transcript-summary")).toBeNull();
  });
});
describe("useSubagentTabs：序号分配", () => {
  const started = (toolCallId: string): SubagentStartedEvent => ({ toolCallId, taskId: `task-${toolCallId}`, prompt: "任务", agent: "explore" });
  it("按发生顺序分配 #序号；关闭后重开沿用原序号；序号按会话隔离", () => {
    const { result } = renderHook(() => useSubagentTabs());
    act(() => result.current.openFromStarted("s1", started("call-1"))); act(() => result.current.openFromStarted("s1", started("call-2")));
    expect(result.current.tabsBySession.s1!.map((item) => [item.toolCallId, item.seq])).toEqual([["call-1", 1], ["call-2", 2]]);
    act(() => result.current.closeTab("s1", "call-1")); act(() => result.current.openTab("s1", { toolCallId: "call-1", prompt: "任务", agent: "explore" }));
    expect(result.current.tabsBySession.s1!.map((item) => [item.toolCallId, item.seq])).toEqual([["call-2", 2], ["call-1", 1]]);
    act(() => result.current.openFromStarted("s1", started("call-3")));
    expect(result.current.tabsBySession.s1!.find((item) => item.toolCallId === "call-3")!.seq).toBe(3);
    act(() => result.current.openFromStarted("s2", started("call-9"))); expect(result.current.tabsBySession.s2![0]!.seq).toBe(1);
  });
});
