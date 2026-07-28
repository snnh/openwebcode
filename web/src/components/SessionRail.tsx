import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { Session } from "../lib/contracts";
import type { Theme } from "../theme";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 380;
export const clampRailWidth = (value: number): number => Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, value));

export function SessionRail({ sessions, currentId, runningIds, theme, collapsed, width, onSelect, onCreate, onDelete, onRename, onTogglePin, onImport, onToggleTheme, onToggleCollapsed, onOpenSettings, onResize }: {
  sessions?: Session[];
  currentId?: string;
  runningIds: Set<string>;
  theme: Theme;
  collapsed: boolean;
  width: number;
  onSelect(id: string): void;
  onCreate(): void;
  onDelete(id: string): void;
  /** 重命名提交（仅在用户编辑过且 trim 后有变化时调用；空串表示清除标题覆盖，服务端回落派生标题） */
  onRename(id: string, title: string): void;
  onTogglePin(id: string, pinned: boolean): void;
  onImport(file: File): void;
  onToggleTheme(): void;
  onToggleCollapsed(): void;
  onOpenSettings(): void;
  onResize(width: number): void;
}): ReactElement {
  const { language, t } = useI18n();
  const [filter, setFilter] = useState("");
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [renameDraft, setRenameDraft] = useState("");
  // 用户是否真正编辑过草稿：区分「清空以清除标题覆盖」与「未改动直接提交」
  const renameEdited = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const keyword = filter.trim().toLowerCase();
  const filtered = sessions?.filter((session) =>
    !keyword || `${session.title} ${session.provider} ${session.model}`.toLowerCase().includes(keyword));
  // 置顶优先，组内保持服务端 updatedAt 降序（稳定排序）
  const ordered = filtered && [...filtered].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));

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

  const startRename = (session: Session): void => {
    setRenamingId(session.id);
    setRenameDraft(session.title);
    renameEdited.current = false;
  };
  const commitRename = (session: Session): void => {
    const title = renameDraft.trim();
    const edited = renameEdited.current;
    setRenamingId(undefined);
    renameEdited.current = false;
    if (!edited || title === session.title) return;
    // 清空提交发送空串：服务端清除标题覆盖并回落到派生标题
    onRename(session.id, title);
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
          {ordered?.map((session) => (
            <div key={session.id} className={`session-item${session.id === currentId ? " active" : ""}`}>
              {renamingId === session.id ? (
                <input
                  className="session-rename"
                  value={renameDraft}
                  maxLength={120}
                  autoFocus
                  aria-label={t("重命名会话", "Rename session")}
                  onChange={(event) => { renameEdited.current = true; setRenameDraft(event.target.value); }}
                  onBlur={() => commitRename(session)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename(session);
                    if (event.key === "Escape") setRenamingId(undefined);
                  }}
                />
              ) : (
                <>
                  <button
                    className="session-link"
                    onClick={() => onSelect(session.id)}
                    onDoubleClick={() => startRename(session)}
                    title={session.title}
                  >
                    <span className="session-title">{session.title}</span>
                    <span className="session-meta">{session.provider} · {session.model}</span>
                  </button>
                  {runningIds.has(session.id) && <span className="running-dot" role="status" aria-label={t("运行中", "Running")} title={t("运行中", "Running")} />}
                  <button
                    className={`session-pin${session.pinned ? " active" : ""}`}
                    aria-label={session.pinned ? t(`取消置顶 ${session.title}`, `Unpin ${session.title}`) : t(`置顶 ${session.title}`, `Pin ${session.title}`)}
                    aria-pressed={session.pinned ?? false}
                    title={session.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
                    onClick={() => onTogglePin(session.id, !(session.pinned ?? false))}
                  >
                    <Icon name="pin" size={13} />
                  </button>
                  <button
                    className="session-rename-btn"
                    aria-label={t(`重命名 ${session.title}`, `Rename ${session.title}`)}
                    title={t("重命名", "Rename")}
                    onClick={() => startRename(session)}
                  >
                    <Icon name="edit" size={13} />
                  </button>
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
                </>
              )}
            </div>
          ))}
          {sessions === undefined && <p className="rail-empty">{t("加载中…", "Loading…")}</p>}
          {sessions && sessions.length === 0 && <p className="rail-empty">{t("还没有会话", "No sessions yet")}</p>}
          {sessions && sessions.length > 0 && ordered?.length === 0 && <p className="rail-empty">{t("无匹配会话", "No matching sessions")}</p>}
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
