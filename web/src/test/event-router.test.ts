import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createEventRouter, type EventRouterDeps } from "../app/event-router";
import { sessionMeta, sessionStore } from "../app/session-store";
import { qk } from "../app/queries";
import { deriveWindowInfo } from "../lib/context-window";
import type { AgentRun, AppEvent, ContextBuildStats, ContextWatermark, ModelProfile, Session } from "../lib/contracts";
import type { StreamBuffer } from "../chat/stream-buffer";
import { api } from "../lib/api";
vi.mock("../lib/api", () => ({ api: { run: vi.fn(() => Promise.reject(new Error("no active run"))) } }));
const watermarkFixture: ContextWatermark = { estimatedTokens: 45_000, contextWindow: 128_000, workingBudget: 120_000, utilization: 0.375,
  segments: { system: 2_000, input: 24_000, toolCalls: 20_000, output: 0, other: 2_000 }, pinnedTokens: 500, buildMs: 0.8, incremental: true };
const statsFixture: ContextBuildStats = { totalTokens: 48_000, segments: watermarkFixture.segments, pinnedTokens: 500, buildMs: 1.2, incremental: true };
const modelFixture: ModelProfile = { id: "test-model", provider: "test", contextWindow: 128_000, capabilities: { thinking: ["disabled"], effort: ["low"], modalities: ["text"], imageOutput: false, tools: true } };
const makeEvent = (partial: Partial<AppEvent>): AppEvent => ({ source: "server", type: "agent.state", ...partial }) as AppEvent;
const runSnapshot = (state: AgentRun["state"]): AgentRun =>
  ({ id: "r1", sessionId: "s1", triggerMessageId: "m1", state, turnIndex: 2, startedAt: "2026-08-01T00:00:00.000Z", since: "2026-08-01T00:00:00.000Z" });
