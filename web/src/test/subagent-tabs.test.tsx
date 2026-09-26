import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { conclusionExcerpt } from "../chat/SubagentRunCard";
import { SubagentTabStrip, SubagentTabView, subagentTabText } from "../chat/SubagentTabs";
import { useSubagentTabs, type SubagentTab } from "../hooks/use-subagent-tabs";
import type { LiveSubagentRun, SubagentStartedEvent } from "../lib/contracts";

vi.mock("../lib/api", () => ({
  api: {
    subagentTranscript: vi.fn(async (_sessionId: string, taskId: string) => ({
      id: taskId,
      prompt: `任务 ${taskId}`,
      agent: "explore",
      startedAt: "2026-08-01T00:00:00.000Z",
      turns: 3,
      toolsUsed: ["read"],
      conclusion: "## 结论\n第一行结论\n第二行细节\n第三行不该显示",
      messages: [],
    })),
  },
}));

const t = (chinese: string): string => chinese;

function tab(overrides: Partial<SubagentTab> & { toolCallId: string; seq: number }): SubagentTab {
  return { prompt: "审查 a.ts", ...overrides };
}

function liveRun(overrides: Partial<LiveSubagentRun> & { taskId: string; toolCallId: string }): LiveSubagentRun {
  return { prompt: "审查 a.ts", status: "running", turns: 1, toolsUsed: [], ...overrides };
}

function renderWithQuery(element: React.ReactElement): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

describe("subagentTabText：标签命名", () => {
  it("序号 · 代理名 · 任务摘要（不挤模型名）", () => {
    expect(subagentTabText(tab({ toolCallId: "c1", seq: 2, agent: "explore", prompt: "排查 web 面板性能问题并给出方案" }), t))
      .toBe("#2 explore · 排查 web 面板性能问…");
  });

  it("swarm 标签显示项数；缺代理名时退化为序号 + 摘要", () => {
    expect(subagentTabText(tab({ toolCallId: "c2", seq: 3, swarmTotal: 4 }), t)).toBe("#3 Swarm 4 项");
    expect(subagentTabText(tab({ toolCallId: "c3", seq: 5, prompt: "扫描仓库" }), t)).toBe("#5 扫描仓库");
  });
});

describe("conclusionExcerpt：结论摘录", () => {
  it("压平空白并按长度截断（多行结论在行上只占一两行）", () => {
    expect(conclusionExcerpt("## 结论\n\n第一行\n第二行")).toBe("## 结论 第一行 第二行");
    expect(conclusionExcerpt("x".repeat(200))).toBe(`${"x".repeat(160)}…`);
  });
});

