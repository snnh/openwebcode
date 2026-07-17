import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { Session } from "../lib/contracts";
import type { Theme } from "../theme";
import { Icon } from "./Icon";

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
    <aside className={`session-rail${collapsed ? " collapsed" : ""}`} aria-label="会话">
      {!collapsed && (
        <button
          className="rail-resize"
          aria-label="调整会话栏宽度（方向键左右）"
          onMouseDown={startDrag}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") onResize(clampRailWidth(width + 16));
            if (event.key === "ArrowLeft") onResize(clampRailWidth(width - 16));
          }}
        />
      )}
      <header>
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
        <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="导入会话" title="导入会话（JSONL）"><Icon name="upload" size={15} /></button>
        <button className="icon-btn" onClick={onCreate} aria-label="新建会话" title="新建会话"><Icon name="plus" size={16} /></button>
      </header>
      {!collapsed && (
        <span className="rail-search-wrap">
          <Icon name="search" size={13} />
          <input
            className="rail-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
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
              {runningIds.has(session.id) && <span className="running-dot" role="status" aria-label="运行中" title="运行中" />}
              <button
                className="session-delete"
                aria-label={`删除会话 ${session.title}`}
                title="删除会话"
                onClick={() => onDelete(session.id)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
          {sessions && sessions.length === 0 && <p className="rail-empty">还没有会话</p>}
          {sessions && sessions.length > 0 && filtered?.length === 0 && <p className="rail-empty">无匹配会话</p>}
        </nav>
      )}
      <footer>
        <button className="icon-btn" onClick={onToggleTheme} aria-label="切换主题" title="切换主题">
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} aria-label="设置" title="设置"><Icon name="settings" size={15} /></button>
        <button
          className="icon-btn collapse-btn"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "展开会话栏" : "收起会话栏"}
          title={collapsed ? "展开会话栏" : "收起会话栏"}
        >
          <Icon name={collapsed ? "chevrons-right" : "chevrons-left"} size={15} />
        </button>
      </footer>
    </aside>
  );
}
