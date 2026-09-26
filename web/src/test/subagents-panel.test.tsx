import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { SubagentsPanel } from "../panels/SubagentsPanel";
import { live, liveStore } from "../app/live-store";
import { qk } from "../app/queries";
import type { AppEvent, LiveSubagentRun } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";
vi.mock("../lib/api", () => ({ api: { agents: vi.fn(async () => ({ agents: [] })), startSubagent: vi.fn(), session: vi.fn() } }));
const run = (taskId: string, toolCallId: string, status: LiveSubagentRun["status"], extra: Partial<LiveSubagentRun> = {}): LiveSubagentRun =>
  ({ taskId, toolCallId, prompt: `任务 ${taskId}`, agent: "explore", status, turns: 1, toolsUsed: [], ...extra });
function renderPanel(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(qk.session("s1"), { id: "s1", messages: [], title: "会话一" });
  return renderWithClient(<SubagentsPanel sessionId="s1" />, queryClient);
}
describe("SubagentsPanel 状态过滤", () => {
  beforeEach(() => { liveStore.set({ subagents: {}, hiddenSubagents: {}, spawnedThisRun: {} }); });
  it("默认全部；筛运行中/失败只留对应条目，选项带总数；子代理事件驱动列表更新", () => {
    liveStore.set({ subagents: { s1: Object.fromEntries([run("t1", "call-1", "running"), run("t2", "call-2", "done"), run("t3", "call-3", "failed", { model: "deepseek-chat" })].map((entry) => [entry.taskId, entry])) } });
    renderPanel();
    const select = screen.getByLabelText("状态") as HTMLSelectElement;
    expect(select.value).toBe("all"); expect(screen.getByRole("option", { name: "全部 3" })).toBeInTheDocument();
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "running" } });
    expect(screen.getByText("任务 t1")).toBeInTheDocument(); expect(screen.queryByText("任务 t2")).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "failed" } });
    expect(screen.getByText("任务 t3")).toBeInTheDocument(); expect(screen.queryByText("任务 t1")).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "all" } });
    act(() => live.applySubagentEvent({ type: "subagent.started", sessionId: "s1", payload: { taskId: "t9", toolCallId: "call-9", prompt: "新任务" } } as unknown as AppEvent));
    expect(screen.getByText("新任务")).toBeInTheDocument();
  });
  it("被清批/清空的条目不出现；没有运行时只渲染启动器与空态（不渲染筛选项）", () => {
    liveStore.set({
      subagents: { s1: { t1: run("t1", "call-1", "done"), t2: run("t2", "call-2", "done") } },
      hiddenSubagents: { s1: { t1: true, "call-1": true } },
    });
    renderPanel();
    expect(screen.getByText("任务 t2")).toBeInTheDocument(); expect(screen.queryByText("任务 t1")).not.toBeInTheDocument();
    liveStore.set({ subagents: {}, hiddenSubagents: {} });
    const empty = renderPanel();
    expect(empty.queryByLabelText("状态")).toBeNull();
    expect(within(empty.container).getByText(/还没有子代理运行记录/)).toBeInTheDocument();
  });
});
