import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createEventRouter, type EventRouterDeps } from "../app/event-router";
import { sessionMeta, sessionStore } from "../app/session-store";
import { qk } from "../app/queries";
import type { AppEvent, Session } from "../lib/contracts";
import type { StreamBuffer } from "../chat/stream-buffer";

vi.mock("../lib/api", () => ({
  api: {
    run: vi.fn(() => Promise.reject(new Error("no active run"))),
  },
}));

function makeEvent(partial: Partial<AppEvent>): AppEvent {
  return { source: "server", type: "agent.state", ...partial } as AppEvent;
}

function setup(currentSessionId = "s1") {
  const queryClient = new QueryClient();
  const stream: StreamBuffer = {
    blocksFor: () => [],
    subscribe: () => () => {},
    queueDelta: vi.fn(),
    queueToolCallDelta: vi.fn(),
    flush: vi.fn(),
    finish: vi.fn(),
    clear: vi.fn(),
    discard: vi.fn(),
  };
  const sessions: Session[] = [{ id: "s1", title: "会话一" } as Session, { id: "s2", title: "会话二" } as Session];
  const deps: EventRouterDeps = {
    queryClient,
    getCurrentSessionId: () => currentSessionId,
    getSessions: () => sessions,
    t: (chinese: string, english: string) => chinese,
    notify: vi.fn(),
    pushEventNotification: vi.fn(),
    desktopNotify: vi.fn(),
    applyRunEvent: vi.fn(),
    applyActivityEvent: vi.fn(),
    applySubagentEvent: vi.fn(),
    stream,
    onResyncCurrent: vi.fn(),
  };
  const router = createEventRouter(deps);
  return { queryClient, stream, deps, router };
}

