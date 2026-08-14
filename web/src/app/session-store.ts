import type { AgentErrorPayload, ContextUsage, ContextWatermark } from "../lib/contracts";
import { applyDiagnosticsBadgeUpdate, clearDiagnosticsBadge } from "../lib/diagnostics";
import { isBusyState } from "../lib/agent-state";
import { createStore } from "./store";

/** WS 即时权限卡（permission.request 到达即渲染）；与服务端待决列表按 requestId 去重合并 */
export interface PendingPermission {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * 按会话键控的运行态（WS 事件驱动，REST 之外）：
 * agent 状态、上下文水位/用量、运行失败、Problems 角标、即时权限卡。
 * 事件路由（event-router）写入；任意组件经 useStore 选择器读取，消灭 props 透传。
 */
interface SessionMetaState {
  agentStates: Record<string, string>;
  watermarks: Record<string, ContextWatermark>;
  usages: Record<string, ContextUsage>;
  runFailures: Record<string, AgentErrorPayload>;
  problemsBadges: Record<string, number>;
  /** 当前会话的 WS 即时权限卡（切换会话/resync 时清空，由服务端列表重建） */
  pendingPermissions: PendingPermission[];
}

const INITIAL_STATE: SessionMetaState = {
  agentStates: {},
  watermarks: {},
  usages: {},
  runFailures: {},
  problemsBadges: {},
  pendingPermissions: [],
};

export const sessionStore = createStore<SessionMetaState>(INITIAL_STATE);

function removeKey<T>(previous: Record<string, T>, id: string): Record<string, T> {
  if (!(id in previous)) return previous;
  const { [id]: _removed, ...remaining } = previous;
  return remaining;
}

export const sessionMeta = {
  setAgentState(sessionId: string, state: string): void {
    sessionStore.set((previous) => ({ agentStates: { ...previous.agentStates, [sessionId]: state } }));
  },
  /** resync 对齐服务端真相后清除本地残留的 busy 态（服务端无活跃 run） */
  clearAgentStateIfIdle(sessionId: string): void {
    sessionStore.set((previous) => {
      if (!isBusyState(previous.agentStates[sessionId])) return {};
      return { agentStates: removeKey(previous.agentStates, sessionId) };
    });
  },
  setWatermark(sessionId: string, watermark: ContextWatermark): void {
    sessionStore.set((previous) => ({ watermarks: { ...previous.watermarks, [sessionId]: watermark } }));
  },
  setUsage(sessionId: string, usage: ContextUsage): void {
    sessionStore.set((previous) => ({ usages: { ...previous.usages, [sessionId]: usage } }));
  },
  setRunFailure(sessionId: string, failure: AgentErrorPayload): void {
    sessionStore.set((previous) => ({ runFailures: { ...previous.runFailures, [sessionId]: failure } }));
  },
  clearRunFailure(sessionId: string): void {
    sessionStore.set((previous) => ({ runFailures: removeKey(previous.runFailures, sessionId) }));
  },
  bumpProblemsBadge(sessionId: string, failed: number): void {
    sessionStore.set((previous) => ({ problemsBadges: applyDiagnosticsBadgeUpdate(previous.problemsBadges, sessionId, failed) }));
  },
  clearProblemsBadge(sessionId: string): void {
    sessionStore.set((previous) => ({ problemsBadges: clearDiagnosticsBadge(previous.problemsBadges, sessionId) }));
  },
  upsertPermission(request: PendingPermission): void {
    sessionStore.set((previous) => ({
      pendingPermissions: [...previous.pendingPermissions.filter((item) => item.requestId !== request.requestId), request],
    }));
  },
  removePermission(requestId: string): void {
    sessionStore.set((previous) => ({
      pendingPermissions: previous.pendingPermissions.filter((item) => item.requestId !== requestId),
    }));
  },
  clearPermissions(): void {
    sessionStore.set({ pendingPermissions: [] });
  },
  /** 会话删除：清理全部按会话键控的条目 */
  removeSession(sessionId: string): void {
    sessionStore.set((previous) => ({
      agentStates: removeKey(previous.agentStates, sessionId),
      watermarks: removeKey(previous.watermarks, sessionId),
      usages: removeKey(previous.usages, sessionId),
      runFailures: removeKey(previous.runFailures, sessionId),
      problemsBadges: removeKey(previous.problemsBadges, sessionId),
    }));
  },
};
