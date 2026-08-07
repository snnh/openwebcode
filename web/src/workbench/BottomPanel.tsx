import type { ReactElement } from "react";

/** 底部面板（context/timeline/subagents/sandbox/cost/perf/eval 页签 + 状态项）。占位（Phase 2 Agent F 替换），props 形状固定。 */
export interface BottomPanelProps {
  sessionId?: string | undefined;
  agentState?: string | undefined;
  mobile: boolean;
}

export function BottomPanel(_props: BottomPanelProps): ReactElement | null {
  return null;
}