describe("SubagentTabStrip", () => {
  const tabs = [
    tab({ toolCallId: "call-1", seq: 1, agent: "explore" }),
    tab({ toolCallId: "call-2", seq: 2, agent: "explore", prompt: "改 tsconfig" }),
  ];
  const runs: Record<string, LiveSubagentRun> = {
    t1: liveRun({ taskId: "t1", toolCallId: "call-1" }),
    t2: liveRun({ taskId: "t2", toolCallId: "call-2", status: "done" }),
  };

  it("标签用序号 + 代理名 + 摘要命名，选中项标记 aria-selected", () => {
    render(<SubagentTabStrip tabs={tabs} runs={runs} selected="call-2" onSelect={() => undefined} onClose={() => undefined} />);
    expect(screen.getByRole("tab", { name: /#1 explore · 审查 a.ts/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /#2 explore · 改 tsconfig/ })).toHaveAttribute("aria-selected", "true");
  });

  it("「全部」下拉列全所有标签（含状态），点击即跳转并关闭下拉", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SubagentTabStrip tabs={tabs} runs={runs} selected={undefined} onSelect={onSelect} onClose={() => undefined} />,
    );
    const all = container.querySelector(".subagent-tab-all")!;
    // 只取跳转项（关闭按钮的 accessible name 以「关闭标签」开头）
    const items = within(all as HTMLElement).getAllByRole("button", { name: /^#\d/ });
    expect(items.map((item) => item.textContent)).toEqual(["#1 explore · 审查 a.ts", "#2 explore · 改 tsconfig"]);
    // 下拉放在横向滚动容器之外，否则绝对定位菜单会被 overflow 裁掉
    expect(container.querySelector(".subagent-tabs .subagent-tab-all")).toBeNull();
    fireEvent.click(items[1]!);
    expect(onSelect).toHaveBeenCalledWith("call-2");
  });

  it("关闭标签只影响视图（回调带 toolCallId）", () => {
    const onClose = vi.fn();
    render(<SubagentTabStrip tabs={tabs} runs={runs} selected={undefined} onSelect={() => undefined} onClose={onClose} />);
    // 标签内与「全部」下拉各有一个关闭按钮（同名），取标签条上的那个
    fireEvent.click(screen.getAllByRole("button", { name: "关闭标签 #2 explore · 改 tsconfig" })[0]!);
    expect(onClose).toHaveBeenCalledWith("call-2");
  });
});

describe("SubagentTabView", () => {
  it("组头显示完成/失败/运行中统计与实际生效模型", () => {
    const runs: Record<string, LiveSubagentRun> = {
      t1: liveRun({ taskId: "t1", toolCallId: "call-1", status: "done", model: "deepseek-chat" }),
      t2: liveRun({ taskId: "t2", toolCallId: "call-1", status: "failed", model: "deepseek-chat" }),
    };
    const { container } = renderWithQuery(<SubagentTabView sessionId="s1" toolCallId="call-1" runs={runs} />);
    const header = container.querySelector(".subagents-group-header")!;
    expect(header.textContent).toContain("完成 1 / 失败 1 / 运行中 0");
    expect(within(header as HTMLElement).getByTitle("deepseek-chat")).toBeInTheDocument();
    // 模型去重：两个条目只显示一次
    expect(container.querySelectorAll(".subagents-group-header .subagent-run-model")).toHaveLength(1);
  });

  it("终态行默认显示结论摘要 + 复制结论（无需展开转录）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const runs: Record<string, LiveSubagentRun> = {
      t1: liveRun({ taskId: "t1", toolCallId: "call-1", status: "done", model: "deepseek-chat" }),
    };
    const { container } = renderWithQuery(<SubagentTabView sessionId="s1" toolCallId="call-1" runs={runs} />);

    await waitFor(() => expect(container.querySelector(".subagent-transcript-summary-text")).not.toBeNull());
    // 摘要只取首 1–2 行（压平空白 + 截断），第三行不出现
    expect(container.querySelector(".subagent-transcript-summary-text")!.textContent).toBe("## 结论 第一行结论 第二行细节 第三行不该显示");
    const copy = screen.getByRole("button", { name: "复制结论" });
    fireEvent.click(copy);
    await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("## 结论\n第一行结论\n第二行细节\n第三行不该显示");
  });

  it("运行中的行不显示结论摘要（只有终态才回顾）", () => {
    const runs: Record<string, LiveSubagentRun> = {
      t1: liveRun({ taskId: "t1", toolCallId: "call-1", status: "running" }),
    };
    const { container } = renderWithQuery(<SubagentTabView sessionId="s1" toolCallId="call-1" runs={runs} />);
    expect(container.querySelector(".subagent-transcript-summary")).toBeNull();
    expect(container.querySelector(".subagent-run-model")).toBeNull();
  });
});

describe("useSubagentTabs：序号分配", () => {
  const started = (toolCallId: string, agent = "explore"): SubagentStartedEvent =>
    ({ toolCallId, taskId: `task-${toolCallId}`, prompt: "任务", agent });

  it("按发生顺序分配 #序号，关闭后重新打开沿用原序号（不复用也不回退）", () => {
    const { result } = renderHook(() => useSubagentTabs());
    act(() => result.current.openFromStarted("s1", started("call-1")));
    act(() => result.current.openFromStarted("s1", started("call-2")));
    expect(result.current.tabsBySession.s1!.map((tab) => [tab.toolCallId, tab.seq])).toEqual([["call-1", 1], ["call-2", 2]]);

    // 关闭 #1 后手动重新打开：沿用 1（不重新发号，界面上的序号与历史说法保持一致）
    act(() => result.current.closeTab("s1", "call-1"));
    act(() => result.current.openTab("s1", { toolCallId: "call-1", prompt: "任务", agent: "explore" }));
    expect(result.current.tabsBySession.s1!.map((tab) => [tab.toolCallId, tab.seq])).toEqual([["call-2", 2], ["call-1", 1]]);

    // 新标签继续递增
    act(() => result.current.openFromStarted("s1", started("call-3")));
    expect(result.current.tabsBySession.s1!.find((tab) => tab.toolCallId === "call-3")!.seq).toBe(3);
  });

  it("序号按会话隔离", () => {
    const { result } = renderHook(() => useSubagentTabs());
    act(() => result.current.openFromStarted("s1", started("call-1")));
    act(() => result.current.openFromStarted("s2", started("call-2")));
    expect(result.current.tabsBySession.s1![0]!.seq).toBe(1);
    expect(result.current.tabsBySession.s2![0]!.seq).toBe(1);
  });
});