function setup(currentSessionId = "s1") {
  const queryClient = new QueryClient();
  const stream = { blocksFor: () => [], subscribe: () => () => {}, queueDelta: vi.fn(), queueToolCallDelta: vi.fn(), flush: vi.fn(), finish: vi.fn(), clear: vi.fn(), discard: vi.fn() } as unknown as StreamBuffer;
  const sessions: Session[] = [{ id: "s1", title: "会话一" } as Session, { id: "s2", title: "会话二" } as Session];
  const deps: EventRouterDeps = {
    queryClient, getCurrentSessionId: () => currentSessionId, getSessions: () => sessions, t: (chinese: string) => chinese,
    notify: vi.fn(), pushEventNotification: vi.fn(), desktopNotify: vi.fn(),
    applyRunEvent: vi.fn(), applyActivityEvent: vi.fn(), applySubagentEvent: vi.fn(), applyCompactionEvent: vi.fn(),
    clearRunningCompaction: vi.fn(), clearSubagentRuns: vi.fn(), stream, onResyncCurrent: vi.fn(),
  };
  const router = createEventRouter(deps);
  return { queryClient, stream, deps, router, route: (event: Partial<AppEvent>) => router.route(makeEvent(event)) };
}
const DIRTY_KEYS = ["scm-status", "scm-worktrees", "scm-diff", "files", "file-content"];
describe("createEventRouter", () => {
  beforeEach(() => sessionStore.set({ agentStates: {}, watermarks: {}, usages: {}, runFailures: {}, problemsBadges: {}, pendingPermissions: [] }));
  it("resync.required：失效该会话全部查询、清权限卡并回调；无活跃 run 时清 busy 与运行中压缩占位，活跃 run 保留", async () => {
    const { queryClient, deps, route } = setup("s1");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: {} });
    route({ type: "resync.required", sessionId: "s1" });
    expect(sessionStore.get().pendingPermissions).toEqual([]); expect(deps.onResyncCurrent).toHaveBeenCalledWith("s1");
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    for (const expected of [qk.session("s1"), ["context", "s1"], ["checkpoints", "s1"], ["permissions", "s1"], qk.run("s1")]) expect(keys).toContain(JSON.stringify(expected));
    sessionMeta.setAgentState("s1", "thinking");
    route({ type: "resync.required", sessionId: "s1" });
    await vi.waitFor(() => { expect(sessionStore.get().agentStates.s1).toBeUndefined(); expect(deps.clearRunningCompaction).toHaveBeenCalledWith("s1"); });
    // 活跃 run：保留 busy 与运行中压缩占位
    vi.mocked(api.run).mockResolvedValueOnce(runSnapshot("executing_tools"));
    const beforeActive = vi.mocked(deps.clearRunningCompaction).mock.calls.length;
    route({ type: "resync.required", sessionId: "s1" });
    await vi.waitFor(() => expect(queryClient.getQueryData(qk.run("s1"))).toMatchObject({ state: "executing_tools" }));
    expect(sessionStore.get().agentStates.s1).toBe("executing_tools"); expect(vi.mocked(deps.clearRunningCompaction).mock.calls.length).toBe(beforeActive);
  });
  it("agent.state：跨会话跟踪 + busy→idle 完成通知；thinking 清运行失败；run 终态转发桌面通知；运行中压缩占位只在 agent/run 终态清除", () => {
    const { deps, route } = setup("s1");
    route({ type: "agent.state", sessionId: "s2", payload: { state: "thinking" } }); expect(sessionStore.get().agentStates.s2).toBe("thinking");
    route({ type: "agent.state", sessionId: "s2", payload: { state: "idle" } });
    expect(deps.pushEventNotification).toHaveBeenCalledWith(expect.stringContaining("会话二"), "info", { sessionId: "s2", view: "sessions" });
    sessionMeta.setRunFailure("s2", { message: "boom", retryable: false });
    route({ type: "agent.state", sessionId: "s2", payload: { state: "thinking" } }); expect(sessionStore.get().runFailures.s2).toBeUndefined();
    route({ type: "run.completed", sessionId: "s2", payload: {} });
    expect(deps.desktopNotify).toHaveBeenCalledWith({ sessionId: "s2", title: "任务完成", body: "会话二" });
    vi.mocked(deps.clearRunningCompaction).mockClear();
    for (const state of ["thinking", "executing_tools"]) route({ type: "agent.state", sessionId: "s3", payload: { state } });
    expect(deps.clearRunningCompaction).not.toHaveBeenCalled();
    for (const state of ["idle", "failed", "aborted"]) route({ type: "agent.state", sessionId: "s3", payload: { state } });
    for (const type of ["run.completed", "run.failed", "run.aborted"]) route({ type, sessionId: "s3", payload: {} });
    expect(deps.clearRunningCompaction).toHaveBeenLastCalledWith("s3");
  });
  it("流式 delta（text/thinking/tool）进缓冲、stream_reset 清空；当前会话 idle 时 flush 并清缓冲，其他会话不路由；当前会话权限卡即时上卡/撤卡", async () => {
    const { stream, route } = setup("s1");
    route({ type: "message.delta", sessionId: "s1", payload: { text: "你好" } });
    route({ type: "message.thinking_delta", sessionId: "s1", payload: { text: "想" } });
    route({ type: "message.tool_call_delta", sessionId: "s1", payload: { id: "c1", name: "bash", text: '{"cmd":' } });
    expect(stream.queueDelta).toHaveBeenCalledWith("s1", "你好"); expect(stream.queueDelta).toHaveBeenCalledWith("s1", "想", true);
    expect(stream.queueToolCallDelta).toHaveBeenCalledWith("s1", "c1", "bash", '{"cmd":');
    route({ type: "message.stream_reset", sessionId: "s1" }); expect(stream.clear).toHaveBeenCalledWith("s1");
    route({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } }); expect(stream.flush).toHaveBeenCalled();
    await vi.waitFor(() => expect(stream.clear).toHaveBeenCalledWith("s1"));
    route({ type: "permission.request", sessionId: "s1", payload: { requestId: "r1", tool: "bash", input: { cmd: "ls" } } });
    expect(sessionStore.get().pendingPermissions.map((item) => item.requestId)).toEqual(["r1"]);
    route({ type: "permission.resolved", sessionId: "s1", payload: { requestId: "r1" } }); expect(sessionStore.get().pendingPermissions).toEqual([]);
    const other = setup("s1");
    other.route({ type: "message.delta", sessionId: "s2", payload: { text: "别的会话" } }); other.route({ type: "permission.request", sessionId: "s2", payload: { requestId: "r9", tool: "bash", input: {} } });
    expect(other.stream.queueDelta).not.toHaveBeenCalled(); expect(sessionStore.get().pendingPermissions).toEqual([]);
  });
  it("水位/用量跨会话记录：清除型事件清旧水位并失效查询，usage/budget_updated 不误清；agent.error 写失败且仅当前会话 toast；todos 直写缓存、diagnostics/task 失效查询", () => {
    const { queryClient, deps, route } = setup("s1");
    const setData = vi.spyOn(queryClient, "setQueryData");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const watermark = { usedTokens: 100, windowTokens: 1000, utilization: 0.1 };
    route({ type: "context.watermark", sessionId: "s2", payload: watermark }); expect(sessionStore.get().watermarks.s2).toEqual(watermark);
    route({ type: "context.usage", sessionId: "s2", payload: { inputTokens: 1 } }); expect(sessionStore.get().usages.s2).toEqual({ inputTokens: 1 });
    sessionMeta.setWatermark("s1", watermarkFixture);
    route({ type: "context.budget_updated", sessionId: "s1", payload: {} }); expect(sessionStore.get().watermarks.s1).toEqual(watermarkFixture);
    for (const type of ["context.compacted", "context.evicted", "context.restored"] as const) {
      sessionMeta.setWatermark("s1", watermarkFixture);
      route({ type, sessionId: "s1", payload: { mode: "overview" } }); expect(sessionStore.get().watermarks.s1).toBeUndefined();
    }
    expect(deriveWindowInfo(sessionStore.get().watermarks.s1, statsFixture, modelFixture)?.estimatedTokens).toBe(48_000);
    vi.mocked(deps.notify).mockClear();
    const error = { message: "限流", kind: "rate_limit", retryable: true };
    route({ type: "agent.error", sessionId: "s2", payload: error }); expect(sessionStore.get().runFailures.s2).toEqual(error);
    expect(deps.notify).not.toHaveBeenCalled();
    route({ type: "agent.error", sessionId: "s1", payload: error }); expect(deps.notify).toHaveBeenCalledWith(expect.any(String), "error");
    vi.mocked(deps.notify).mockClear();
    route({ type: "todos.updated", sessionId: "s1", payload: { items: [{ content: "x", status: "done" }] } });
    expect(setData).toHaveBeenCalledWith(["todos", "s1"], [{ content: "x", status: "done" }]);
    route({ type: "diagnostics.updated", sessionId: "s1", payload: { summary: { failed: 2 } } });
    expect(sessionStore.get().problemsBadges.s1).toBe(2); expect(invalidate).toHaveBeenCalledWith({ queryKey: ["diagnostics", "s1"] });
    route({ type: "task.started", sessionId: "s1", payload: { taskId: "t1", status: "running" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks", "s1"] }); expect(deps.notify).not.toHaveBeenCalled();
  });
  it("压缩事件与 /clear：仅当前会话弹 toast；compacting/compacted/failed 写入标记；/clear 清子代理运行与标签条", () => {
    const { deps, route } = setup("s1");
    route({ type: "context.compacting", sessionId: "s2", payload: { forced: false, mode: "overview" } });
    expect(deps.notify).not.toHaveBeenCalled(); expect(deps.applyCompactionEvent).not.toHaveBeenCalled();
    route({ type: "context.compacting", sessionId: "s1", payload: { forced: true, mode: "vault" } });
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("正在压缩上下文"));
    expect(deps.applyCompactionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "context.compacting", sessionId: "s1" }));
    route({ type: "context.compacted", sessionId: "s1", payload: { mode: "vault" } });
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("已压缩上下文"));
    route({ type: "context.compact_failed", sessionId: "s1", payload: { message: "快速模型超时" } });
    expect(deps.applyCompactionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "context.compact_failed", sessionId: "s1" }));
    expect(deps.clearRunningCompaction).not.toHaveBeenCalled();
    vi.mocked(deps.notify).mockClear();
    route({ type: "context.cleared", sessionId: "s2", payload: { uptoIndex: 3 } });
    expect(deps.clearSubagentRuns).toHaveBeenCalledWith("s2"); expect(deps.notify).not.toHaveBeenCalled();
    route({ type: "context.cleared", sessionId: "s1", payload: { uptoIndex: 4 } });
    expect(deps.clearSubagentRuns).toHaveBeenLastCalledWith("s1");
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("子代理列表已清空"));
  });
  it("写事件与 run 终态标脏 SCM/文件树，静默 400ms 后合并重取一次（不逐条重取）", () => {
    vi.useFakeTimers();
    try {
      const { queryClient, route } = setup("s1");
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const refetch = vi.spyOn(queryClient, "refetchQueries");
      route({ type: "scm.updated", sessionId: "s1", payload: { reason: "file.write" } });
      route({ type: "scm.updated", sessionId: "s1", payload: { reason: "file.write" } });
      expect(refetch).not.toHaveBeenCalled();
      for (const key of DIRTY_KEYS) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key, "s1"], refetchType: "none" });
      vi.advanceTimersByTime(400);
      for (const key of DIRTY_KEYS) expect(refetch).toHaveBeenCalledWith({ queryKey: [key, "s1"], type: "active" });
      invalidate.mockClear();
      route({ type: "run.completed", sessionId: "s1", payload: {} });
      for (const key of DIRTY_KEYS) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key, "s1"], refetchType: "none" });
    } finally {
      vi.useRealTimers();
    }
  });
});
