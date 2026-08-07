import type {
  AppEvent, LiveSubagentRun, SubagentFinishedEvent, SubagentProgressEvent, SubagentStartedEvent,
} from "../lib/contracts";
import { capLiveSubagentRuns, LIVE_SUBAGENT_CAP } from "../lib/subagent-runs";
import { INACTIVE_STATES } from "../lib/agent-state";
import { createStore, useStore } from "./store";

/**
 * 实时运行数据（WS 事件驱动，框架无关）：
 * - 子代理运行（sessionId → taskId → run，终态保留，每会话封顶）
 * - 实时活动（agent.state + 未结束工具）
 * 旧 use-live-subagents/use-live-activity 两个 hook 的 store 化移植：
 * 事件路由直接写入，任何组件（消息卡/标签条/子代理面板/活动条）经 useStore 选择器读取。
 */

export interface LiveActivityEntry {
  state?: string;
  since?: number;
  outstanding: Array<{ id: string; name: string }>;
}

export interface LiveActivityInfo {
  state?: string | undefined;
  /** 当前状态进入时间（epoch ms，来自 agent.state 的 since 时间戳） */
  since?: number | undefined;
  /** 最近一个尚未结束的工具名（tool.start 无配对 tool.end） */
  currentTool?: string | undefined;
  /** 并行未结束工具数（>1 时界面显示「等 N 项」） */
  toolCount: number;
}

interface LiveState {
  subagents: Record<string, Record<string, LiveSubagentRun>>;
  activities: Record<string, LiveActivityEntry>;
}

const INITIAL_STATE: LiveState = { subagents: {}, activities: {} };
const EMPTY_ACTIVITY: LiveActivityEntry = { outstanding: [] };

export const liveStore = createStore<LiveState>(INITIAL_STATE);

function removeKey<T>(previous: Record<string, T>, id: string): Record<string, T> {
  if (!(id in previous)) return previous;
  const { [id]: _removed, ...remaining } = previous;
  return remaining;
}

export const live = {
  /** subagent.started/progress/finished 维护条目（终态保留，供子代理面板会话级历史） */
  applySubagentEvent(event: AppEvent, onStarted?: (sessionId: string, payload: SubagentStartedEvent) => void): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    if (event.type === "subagent.started") {
      const payload = event.payload as SubagentStartedEvent;
      liveStore.set((previous) => ({
        subagents: {
          ...previous.subagents,
          [sessionId]: capLiveSubagentRuns({
            ...previous.subagents[sessionId],
            [payload.taskId]: {
              taskId: payload.taskId,
              toolCallId: payload.toolCallId,
              prompt: payload.prompt,
              ...(payload.agent ? { agent: payload.agent } : {}),
              ...(payload.swarm ? { swarm: payload.swarm } : {}),
              status: "running",
              turns: 0,
              toolsUsed: [],
            },
          }, LIVE_SUBAGENT_CAP),
        },
      }));
      onStarted?.(sessionId, payload);
      return;
    }
    if (event.type === "subagent.progress") {
      const payload = event.payload as SubagentProgressEvent;
      liveStore.set((previous) => {
        const sessionRuns = previous.subagents[sessionId];
        const run = sessionRuns?.[payload.taskId];
        if (!sessionRuns || !run) return {};
        return {
          subagents: { ...previous.subagents, [sessionId]: { ...sessionRuns, [payload.taskId]: { ...run, turns: payload.turns, toolsUsed: payload.toolsUsed } } },
        };
      });
      return;
    }
    if (event.type === "subagent.finished") {
      const payload = event.payload as SubagentFinishedEvent;
      liveStore.set((previous) => {
        const sessionRuns = previous.subagents[sessionId];
        const run = sessionRuns?.[payload.taskId];
        if (!sessionRuns || !run) return {};
        return {
          subagents: {
            ...previous.subagents,
            [sessionId]: {
              ...sessionRuns,
              [payload.taskId]: {
                ...run,
                status: payload.status,
                ...(payload.turns !== undefined ? { turns: payload.turns } : {}),
                ...(payload.toolsUsed ? { toolsUsed: payload.toolsUsed } : {}),
                ...(payload.error ? { error: payload.error } : {}),
              },
            },
          },
        };
      });
    }
  },

  /** agent.state / tool.start / tool.end 维护会话实时活动 */
  applyActivityEvent(event: AppEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    if (event.type === "agent.state") {
      const payload = event.payload as { state?: string; since?: string };
      if (!payload.state) return;
      const state = payload.state;
      liveStore.set((previous) => {
        const entry = previous.activities[sessionId] ?? EMPTY_ACTIVITY;
        // 新一轮开始或进入终态时清空未结束工具（防御 tool.end 丢失）
        const resetTools = INACTIVE_STATES.has(state) || state === "accepted" || state === "starting";
        return {
          activities: {
            ...previous.activities,
            [sessionId]: {
              state,
              ...(payload.since ? { since: Date.parse(payload.since) } : entry.since !== undefined ? { since: entry.since } : {}),
              outstanding: resetTools ? [] : entry.outstanding,
            },
          },
        };
      });
      return;
    }
    if (event.type === "tool.start") {
      const payload = event.payload as { toolCallId?: string; name?: string };
      if (!payload.toolCallId || !payload.name) return;
      const tool = { id: payload.toolCallId, name: payload.name };
      liveStore.set((previous) => {
        const entry = previous.activities[sessionId] ?? EMPTY_ACTIVITY;
        if (entry.outstanding.some((item) => item.id === tool.id)) return {};
        return { activities: { ...previous.activities, [sessionId]: { ...entry, outstanding: [...entry.outstanding, tool] } } };
      });
      return;
    }
    if (event.type === "tool.end") {
      const payload = event.payload as { toolCallId?: string };
      if (!payload.toolCallId) return;
      liveStore.set((previous) => {
        const entry = previous.activities[sessionId];
        if (!entry || !entry.outstanding.some((item) => item.id === payload.toolCallId)) return {};
        return { activities: { ...previous.activities, [sessionId]: { ...entry, outstanding: entry.outstanding.filter((item) => item.id !== payload.toolCallId) } } };
      });
    }
  },

  /** 会话删除：清理实时数据 */
  removeSession(sessionId: string): void {
    liveStore.set((previous) => ({
      subagents: removeKey(previous.subagents, sessionId),
      activities: removeKey(previous.activities, sessionId),
    }));
  },
};

/** 活动条目 → 展示信息（LiveActivityBar/StatusBar 共用） */
export function deriveActivityInfo(entry: LiveActivityEntry | undefined): LiveActivityInfo | undefined {
  if (!entry) return undefined;
  const latest = entry.outstanding.at(-1);
  return {
    ...(entry.state !== undefined ? { state: entry.state } : {}),
    ...(entry.since !== undefined ? { since: entry.since } : {}),
    ...(latest ? { currentTool: latest.name } : {}),
    toolCount: entry.outstanding.length,
  };
}

const EMPTY_RUNS: Record<string, LiveSubagentRun> = {};

/** React 绑定：某会话的实时子代理运行（引用稳定，无更新不抖动） */
export function useLiveSubagentRuns(sessionId: string | undefined): Record<string, LiveSubagentRun> {
  return useStore(liveStore, (state) => (sessionId ? state.subagents[sessionId] : undefined) ?? EMPTY_RUNS);
}

/** React 绑定：某会话的实时活动条目（用 deriveActivityInfo 派生展示信息） */
export function useLiveActivityEntry(sessionId: string | undefined): LiveActivityEntry | undefined {
  return useStore(liveStore, (state) => (sessionId ? state.activities[sessionId] : undefined));
}
