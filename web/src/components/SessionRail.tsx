import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { Session } from "../lib/contracts";
import type { Theme } from "../theme";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 380;
export const clampRailWidth = (value: number): number => Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, value));

export function SessionRail({ sessions, currentId, runningIds, theme, collapsed, width, onSelect, onCreate, onDelete, onImport, onToggleTheme, onToggleCollapsed, onOpenSettings, onResize }: {
  sessions?: Session[];
  currentId?: string;
  runningIds: Set<string>;
  theme: Theme;
  collapsed: boolean;
  width: number;
  onSelect(id: string): void;
  onCreate(): void;
  onDelete(id: string): void;
  onImport(file: File): void;
  onToggleTheme(): void;
  onToggleCollapsed(): void;
  onOpenSettings(): void;
  onResize(width: number): void;
}): ReactElement {
  const { language, t } = useI18n();
  const [filter, setFilter] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const keyword = filter.trim().toLowerCase();
  const filtered = sessions?.filter((session) =>
    !keyword || `${session.title} ${session.provider} ${session.model}`.toLowerCase().includes(keyword));

  // 右缘拖拽调宽；键盘 ArrowLeft/Right 每次 16px
  const startDrag = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move: MouseEvent): void => onResize(clampRailWidth(startWidth + move.clientX - startX));
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside className={`session-rail${collapsed ? " collapsed" : ""}`} aria-label={t("会话", "Sessions")}>
      {!collapsed && (
        <button
          className="rail-resize"
          aria-label={t("调整会话栏宽度（方向键左右）", "Resize session rail (use arrow keys)")}
          onMouseDown={startDrag}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") onResize(clampRailWidth(width + 16));
            if (event.key === "ArrowLeft") onResize(clampRailWidth(width - 16));
          }}
        />
      )}
      <header>
        <span className="rail-mobile-title">{t("会话", "Sessions")}</span>
        {!collapsed && <span className="brand">Open<b>WebCode</b></span>}
        <input
          ref={fileInput}
          type="file"
          accept=".jsonl,.ndjson,.txt,application/x-ndjson"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onImport(file);
            event.target.value = "";
          }}
        />
        <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label={t("导入会话", "Import session")} title={t("导入会话（JSONL）", "Import session (JSONL)")}><Icon name="upload" size={15} /></button>
        <button className="icon-btn" onClick={onCreate} aria-label={t("新建会话", "New session")} title={t("新建会话", "New session")}><Icon name="plus" size={16} /></button>
      </header>
      {!collapsed && (
        <span className="rail-search-wrap">
          <Icon name="search" size={13} />
          <input
            className="rail-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFilter("");
            }}
            placeholder={t("搜索会话", "Search sessions")}
            aria-label={t("搜索会话", "Search sessions")}
          />
        </span>
      )}
      {!collapsed && (
        <nav>
          {filtered?.map((session) => (
            <div key={session.id} className={`session-item${session.id === currentId ? " active" : ""}`}>
              <button className="session-link" onClick={() => onSelect(session.id)}>
                <span className="session-title">{session.title}</span>
                <span className="session-meta">{session.provider} · {session.model}</span>
              </button>
              {runningIds.has(session.id) && <span className="running-dot" role="status" aria-label={t("运行中", "Running")} title={t("运行中", "Running")} />}
              <button
                className="session-export"
                aria-label={t(`导出分享页 ${session.title}`, `Export share page for ${session.title}`)}
                title={t("导出分享页（HTML）", "Export share page (HTML)")}
                onClick={() => window.open(`/api/sessions/${session.id}/export.html?lang=${language}`, "_blank")}
              >
                <Icon name="download" size={13} />
              </button>
              <button
                className="session-delete"
                aria-label={t(`删除会话 ${session.title}`, `Delete session ${session.title}`)}
                title={t("删除会话", "Delete session")}
                onClick={() => onDelete(session.id)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
          {sessions === undefined && <p className="rail-empty">{t("加载中…", "Loading…")}</p>}
          {sessions && sessions.length === 0 && <p className="rail-empty">{t("还没有会话", "No sessions yet")}</p>}
          {sessions && sessions.length > 0 && filtered?.length === 0 && <p className="rail-empty">{t("无匹配会话", "No matching sessions")}</p>}
        </nav>
      )}
      <footer>
        <button className="icon-btn" onClick={onToggleTheme} aria-label={t("切换主题", "Toggle theme")} title={t("切换主题", "Toggle theme")}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} aria-label={t("设置", "Settings")} title={t("设置", "Settings")}><Icon name="settings" size={15} /></button>
        <button
          className="icon-btn collapse-btn"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? t("展开会话栏", "Expand session rail") : t("收起会话栏", "Collapse session rail")}
          title={collapsed ? t("展开会话栏", "Expand session rail") : t("收起会话栏", "Collapse session rail")}
        >
          <Icon name={collapsed ? "chevrons-right" : "chevrons-left"} size={15} />
        </button>
      </footer>
    </aside>
  );
}