describe("createEventRouter", () => {
  beforeEach(() => {
    sessionStore.set({
      agentStates: {},
      watermarks: {},
      usages: {},
      runFailures: {},
      problemsBadges: {},
      pendingPermissions: [],
    });
  });

  it("resync.required：失效该会话全部查询，清本地权限卡并回调 onResyncCurrent", async () => {
    const { queryClient, deps, router } = setup("s1");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: {} });
    router.route(makeEvent({ type: "resync.required", sessionId: "s1" }));
    expect(sessionStore.get().pendingPermissions).toEqual([]);
    expect(deps.onResyncCurrent).toHaveBeenCalledWith("s1");
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    for (const expected of [qk.session("s1"), ["context", "s1"], ["checkpoints", "s1"], ["permissions", "s1"], qk.run("s1")]) {
      expect(keys).toContain(JSON.stringify(expected));
    }
    // 服务端无活跃 run：本地 busy 残留被清掉
    sessionMeta.setAgentState("s1", "thinking");
    router.route(makeEvent({ type: "resync.required", sessionId: "s1" }));
    await vi.waitFor(() => expect(sessionStore.get().agentStates.s1).toBeUndefined());
  });

  it("agent.state：跨会话跟踪 + busy→idle 完成通知；thinking 清运行失败", () => {
    const { deps, router } = setup("s1");
    router.route(makeEvent({ type: "agent.state", sessionId: "s2", payload: { state: "thinking" } }));
    expect(sessionStore.get().agentStates.s2).toBe("thinking");
    router.route(makeEvent({ type: "agent.state", sessionId: "s2", payload: { state: "idle" } }));
    expect(deps.pushEventNotification).toHaveBeenCalledWith(
      expect.stringContaining("会话二"),
      "info",
      { sessionId: "s2", view: "sessions" },
    );
    sessionMeta.setRunFailure("s2", { message: "boom", retryable: false });
    router.route(makeEvent({ type: "agent.state", sessionId: "s2", payload: { state: "thinking" } }));
    expect(sessionStore.get().runFailures.s2).toBeUndefined();
  });

  it("message.delta/thinking_delta/tool_call_delta 进流式缓冲；stream_reset 清空", () => {
    const { stream, router } = setup("s1");
    router.route(makeEvent({ type: "message.delta", sessionId: "s1", payload: { text: "你好" } }));
    router.route(makeEvent({ type: "message.thinking_delta", sessionId: "s1", payload: { text: "想" } }));
    router.route(makeEvent({ type: "message.tool_call_delta", sessionId: "s1", payload: { id: "c1", name: "bash", text: "{\"cmd\":" } }));
    expect(stream.queueDelta).toHaveBeenCalledWith("s1", "你好");
    expect(stream.queueDelta).toHaveBeenCalledWith("s1", "想", true);
    expect(stream.queueToolCallDelta).toHaveBeenCalledWith("s1", "c1", "bash", "{\"cmd\":");
    router.route(makeEvent({ type: "message.stream_reset", sessionId: "s1" }));
    expect(stream.clear).toHaveBeenCalledWith("s1");
  });

  it("非当前会话的流式/权限事件不路由到本地（仅跨会话跟踪）", () => {
    const { stream, router } = setup("s1");
    router.route(makeEvent({ type: "message.delta", sessionId: "s2", payload: { text: "别的会话" } }));
    router.route(makeEvent({ type: "permission.request", sessionId: "s2", payload: { requestId: "r9", tool: "bash", input: {} } }));
    expect(stream.queueDelta).not.toHaveBeenCalled();
    expect(sessionStore.get().pendingPermissions).toEqual([]);
  });

  it("permission.request（当前会话）即时上卡；permission.resolved 撤卡", () => {
    const { router } = setup("s1");
    router.route(makeEvent({ type: "permission.request", sessionId: "s1", payload: { requestId: "r1", tool: "bash", input: { cmd: "ls" } } }));
    expect(sessionStore.get().pendingPermissions.map((item) => item.requestId)).toEqual(["r1"]);
    router.route(makeEvent({ type: "permission.resolved", sessionId: "s1", payload: { requestId: "r1" } }));
    expect(sessionStore.get().pendingPermissions).toEqual([]);
  });

  it("context.watermark/usage 跨会话记录；agent.error 写运行失败且仅当前会话弹 toast", () => {
    const { deps, router } = setup("s1");
    const watermark = { usedTokens: 100, windowTokens: 1000, utilization: 0.1 };
    router.route(makeEvent({ type: "context.watermark", sessionId: "s2", payload: watermark }));
    expect(sessionStore.get().watermarks.s2).toEqual(watermark);
    router.route(makeEvent({ type: "context.usage", sessionId: "s2", payload: { inputTokens: 1 } }));
    expect(sessionStore.get().usages.s2).toEqual({ inputTokens: 1 });

    router.route(makeEvent({ type: "agent.error", sessionId: "s2", payload: { message: "限流", kind: "rate_limit", retryable: true } }));
    expect(sessionStore.get().runFailures.s2).toEqual({ message: "限流", kind: "rate_limit", retryable: true });
    expect(deps.notify).not.toHaveBeenCalled();
    router.route(makeEvent({ type: "agent.error", sessionId: "s1", payload: { message: "限流", kind: "rate_limit", retryable: true } }));
    expect(deps.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("todos.updated 直写缓存；diagnostics.updated 更新角标并失效查询", () => {
    const { queryClient, router } = setup("s1");
    const setData = vi.spyOn(queryClient, "setQueryData");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    router.route(makeEvent({ type: "todos.updated", sessionId: "s1", payload: { items: [{ content: "x", status: "done" }] } }));
    expect(setData).toHaveBeenCalledWith(["todos", "s1"], [{ content: "x", status: "done" }]);
    router.route(makeEvent({ type: "diagnostics.updated", sessionId: "s1", payload: { summary: { failed: 2 } } }));
    expect(sessionStore.get().problemsBadges.s1).toBe(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["diagnostics", "s1"] });
  });

  it("agent.state=idle（当前会话）：flush 流式缓冲，detail 刷新完成后 clear", async () => {
    const { stream, router } = setup("s1");
    router.route(makeEvent({ type: "agent.state", sessionId: "s1", payload: { state: "idle" } }));
    expect(stream.flush).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(stream.clear).toHaveBeenCalledWith("s1"));
  });

  it("桌面通知：权限/交互/run 终态跨会话转发给装配层", () => {
    const { deps, router } = setup("s1");
    router.route(makeEvent({ type: "run.completed", sessionId: "s2", payload: {} }));
    expect(deps.desktopNotify).toHaveBeenCalledWith({ sessionId: "s2", title: "任务完成", body: "会话二" });
  });
});
