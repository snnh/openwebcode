import { useEffect } from "react";
import { createStore, useStore } from "../app/store";
import { api } from "../lib/api";
import type { ChatMessage } from "../lib/contracts";

/**
 * 历史消息向上分页（更早消息按会话键控缓存；resync 时由事件路由清理）。
 * 状态存于模块级 store，MessageList/ChatView 经 useOlderMessages 订阅。
 *
 * 资源占用收敛：向上翻页加载的是「已经不在详情尾部窗口里的历史」，此前按会话永久保留
 * （只在 resync / 删除会话时清），会话开得多 + 各自翻过历史后会持续吃内存。现在两条上限：
 * - 单会话条数上限（保留最近加载的部分，超出的最旧部分从视图释放）；
 * - 全局会话数上限（按最近使用 LRU，超出整体释放最久未用的会话分页缓存）。
 *
 * 翻页游标（cursor）与消息数组解耦：截断丢弃了最旧消息后，游标仍是「已加载的最早一条」，
 * 于是继续向前翻页不会回退重复请求、也不会因截断把 hasMore 反复置真——曾经那样做会让
 * 「一直点加载更早」变成翻不到头的死循环（browser 渲染基准的翻页收敛检查抓到）。
 */

/** 单会话保留的已加载更早消息条数上限（约 20 页；超出部分从视图释放，仍可继续向前翻） */
export const PAGINATION_MAX_MESSAGES = 2000;
/** 同时保留分页缓存的会话数上限（LRU） */
export const PAGINATION_MAX_SESSIONS = 10;

interface OlderMessagesState {
  older: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  /** 下次翻页的 before 游标（已加载的最早消息 id）；截断消息不改变它 */
  cursor?: string;
}

const EMPTY: OlderMessagesState = { older: [], hasMore: false, loading: false };

interface PaginationState {
  bySession: Record<string, OlderMessagesState>;
}

const store = createStore<PaginationState>({ bySession: {} });

/**
 * 截断某会话的已加载历史：保留最近 limit 条（游标与 hasMore 原样保留——
 * 前者保证还能继续向前翻，后者只由服务端响应决定，避免翻页不收敛）。
 */
export function trimOlderMessages(state: OlderMessagesState, limit: number = PAGINATION_MAX_MESSAGES): OlderMessagesState {
  if (state.older.length <= limit) return state;
  return { ...state, older: state.older.slice(state.older.length - limit) };
}

/** 全局 LRU：只保留最近使用的 limit 个会话的分页缓存（recency 顺序为最旧→最新） */
export function pruneSessionCaches(
  bySession: Record<string, OlderMessagesState>,
  recency: readonly string[],
  limit: number = PAGINATION_MAX_SESSIONS,
): Record<string, OlderMessagesState> {
  const keep = new Set(recency.slice(-limit));
  const next: Record<string, OlderMessagesState> = {};
  let dropped = false;
  for (const [sessionId, entry] of Object.entries(bySession)) {
    if (keep.has(sessionId)) next[sessionId] = entry;
    else dropped = true;
  }
  return dropped ? next : bySession;
}

/** 最近使用顺序（最旧在前）：每次读写某会话都移到末尾 */
const recency: string[] = [];

function touch(sessionId: string): void {
  const index = recency.indexOf(sessionId);
  if (index >= 0) recency.splice(index, 1);
  recency.push(sessionId);
}

function patch(sessionId: string, partial: Partial<OlderMessagesState>): void {
  touch(sessionId);
  store.set((previous) => {
    const merged = trimOlderMessages({ ...(previous.bySession[sessionId] ?? EMPTY), ...partial });
    return {
      bySession: pruneSessionCaches({ ...previous.bySession, [sessionId]: merged }, recency),
    };
  });
}

/** 订阅某会话的分页状态（未知会话返回共享空态，引用稳定；读取即视为「最近使用」） */
export function useOlderMessages(sessionId: string | undefined): OlderMessagesState {
  useEffect(() => {
    if (sessionId) touch(sessionId);
  }, [sessionId]);
  return useStore(store, (state) => (sessionId ? state.bySession[sessionId] : undefined) ?? EMPTY);
}

/** 加载更早一页（100 条）前插合并；loading 中重入跳过；网络错误静默（保持可重试） */
export async function loadOlderMessages(sessionId: string, oldestId: string): Promise<void> {
  const current = store.get().bySession[sessionId] ?? EMPTY;
  if (current.loading) return;
  // 优先用保留游标：截断后列表里的「最旧一条」会变新，用它会让翻页回退重复请求
  const before = current.cursor ?? oldestId;
  patch(sessionId, { loading: true });
  try {
    const page = await api.messagesPage(sessionId, before, 100);
    const latest = store.get().bySession[sessionId] ?? EMPTY;
    patch(sessionId, {
      older: [...page.messages, ...latest.older],
      hasMore: page.hasMore,
      cursor: page.messages[0]?.id ?? before,
      loading: false,
    });
  } catch {
    // 网络错误静默处理——loading 复位后用户可重试
    patch(sessionId, { loading: false });
  }
}

/** resync.required：清空该会话分页缓存（可能已过期） */
export function clearOlderMessages(sessionId: string): void {
  const index = recency.indexOf(sessionId);
  if (index >= 0) recency.splice(index, 1);
  store.set((previous) => {
    if (!(sessionId in previous.bySession)) return {};
    const { [sessionId]: _removed, ...remaining } = previous.bySession;
    return { bySession: remaining };
  });
}
