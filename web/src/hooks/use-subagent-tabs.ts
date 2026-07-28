import { useCallback, useRef, useState } from "react";
import type { SubagentStartedEvent } from "../lib/contracts";

/**
 * 主区子代理标签页（按会话隔离）：spawn_task / spawn_swarm 一次调用一个标签（toolCallId 键控）。
 * 标签只存派生标签名所需的原始字段，文案在渲染时经 i18n 计算。
 */
export interface SubagentTab {
  toolCallId: string;
  /** spawn_task 的代理名（标签名优先取它） */
  agent?: string;
  /** spawn_task 的 prompt（无 agent 时取摘要）；swarm 为首个子任务 */
  prompt: string;
  /** swarm 组：标签展示「群 N 项」 */
  swarmTotal?: number;
}

export interface UseSubagentTabsResult {
  tabsBySession: Record<string, SubagentTab[]>;
  /** 会话当前选中标签的 toolCallId；缺省表示「对话」标签 */
  selectedBySession: Record<string, string>;
  /** subagent.started 自动开标签：同 toolCallId 已存在或已被用户关闭（dismissed）则跳过；不抢焦点（停留在对话） */
  openFromStarted(sessionId: string, payload: SubagentStartedEvent): void;
  /** 手动打开（子代理面板「在标签中打开」）：不存在则创建并聚焦该标签，同时清除关闭标记 */
  openTab(sessionId: string, tab: SubagentTab): void;
  /** 选中标签；缺省（undefined）回到「对话」 */
  selectTab(sessionId: string, toolCallId?: string): void;
  /** 关闭标签（只影响视图，不影响运行）；关闭当前选中标签时回退「对话」 */
  closeTab(sessionId: string, toolCallId: string): void;
  removeSession(sessionId: string): void;
}

function fromStartedPayload(payload: SubagentStartedEvent): SubagentTab {
  return {
    toolCallId: payload.toolCallId,
    prompt: payload.prompt,
    ...(payload.agent ? { agent: payload.agent } : {}),
    ...(payload.swarm ? { swarmTotal: payload.swarm.total } : {}),
  };
}

/** 主区子代理标签条状态：标签列表与选中项均按会话键控，切换会话互不干扰 */
export function useSubagentTabs(): UseSubagentTabsResult {
  const [tabsBySession, setTabsBySession] = useState<Record<string, SubagentTab[]>>({});
  const [selectedBySession, setSelectedBySession] = useState<Record<string, string>>({});
  // 用户主动关闭过的 toolCallId（按会话）：swarm 后续 started 事件不得重开已关标签；不参与渲染，用 ref 即可
  const dismissedRef = useRef<Record<string, Set<string>>>({});

  const openFromStarted = useCallback((sessionId: string, payload: SubagentStartedEvent): void => {
    if (dismissedRef.current[sessionId]?.has(payload.toolCallId)) return;
    setTabsBySession((previous) => {
      const tabs = previous[sessionId] ?? [];
      if (tabs.some((tab) => tab.toolCallId === payload.toolCallId)) return previous;
      return { ...previous, [sessionId]: [...tabs, fromStartedPayload(payload)] };
    });
  }, []);

  const openTab = useCallback((sessionId: string, tab: SubagentTab): void => {
    // 手动打开（子代理面板）视为撤销关闭标记，允许后续 started 再次自动开标签
    dismissedRef.current[sessionId]?.delete(tab.toolCallId);
    setTabsBySession((previous) => {
      const tabs = previous[sessionId] ?? [];
      if (tabs.some((entry) => entry.toolCallId === tab.toolCallId)) return previous;
      return { ...previous, [sessionId]: [...tabs, tab] };
    });
    setSelectedBySession((previous) => ({ ...previous, [sessionId]: tab.toolCallId }));
  }, []);

  const selectTab = useCallback((sessionId: string, toolCallId?: string): void => {
    setSelectedBySession((previous) => {
      if (toolCallId === undefined) {
        if (!(sessionId in previous)) return previous;
        const { [sessionId]: _cleared, ...remaining } = previous;
        return remaining;
      }
      return { ...previous, [sessionId]: toolCallId };
    });
  }, []);

  const closeTab = useCallback((sessionId: string, toolCallId: string): void => {
    (dismissedRef.current[sessionId] ??= new Set()).add(toolCallId);
    setTabsBySession((previous) => {
      const tabs = previous[sessionId];
      if (!tabs?.some((tab) => tab.toolCallId === toolCallId)) return previous;
      const remaining = tabs.filter((tab) => tab.toolCallId !== toolCallId);
      return { ...previous, [sessionId]: remaining };
    });
    setSelectedBySession((previous) => {
      if (previous[sessionId] !== toolCallId) return previous;
      const { [sessionId]: _cleared, ...remaining } = previous;
      return remaining;
    });
  }, []);

  const removeSession = useCallback((sessionId: string): void => {
    delete dismissedRef.current[sessionId];
    setTabsBySession((previous) => {
      if (!(sessionId in previous)) return previous;
      const { [sessionId]: _removed, ...remaining } = previous;
      return remaining;
    });
    setSelectedBySession((previous) => {
      if (!(sessionId in previous)) return previous;
      const { [sessionId]: _removed, ...remaining } = previous;
      return remaining;
    });
  }, []);

  return { tabsBySession, selectedBySession, openFromStarted, openTab, selectTab, closeTab, removeSession };
}
