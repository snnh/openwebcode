import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import type { Session } from "../lib/contracts";
import { useStore } from "../app/store";
import { useI18n } from "../i18n";
import { layout, layoutStore, type SidebarView } from "./layout";
import { SessionsView } from "./SessionsView";
import { FilesView } from "./sidebar/FilesView";
import { ScmView } from "./sidebar/ScmView";
import { ProblemsView } from "./sidebar/ProblemsView";

/** 侧栏视图容器：按 layoutStore.sidebarView 切换 sessions/files/scm/problems，
 *  含非会话视图的标题栏与四视图共用的右缘宽度拖拽柄（layout.setSidebarWidth）。 */
interface SidebarViewsProps {
  sessions?: Session[] | undefined;
  currentId?: string | undefined;
  agentStates: Record<string, string>;
  onSelectSession(id: string): void;
}

const VIEW_TITLES: Record<Exclude<SidebarView, "sessions">, [string, string]> = {
  files: ["文件", "Files"],
  scm: ["源代码管理", "Source Control"],
  problems: ["问题", "Problems"],
};

export function SidebarViews({ sessions, currentId, agentStates, onSelectSession }: SidebarViewsProps): ReactElement {
  const { t } = useI18n();
  const view = useStore(layoutStore, (state) => state.sidebarView);
  const width = useStore(layoutStore, (state) => state.sidebarWidth);

  // 右缘拖拽调宽；键盘 ArrowLeft/Right 每次 16px（宽度钳制在 layout 内完成）
  const startDrag = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move: MouseEvent): void => layout.setSidebarWidth(startWidth + move.clientX - startX);
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const title = view === "sessions" ? undefined : VIEW_TITLES[view];
  return (
    <div className="sidebar-views">
      <button
        className="rail-resize"
        aria-label={t("调整侧栏宽度（方向键左右）", "Resize sidebar (use arrow keys)")}
        onMouseDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") layout.setSidebarWidth(width + 16);
          if (event.key === "ArrowLeft") layout.setSidebarWidth(width - 16);
        }}
      />
      {view === "sessions" ? (
        <SessionsView sessions={sessions} currentId={currentId} agentStates={agentStates} onSelect={onSelectSession} />
      ) : (
        <>
          <header className="sidebar-views-header"><h2>{t(title?.[0] ?? "", title?.[1] ?? "")}</h2></header>
          <div className="sidebar-views-body">
            {view === "files" && <FilesView sessionId={currentId} />}
            {view === "scm" && <ScmView sessionId={currentId} />}
            {view === "problems" && <ProblemsView sessionId={currentId} />}
          </div>
        </>
      )}
    </div>
  );
}
