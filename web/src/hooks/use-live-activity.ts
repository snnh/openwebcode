import { useCallback, useState } from "react";
import type { AppEvent } from "../lib/contracts";
import { INACTIVE_STATES } from "../components/StatusBar";

/** 会话实时活动快照（LiveActivity 组件与 ExecutionTrack prop 的契约） */
export interface LiveActivityInfo {
  state?: string | undefined;
  /** 当前状态进入时间（epoch ms，来自 agent.state 的 since 时间戳） */
  since?: number | undefined;
  /** 最近一个尚未结束的工具名（tool.start 无配对 tool.end） */
  currentTool?: string | undefined;
  /** 并行未结束工具数（>1 时界面显示「等 N 项」） */
  toolCount: number;
}

interface SessionActivity {
  state?: string;
  since?: number;
  outstanding: Array<{ id: string; name: string }>;
}

const EMPTY: SessionActivity = { outstanding: [] };

/**
 * 实时活动跟踪（0.7.x UX 批次）：消费 App WS 分发的 agent.state / tool.start / tool.end，
 * 按会话维护运行状态与未结束工具列表，驱动对话区底部的实时活动指示。
 * 模式与 useAgentRun 一致：App 在 handleSessionEvent 里调 applyEvent。
 */
export function useLiveActivity() {
  const [activities, setActivities] = useState<Record<string, SessionActivity>>({});

  const applyEvent = useCallback((event: AppEvent): void => {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    if (event.type === "agent.state") {
      const payload = event.payload as { state?: string; since?: string };
      if (!payload.state) return;
      const state = payload.state;
      setActivities((previous) => {
        const entry = previous[sessionId] ?? EMPTY;
        // 新一轮开始或进入终态时清空未结束工具（防御 tool.end 丢失）
        const resetTools = INACTIVE_STATES.has(state) || state === "accepted" || state === "starting";
        return {
          ...previous,
          [sessionId]: {
            state,
            ...(payload.since ? { since: Date.parse(payload.since) } : entry.since !== undefined ? { since: entry.since } : {}),
            outstanding: resetTools ? [] : entry.outstanding,
          },
        };
      });
      return;
    }
    if (event.type === "tool.start") {
      const payload = event.payload as { toolCallId?: string; name?: string };
      if (!payload.toolCallId || !payload.name) return;
      const tool = { id: payload.toolCallId, name: payload.name };
      setActivities((previous) => {
        const entry = previous[sessionId] ?? EMPTY;
        if (entry.outstanding.some((item) => item.id === tool.id)) return previous;
        return { ...previous, [sessionId]: { ...entry, outstanding: [...entry.outstanding, tool] } };
      });
      return;
    }
    if (event.type === "tool.end") {
      const payload = event.payload as { toolCallId?: string };
      if (!payload.toolCallId) return;
      setActivities((previous) => {
        const entry = previous[sessionId];
        if (!entry || !entry.outstanding.some((item) => item.id === payload.toolCallId)) return previous;
        return { ...previous, [sessionId]: { ...entry, outstanding: entry.outstanding.filter((item) => item.id !== payload.toolCallId) } };
      });
    }
  }, []);

  const activityFor = useCallback((sessionId?: string): LiveActivityInfo | undefined => {
    if (!sessionId) return undefined;
    const entry = activities[sessionId];
    if (!entry) return undefined;
    const latest = entry.outstanding.at(-1);
    return {
      ...(entry.state !== undefined ? { state: entry.state } : {}),
      ...(entry.since !== undefined ? { since: entry.since } : {}),
      ...(latest ? { currentTool: latest.name } : {}),
      toolCount: entry.outstanding.length,
    };
  }, [activities]);

  return { activityFor, applyEvent };
}
