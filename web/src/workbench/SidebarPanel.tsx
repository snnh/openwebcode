/**
 * 侧边栏面板容器（0.4.0 Phase 5a）：文件 / 源代码管理 / 问题视图的承载。
 * 会话视图直接复用 SessionRail（自带宽度拖拽与页脚），不经过本组件。
 * 面板各自懒加载，仅打开时拉取 chunk。
 */
import { lazy, Suspense, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { SessionDetail } from "../lib/contracts";
import { useI18n } from "../i18n";
import type { SidebarView } from "./useWorkbenchLayout";
import type { DiffSpec } from "../components/editor/DiffPane";

const FilesPanel = lazy(() => import("../components/panels/FilesPanel").then((m) => ({ default: m.FilesPanel })));
const ScmPanel = lazy(() => import("../components/panels/ScmPanel").then((m) => ({ default: m.ScmPanel })));
const ProblemsPanel = lazy(() => import("../components/panels/ProblemsPanel").then((m) => ({ default: m.ProblemsPanel })));

const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const clampWidth = (value: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));

const TITLES: Record<string, [string, string]> = {
  files: ["文件", "Files"],
  scm: ["源代码管理", "Source Control"],
  problems: ["问题", "Problems"],
};

export function SidebarPanel({ view, width, onResize, sessionId, session, running, onNotice, onOpenInEditor, onOpenDiff }: {
  view: Exclude<SidebarView, "sessions">;
  width: number;
  onResize(width: number): void;
  sessionId?: string;
  session?: SessionDetail;
  running: boolean;
  onNotice(message: string, kind?: "info" | "error"): void;
  /** 0.5.0 Phase 1a：Problems 跳转升级为编辑器分栏；未提供时面板保持只读预览 */
  onOpenInEditor?(file: string, line?: number, column?: number): void;
  /** 0.5.0 Phase 1b：SCM 文件 diff 一键在统一 diff 视图中打开（hunk 级接受/拒绝） */
  onOpenDiff?(spec: DiffSpec): void;
}): ReactElement {
  const { t } = useI18n();

  // 右缘拖拽调宽；键盘 ArrowLeft/Right 每次 16px（与 SessionRail 一致）
  const startDrag = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move: MouseEvent): void => onResize(clampWidth(startWidth + move.clientX - startX));
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const title = TITLES[view] ?? [view, view];
  return (
    <aside className="sidebar-panel" aria-label={t(title[0], title[1])} style={{ width }}>
      <button
        className="rail-resize"
        aria-label={t("调整侧栏宽度（方向键左右）", "Resize sidebar (use arrow keys)")}
        onMouseDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") onResize(clampWidth(width + 16));
          if (event.key === "ArrowLeft") onResize(clampWidth(width - 16));
        }}
      />
      <header className="sidebar-panel-header"><h2>{t(title[0], title[1])}</h2></header>
      <div className="sidebar-panel-body">
        <Suspense fallback={null}>
          {view === "files" && <FilesPanel sessionId={sessionId} session={session} running={running} onNotice={onNotice} onOpenInEditor={onOpenInEditor} />}
          {view === "scm" && <ScmPanel sessionId={sessionId} onNotice={onNotice} onOpenDiff={onOpenDiff} />}
          {view === "problems" && <ProblemsPanel sessionId={sessionId} onOpenInEditor={onOpenInEditor} />}
        </Suspense>
      </div>
    </aside>
  );
}
