import { useCallback, useState } from "react";
import type { AppEvent, LiveSubagentRun, SubagentFinishedEvent, SubagentProgressEvent, SubagentStartedEvent } from "../lib/contracts";
import { capLiveSubagentRuns, LIVE_SUBAGENT_CAP } from "../lib/subagent-runs";

export interface UseLiveSubagentsOptions {
  /**
   * true（默认）：spawn 工具的 tool.end 到达后移除其实时条目（持久化 tool_result 接管渲染）。
   * 需要会话级运行历史（如子代理面板）时传 false 保留终态条目。
   */
  dropOnToolEnd?: boolean;
  /** 每个会话保留的条目上限（默认 LIVE_SUBAGENT_CAP），超出时丢弃最旧的 */
  maxPerSession?: number;
}

/**
 * 子代理实时运行状态（sessionId → taskId → run）的归约逻辑，供 App 与独立监视窗口共用：
 * subagent.started/progress/finished 维护条目，tool.end 按 toolCallId 清除（可选）。
 */
export function useLiveSubagents(options?: UseLiveSubagentsOptions): {
  liveSubagents: Record<string, Record<string, LiveSubagentRun>>;
  applyEvent(event: AppEvent): void;
  removeSession(sessionId: string): void;
} {
  const dropOnToolEnd = options?.dropOnToolEnd ?? true;
  const maxPerSession = options?.maxPerSession ?? LIVE_SUBAGENT_CAP;
  const [liveSubagents, setLiveSubagents] = useState<Record<string, Record<string, LiveSubagentRun>>>({});

  const applyEvent = useCallback((event: AppEvent): void => {
    if (!event.sessionId) return;
    const sessionId = event.sessionId;
    if (event.type === "subagent.started") {
      const payload = event.payload as SubagentStartedEvent;
      setLiveSubagents((previous) => ({
        ...previous,
        [sessionId]: capLiveSubagentRuns({
          ...previous[sessionId],
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
        }, maxPerSession),
      }));
      return;
    }
    if (event.type === "subagent.progress") {
      const payload = event.payload as SubagentProgressEvent;
      setLiveSubagents((previous) => {
        const sessionRuns = previous[sessionId];
        const run = sessionRuns?.[payload.taskId];
        if (!sessionRuns || !run) return previous;
        return { ...previous, [sessionId]: { ...sessionRuns, [payload.taskId]: { ...run, turns: payload.turns, toolsUsed: payload.toolsUsed } } };
      });
      return;
    }
    if (event.type === "subagent.finished") {
      const payload = event.payload as SubagentFinishedEvent;
      setLiveSubagents((previous) => {
        const sessionRuns = previous[sessionId];
        const run = sessionRuns?.[payload.taskId];
        if (!sessionRuns || !run) return previous;
        return {
          ...previous,
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
        };
      });
      return;
    }
    // spawn 工具的 tool.end 到达后移除其实时条目：持久化 tool_result（含转录链接）接管渲染
    if (dropOnToolEnd && event.type === "tool.end") {
      const toolCallId = (event.payload as { toolCallId?: string }).toolCallId;
      if (toolCallId) {
        setLiveSubagents((previous) => {
          const sessionRuns = previous[sessionId];
          if (!sessionRuns) return previous;
          const remaining = Object.fromEntries(Object.entries(sessionRuns).filter(([, run]) => run.toolCallId !== toolCallId));
          if (Object.keys(remaining).length === Object.keys(sessionRuns).length) return previous;
          return { ...previous, [sessionId]: remaining };
        });
      }
    }
  }, [dropOnToolEnd, maxPerSession]);

  const removeSession = useCallback((sessionId: string): void => {
    setLiveSubagents((previous) => {
      if (!(sessionId in previous)) return previous;
      const { [sessionId]: _removed, ...remaining } = previous;
      return remaining;
    });
  }, []);

  return { liveSubagents, applyEvent, removeSession };
}
