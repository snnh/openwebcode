import { useCallback, useState } from "react";

/**
 * 主区终端标签（按会话隔离）：每会话最多一个终端标签，记录开/关与选中态。
 * 选中互斥由调用方协调（选终端时清除子代理选中，反之亦然）。
 */
export interface UseTerminalTabsResult {
  /** sessionId → 终端标签是否打开 */
  openBySession: Record<string, boolean>;
  /** sessionId → 终端标签是否选中（仅打开时有意义） */
  selectedBySession: Record<string, boolean>;
  /** 打开并选中该会话的终端标签（活动栏入口） */
  openTerminal(sessionId: string): void;
  /** 设置选中态（点击标签选中；选中主对话/子代理标签时传 false 取消） */
  setTerminalSelected(sessionId: string, selected: boolean): void;
  /** 关闭终端标签（回主对话） */
  closeTerminal(sessionId: string): void;
  removeSession(sessionId: string): void;
}

export function useTerminalTabs(): UseTerminalTabsResult {
  const [openBySession, setOpenBySession] = useState<Record<string, boolean>>({});
  const [selectedBySession, setSelectedBySession] = useState<Record<string, boolean>>({});

  const openTerminal = useCallback((sessionId: string): void => {
    setOpenBySession((previous) => (previous[sessionId] ? previous : { ...previous, [sessionId]: true }));
    setSelectedBySession((previous) => ({ ...previous, [sessionId]: true }));
  }, []);

  const setTerminalSelected = useCallback((sessionId: string, selected: boolean): void => {
    setSelectedBySession((previous) => {
      if (selected) return previous[sessionId] ? previous : { ...previous, [sessionId]: true };
      if (!(sessionId in previous)) return previous;
      const { [sessionId]: _cleared, ...remaining } = previous;
      return remaining;
    });
  }, []);

  const closeTerminal = useCallback((sessionId: string): void => {
    setOpenBySession((previous) => {
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

  const removeSession = useCallback((sessionId: string): void => {
    setOpenBySession((previous) => {
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

  return { openBySession, selectedBySession, openTerminal, setTerminalSelected, closeTerminal, removeSession };
}
