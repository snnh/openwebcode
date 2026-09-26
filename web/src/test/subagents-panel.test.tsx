import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubagentsPanel } from "../panels/SubagentsPanel";
import { live, liveStore } from "../app/live-store";
import { qk } from "../app/queries";
import type { AppEvent, LiveSubagentRun } from "../lib/contracts";

vi.mock("../lib/api", () => ({
  api: {
    agents: vi.fn(async () => ({ agents: [] })),
    startSubagent: vi.fn(),
    session: vi.fn(),
  },
}));

function run(taskId: string, toolCallId: string, status: LiveSubagentRun["status"], extra: Partial<LiveSubagentRun> = {}): LiveSubagentRun {
  return { taskId, toolCallId, prompt: `任务 ${taskId}`, agent: "explore", status, turns: 1, toolsUsed: [], ...extra };
}

function seed(runs: LiveSubagentRun[]): void {
  liveStore.set({ subagents: { s1: Object.fromEntries(runs.map((entry) => [entry.taskId, entry])) }, hiddenSubagents: {}, spawnedThisRun: {} });
}

function renderPanel(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(qk.session("s1"), { id: "s1", messages: [], title: "会话一" });
  return render(
    <QueryClientProvider client={queryClient}>
      <SubagentsPanel sessionId="s1" />
    </QueryClientProvider>,
  );
}

describe("SubagentsPanel 状态过滤", () => {
  beforeEach(() => {
    seed([]);
    liveStore.set({ subagents: {}, hiddenSubagents: {}, spawnedThisRun: {} });
  });

  it("默认全部；筛运行中/完成/失败只留对应条目，选项带总数", () => {
    // 每次 spawn 调用一个 toolCallId（非 swarm 组内只有一条运行）
    seed([run("t1", "call-1", "running"), run("t2", "call-2", "done"), run("t3", "call-3", "failed", { model: "deepseek-chat" })]);
    const { container } = renderPanel();
    const select = screen.getByLabelText("状态") as HTMLSelectElement;
    expect(select.value).toBe("all");
    expect(screen.getByRole("option", { name: "全部 3" })).toBeInTheDocument();
    expect(container.querySelectorAll(".subagent-run-item")).toHaveLength(3);
    // 实际生效模型在行上可见
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "running" } });
    expect(container.querySelectorAll(".subagent-run-item")).toHaveLength(1);
    expect(screen.getByText("任务 t1")).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "failed" } });
    expect(container.querySelectorAll(".subagent-run-item")).toHaveLength(1);
    expect(screen.getByText("任务 t3")).toBeInTheDocument();
  });

  it("被清批/清空的条目不出现在面板里（实时与消息推导条目一起过滤）", () => {
    seed([run("t1", "call-1", "done"), run("t2", "call-2", "done")]);
    liveStore.set((previous) => ({ hiddenSubagents: { s1: { t1: true, "call-1": true } } , subagents: previous.subagents }));
    const { container } = renderPanel();
    expect(container.querySelectorAll(".subagent-run-item")).toHaveLength(1);
    expect(screen.getByText("任务 t2")).toBeInTheDocument();
  });

  it("没有运行时只渲染启动器与空态（不渲染筛选项）", () => {
    renderPanel();
    expect(screen.queryByLabelText("状态")).toBeNull();
    expect(screen.getByText(/还没有子代理运行记录/)).toBeInTheDocument();
  });

  it("子代理事件驱动列表更新", () => {
    renderPanel();
    act(() => live.applySubagentEvent({ type: "subagent.started", sessionId: "s1", payload: { taskId: "t9", toolCallId: "call-9", prompt: "新任务" } } as unknown as AppEvent));
    expect(screen.getByText("新任务")).toBeInTheDocument();
  });
});
