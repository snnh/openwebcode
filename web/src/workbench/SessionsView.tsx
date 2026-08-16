/**
 * 完整会话轨（侧栏 sessions 视图）：搜索过滤、置顶排序、运行点、选中态、
 * 内联重命名、置顶/删除/导出/导入、主题切换、设置入口、新建会话。
 * 动作直连 ui store 与 api（删除走 ui.setDeleteTarget 确认框，新建走 ui.setNewSessionOpen）。
 */
import { useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "../lib/contracts";
import { api } from "../lib/api";
import { isBusyState } from "../lib/agent-state";
import { qk } from "../app/queries";
import { ui } from "../app/ui-store";
import { useSessionDefaults } from "../app/prefs-store";
import { useTheme } from "../theme";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";

interface SessionsViewProps {
  /** undefined 表示仍在加载 */
  sessions?: Session[] | undefined;
  currentId?: string | undefined;
  /** 按会话键控的 agent 运行态（session-store.agentStates） */
  agentStates: Record<string, string>;
  onSelect(id: string): void;
}

export function SessionsView({ sessions, currentId, agentStates, onSelect }: SessionsViewProps): ReactElement {
  const { language, t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const queryClient = useQueryClient();
  const defaults = useSessionDefaults();
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

  // 一键本机会话：cwd=HOME、sandboxMode=off（命令直跑宿主机、env 跟随 server），
  // HOME 外的文件工具路径由服务端审批门拦下，需用户允许。provider/model 用会话默认。
  const createLocalSession = (): void => {
    if (!defaults.provider || !defaults.model) {
      ui.notify(t("请先在设置中配置默认模型（或使用新建会话对话框）", "Configure a default model in settings first (or use the new-session dialog)"), "error");
      ui.setNewSessionOpen(true);
      return;
    }
    api.createSession({ kind: "local", provider: defaults.provider, model: defaults.model })
      .then((session) => {
        ui.notify(t("已创建本机会话", "Local session created"));
        ui.selectSession(session.id);
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
      })
      .catch((error: unknown) => {
        ui.notify(error instanceof Error ? error.message : t("创建会话失败", "Could not create session"), "error");
      });
  };

  // 重命名/置顶：PATCH 后刷新会话列表（与当前详情，若是当前会话）
  const patchSession = (id: string, body: { title?: string; pinned?: boolean }): void => {
    api.patchSession(id, body)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
        if (id === currentId) void queryClient.invalidateQueries({ queryKey: qk.session(id) });
      })
      .catch((error: unknown) => {
        ui.notify(error instanceof Error ? error.message : t("更新会话失败", "Could not update session"), "error");
      });
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
    patchSession(session.id, { title });
  };

  // 导入 JSONL/NDJSON 会话：成功后选中导入的会话并刷新列表
  const importFile = (file: File): void => {
    file.text()
      .then((text) => api.importSession(text))
      .then((session) => {
        ui.notify(t(`已导入会话「${session.title}」`, `Imported session “${session.title}”`));
        ui.selectSession(session.id);
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
      })
      .catch((error: unknown) => {
        ui.notify(error instanceof Error ? error.message : t("导入失败", "Import failed"), "error");
      });
  };

  return (
    <aside className="sessions-view" aria-label={t("会话", "Sessions")}>
      <header>
        <span className="brand">Open<b>WebCode</b></span>
        <input
          ref={fileInput}
          type="file"
          accept=".jsonl,.ndjson,.txt,application/x-ndjson"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importFile(file);
            event.target.value = "";
          }}
        />
        <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label={t("导入会话", "Import session")} title={t("导入会话（JSONL）", "Import session (JSONL)")}><Icon name="upload" size={15} /></button>
        <button className="icon-btn" onClick={() => ui.setNewSessionOpen(true)} aria-label={t("新建会话", "New session")} title={t("新建会话", "New session")}><Icon name="plus" size={16} /></button>
        <button className="icon-btn" onClick={createLocalSession} aria-label={t("新建本机会话", "New local session")} title={t("本机会话：在 HOME 下直跑宿主机，HOME 外路径需允许", "Local session: runs on the host under HOME; paths outside HOME require approval")}><Icon name="terminal" size={15} /></button>
      </header>
      <span className="rail-search-wrap">
        <Icon name="search" size={13} />
        <input
          className="input rail-search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFilter("");
          }}
          placeholder={t("搜索会话", "Search sessions")}
          aria-label={t("搜索会话", "Search sessions")}
        />
      </span>
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
                <div className="session-actions">
                  {isBusyState(agentStates[session.id]) && <span className="running-dot" role="status" aria-label={t("运行中", "Running")} title={t("运行中", "Running")} />}
                  <button
                    className={`session-pin${session.pinned ? " active" : ""}`}
                    aria-label={session.pinned ? t(`取消置顶 ${session.title}`, `Unpin ${session.title}`) : t(`置顶 ${session.title}`, `Pin ${session.title}`)}
                    aria-pressed={session.pinned ?? false}
                    title={session.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
                    onClick={() => patchSession(session.id, { pinned: !(session.pinned ?? false) })}
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
                    onClick={() => ui.setDeleteTarget(session.id)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {sessions === undefined && <p className="muted-empty rail-empty">{t("加载中…", "Loading…")}</p>}
        {sessions !== undefined && sessions.length === 0 && <p className="muted-empty rail-empty">{t("还没有会话", "No sessions yet")}</p>}
        {sessions !== undefined && sessions.length > 0 && ordered?.length === 0 && <p className="muted-empty rail-empty">{t("无匹配会话", "No matching sessions")}</p>}
      </nav>
      <footer>
        <button className="icon-btn" onClick={toggleTheme} aria-label={t("切换主题", "Toggle theme")} title={t("切换主题", "Toggle theme")}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
        </button>
        <button className="icon-btn" onClick={() => ui.openSettings()} aria-label={t("设置", "Settings")} title={t("设置", "Settings")}><Icon name="settings" size={15} /></button>
      </footer>
    </aside>
  );
}
