import type { ReactElement } from "react";
import type { Session } from "../lib/contracts";

/** 侧栏视图容器（sessions/files/scm/problems 切换）。占位（Phase 2 Agent E 替换为真实实现），props 形状固定。 */
export interface SidebarViewsProps {
  sessions?: Session[] | undefined;
  currentId?: string | undefined;
  agentStates: Record<string, string>;
  onSelectSession(id: string): void;
}

export function SidebarViews(_props: SidebarViewsProps): ReactElement | null {
  return null;
}
