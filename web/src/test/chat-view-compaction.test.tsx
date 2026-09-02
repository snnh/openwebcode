import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { live, liveStore } from "../app/live-store";
import { sessionMeta, sessionStore } from "../app/session-store";
import { uiStore } from "../app/ui-store";
import { qk } from "../app/queries";
import { ChatView } from "../chat/ChatView";
import { makeSession, makeContextView, makeModelProfile } from "./helpers/fixtures";
import type { UseSubagentTabsResult } from "../hooks/use-subagent-tabs";
import type { UseTerminalTabsResult } from "../hooks/use-terminal-tabs";

/**
 * ChatView「运行中」压缩占位自愈（REST 刷新完成 + 无活跃 run 时清滞留占位）：
 * 直接渲染 ChatView，查询数据经 QueryClient 预置（staleTime Infinity 不发请求），
 * 断言 live-store 中的占位随渲染/状态变化被清或保留。
 */

function makeTabs(): { subagentTabs: UseSubagentTabsResult; terminalTabs: UseTerminalTabsResult } {
  return {
    subagentTabs: {
      tabsBySession: {},
      selectedBySession: {},
      openFromStarted: vi.fn(),
      openTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      removeSession: vi.fn(),
    },
    terminalTabs: {
      openBySession: {},
      selectedBySession: {},
      openTerminal: vi.fn(),
      setTerminalSelected: vi.fn(),
      closeTerminal: vi.fn(),
      removeSession: vi.fn(),
    },
  };
}

function seedQueries(client: QueryClient): void {
  client.setQueryData(qk.session("s1"), makeSession({ messages: [] }));
  client.setQueryData(qk.context("s1"), makeContextView());
  client.setQueryData(qk.models, [makeModelProfile()]);
  client.setQueryData(qk.extensions, []);
  client.setQueryData(qk.queue("s1"), []);
  client.setQueryData(qk.interactions("s1"), []);
  client.setQueryData(qk.todos("s1"), []);
  client.setQueryData(qk.permissions("s1"), []);
}

function renderChatView(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  seedQueries(client);
  const { subagentTabs, terminalTabs } = makeTabs();
  // render 内部已包 act：首帧后 effect 同步执行
  render(
    <QueryClientProvider client={client}>
      <ChatView sessionId="s1" currentRun={undefined} subagentTabs={subagentTabs} terminalTabs={terminalTabs} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  liveStore.set({ subagents: {}, activities: {}, compactions: {} });
  sessionStore.set({ agentStates: {}, watermarks: {}, usages: {}, runFailures: {}, problemsBadges: {}, pendingPermissions: [] });
  uiStore.set({ sessionId: undefined, newSessionOpen: false, settingsOpen: false, paletteOpen: false, quickOpen: false });
  document.body.innerHTML = "";
});

describe("ChatView 压缩占位自愈", () => {
  it("ChatView 渲染后占位自愈：无活跃 run 清除、busy 保留并随终态清除", () => {
    // 场景 1：REST 刷新完成且无活跃 run —— 服务端 run 已结束（无 agentState/currentRun），
    // 但 compacted 事件曾因 WS 缺口丢失：消息流里残留 running 占位 + 一个更早的已沉降标记
    live.applyCompactionEvent({ source: "agent", type: "context.compacted", sessionId: "s1", payload: { mode: "overview", uptoIndex: 3, createdAt: "2026-08-12T01:00:00.000Z" } } as never);
    live.applyCompactionEvent({ source: "agent", type: "context.compacting", sessionId: "s1", payload: { mode: "overview" } } as never);
    expect(liveStore.get().compactions["s1"]!.map((marker) => marker.status)).toEqual(["settled", "running"]);

    renderChatView();
    const list = liveStore.get().compactions["s1"]!;
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("settled");

    // 场景 2：agent run busy（压缩可能正在进行）——复位 store 恢复每场景独立基线
    act(() => {
      liveStore.set({ subagents: {}, activities: {}, compactions: {} });
      sessionStore.set({ agentStates: {}, watermarks: {}, usages: {}, runFailures: {}, problemsBadges: {}, pendingPermissions: [] });
      uiStore.set({ sessionId: undefined, newSessionOpen: false, settingsOpen: false, paletteOpen: false, quickOpen: false });
    });
    sessionMeta.setAgentState("s1", "preparing_context");
    live.applyCompactionEvent({ source: "agent", type: "context.compacting", sessionId: "s1", payload: { mode: "overview" } } as never);

    renderChatView();
    expect(liveStore.get().compactions["s1"]!.map((marker) => marker.status)).toEqual(["running"]);

    // run 转终态（resync 对齐服务端真相清掉 busy 残留）后，占位随状态变化被清掉
    act(() => sessionMeta.clearAgentStateIfIdle("s1"));
    expect(liveStore.get().compactions["s1"]).toEqual([]);
  });

  it("事件正常到达（compacted 原位沉降）时运行中占位不留残痕", () => {
    renderChatView();
    live.applyCompactionEvent({ source: "agent", type: "context.compacting", sessionId: "s1", payload: { mode: "overview" } } as never);
    // compacting 事件本身不触发自愈（不改变 effect 依赖），占位保持到终态事件到达
    expect(liveStore.get().compactions["s1"]!.map((marker) => marker.status)).toEqual(["running"]);
    live.applyCompactionEvent({ source: "agent", type: "context.compacted", sessionId: "s1", payload: { mode: "overview", uptoIndex: 5, createdAt: "2026-08-12T02:00:00.000Z" } } as never);
    expect(liveStore.get().compactions["s1"]!.map((marker) => marker.status)).toEqual(["settled"]);
  });
});
