import { createStore, useStore } from "../app/store";
import { api } from "../lib/api";
import type { ChatMessage } from "../lib/contracts";

/**
 * 历史消息向上分页（更早消息按会话键控缓存；resync 时由事件路由清理）。
 * 状态存于模块级 store，MessageList/ChatView 经 useOlderMessages 订阅。
 */

export interface OlderMessagesState {
  older: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
}

const EMPTY: OlderMessagesState = { older: [], hasMore: false, loading: false };

interface PaginationState {
  bySession: Record<string, OlderMessagesState>;
}

const store = createStore<PaginationState>({ bySession: {} });

function patch(sessionId: string, partial: Partial<OlderMessagesState>): void {
  store.set((previous) => ({
    bySession: {
      ...previous.bySession,
      [sessionId]: { ...(previous.bySession[sessionId] ?? EMPTY), ...partial },
    },
  }));
}

/** 订阅某会话的分页状态（未知会话返回共享空态，引用稳定） */
export function useOlderMessages(sessionId: string | undefined): OlderMessagesState {
  return useStore(store, (state) => (sessionId ? state.bySession[sessionId] : undefined) ?? EMPTY);
}

/** 加载更早一页（100 条）前插合并；loading 中重入跳过；网络错误静默（保持可重试） */
export async function loadOlderMessages(sessionId: string, oldestId: string): Promise<void> {
  const current = store.get().bySession[sessionId] ?? EMPTY;
  if (current.loading) return;
  patch(sessionId, { loading: true });
  try {
    const page = await api.messagesPage(sessionId, oldestId, 100);
    const latest = store.get().bySession[sessionId] ?? EMPTY;
    patch(sessionId, { older: [...page.messages, ...latest.older], hasMore: page.hasMore, loading: false });
  } catch {
    // 网络错误静默处理——loading 复位后用户可重试
    patch(sessionId, { loading: false });
  }
}

/** resync.required：清空该会话分页缓存（可能已过期） */
export function clearOlderMessages(sessionId: string): void {
  store.set((previous) => {
    if (!(sessionId in previous.bySession)) return {};
    const { [sessionId]: _removed, ...remaining } = previous.bySession;
    return { bySession: remaining };
  });
}
