/**
 * 待回答卡（ask_user 交互卡 / 权限确认卡 / 计划审批卡）的展开记忆与手风琴规则。
 *
 * 主列（.wb-main）`overflow: hidden` 且不滚动，这些卡又是消息列表之外的兄弟节点：
 * 高度无上限时卡片底部（选项/提交按钮）与 Composer 会被直接裁掉且滚不到。护栏在 CSS
 * （.pending-zone / .pending-body 限高内滚），这里只负责「同时只展开一张 + 可收起 + 记忆」：
 * - 默认展开队列最早的未回答卡，其余收成一行摘要（点摘要即展开它、原展开卡自动收起）；
 * - 收起当前展开卡 = 把当前这批待回答卡全部收起（手风琴语义下再展开任意一张即可恢复）；
 * - 用户的选择按卡片 id 记在 sessionStorage（本会话有效，切标签/刷新不丢）；
 * - 新出现的卡（从未被收起过的 id）默认展开。
 */
import { useCallback, useMemo, useRef } from "react";
import { createStore, useStore } from "../../app/store";

/** 单个会话的展开记忆：open 为唯一展开的卡片 id；closed 为被用户收起过的卡片 id */
interface PendingSession {
  open?: string;
  closed: Record<string, true>;
}

export interface PendingCardsState {
  cards: Record<string, PendingSession>;
}

const STORAGE_KEY = "owc-pending-cards";

/** sessionStorage 反序列化（纯函数）：坏数据/旧版本格式一律按「无记忆」处理，不抛错 */
export function parsePendingCards(raw: string | null): PendingCardsState {
  if (!raw) return { cards: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { cards: {} };
    const cards = (parsed as { cards?: unknown }).cards;
    if (!cards || typeof cards !== "object" || Array.isArray(cards)) return { cards: {} };
    return { cards: cards as Record<string, PendingSession> };
  } catch {
    return { cards: {} };
  }
}

function load(): PendingCardsState {
  try {
    return parsePendingCards(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return { cards: {} };
  }
}

export const pendingCardsStore = createStore<PendingCardsState>(load());

function persist(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pendingCardsStore.get()));
  } catch {
    // 隐私模式/配额满：记忆失效不影响本会话内的展开状态
  }
}

/**
 * 当前应展开的卡片 id（纯函数，便于单测）：
 * 显式展开且未被收起 → 用它；否则取最早的「从未被收起过」的卡片；全被收起过 → undefined（全部收起）。
 */
export function resolveExpandedId(entry: PendingSession | undefined, ids: readonly string[]): string | undefined {
  if (entry?.open && ids.includes(entry.open) && !entry.closed[entry.open]) return entry.open;
  return ids.find((id) => !entry?.closed[id]);
}

/** 点击收起/展开后的新记忆（纯函数）：收起当前展开卡 = 收起整批；展开某张 = 只展开它 */
export function nextPendingSession(entry: PendingSession | undefined, ids: readonly string[], id: string): PendingSession {
  const closed = { ...entry?.closed };
  if (resolveExpandedId(entry, ids) === id) {
    for (const pending of ids) closed[pending] = true;
    return { closed };
  }
  delete closed[id];
  return { open: id, closed };
}

export const pendingCards = {
  /** 收起/展开某张卡（ids 为当前会话全部待回答卡片 id，稳定顺序） */
  toggle(sessionId: string, ids: readonly string[], id: string): void {
    pendingCardsStore.set((state) => ({
      cards: { ...state.cards, [sessionId]: nextPendingSession(state.cards[sessionId], ids, id) },
    }));
    persist();
  },
  /** 会话删除：清掉该会话记忆 */
  forgetSession(sessionId: string): void {
    pendingCardsStore.set((state) => {
      if (!(sessionId in state.cards)) return {};
      const { [sessionId]: _removed, ...remaining } = state.cards;
      return { cards: remaining };
    });
    persist();
  },
};

/**
 * 待回答卡内容区的高度上限（px）：可用高度的一半、视口 60vh、以及「扣掉消息列表保底
 * （120px）与顶栏/输入栏（约 180px）后剩下的高度」三者取小，再兜底 120px。
 * 三者取小保证即使视口很矮也不会把列表或 Composer 挤出可视区（主列不滚动，超出即裁切）。
 */
export function pendingBodyMaxHeight(workbenchHeight: number, viewportHeight: number): number {
  const spare = workbenchHeight - PENDING_LIST_FLOOR - PENDING_CHROME_RESERVE;
  return Math.max(120, Math.min(workbenchHeight * 0.5, viewportHeight * 0.6, spare));
}

/** 消息列表保底高度（px）：卡片再高也保留约 3 行上下文 */
export const PENDING_LIST_FLOOR = 120;
/** 顶栏 + 标签条 + Composer 的预留高度（px），用于算卡片上限 */
export const PENDING_CHROME_RESERVE = 180;

export interface PendingAccordion {
  /** 当前展开的卡片 id；undefined 表示全部收起 */
  expandedId: string | undefined;
  isExpanded(id: string): boolean;
  toggle(id: string): void;
}

/** React 绑定：某会话待回答卡的展开状态（ids 需稳定引用，顺序即「队列最早在前」） */
export function usePendingAccordion(sessionId: string, ids: readonly string[]): PendingAccordion {
  const entry = useStore(pendingCardsStore, (state) => state.cards[sessionId]);
  const expandedId = useMemo(() => resolveExpandedId(entry, ids), [entry, ids]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const toggle = useCallback((id: string): void => pendingCards.toggle(sessionId, idsRef.current, id), [sessionId]);
  return {
    expandedId,
    isExpanded: (id: string) => id === expandedId,
    toggle,
  };
}
