/**
 * 完整会话轨（侧栏 sessions 视图）：搜索过滤、手工标签组、归档分区、多选批量、
 * 置顶排序、运行点、待回答角标、选中态、内联重命名、置顶/删除/导出/导入、
 * 主题切换、设置入口、新建会话。
 *
 * 组织规则（分组/归档/排序）在 workbench/session-groups.ts（纯函数），这里只做交互与渲染；
 * 分组与归档状态存服务端会话 meta（PATCH /api/sessions/:id），跨浏览器一致。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "../lib/contracts";
import { api } from "../lib/api";
import { isBusyState } from "../lib/agent-state";
import { qk } from "../app/queries";
import { ui } from "../app/ui-store";
import {
  filterSessions, groupNames, groupSessions, readCollapsedGroups,
  SESSION_GROUPS_COLLAPSED_KEY, splitArchived,
} from "./session-groups";
import type { AttentionCounts } from "../app/session-store";
import { useSessionDefaults } from "../app/prefs-store";
import { useTheme } from "../theme";
import { Icon } from "../components/Icon";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useI18n } from "../i18n";

interface SessionsViewProps {
  /** undefined 表示仍在加载 */
  sessions?: Session[] | undefined;
  currentId?: string | undefined;
  /** 按会话键控的 agent 运行态（session-store.agentStates） */
  agentStates: Record<string, string>;
  /** 按会话键控的待回答计数（session-store.attention）：别的会话在等你回答时也给提示 */
  attention: Record<string, AttentionCounts>;
  onSelect(id: string): void;
}

/** 待回答角标文案：权限与提问分别计数（如「等你回答 2」「待批准 1」），hover 给完整说明 */
function attentionLabel(counts: AttentionCounts, t: (chinese: string, english: string) => string): string {
  const parts: string[] = [];
  if (counts.permissions > 0) parts.push(t(`待批准 ${counts.permissions}`, `${counts.permissions} to approve`));
  if (counts.interactions > 0) parts.push(t(`待回答 ${counts.interactions}`, `${counts.interactions} to answer`));
  return parts.join(" · ");
}

/** 批量操作（多选模式下生效） */
type BulkAction = "delete" | "archive" | "unarchive" | "pin" | "unpin";

export function SessionsView({ sessions, currentId, agentStates, attention, onSelect }: SessionsViewProps): ReactElement {
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
  // 折叠记忆：组名 / "archived"（已归档区）/ "ungrouped"（未分组区）；默认只收起已归档
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readCollapsedGroups()));
  const [renamingGroup, setRenamingGroup] = useState<string | undefined>();
  const [groupDraft, setGroupDraft] = useState("");
  // 多选批量：selection 只存 id，退出多选即清空
  const [multiSelect, setMultiSelect] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  // 「移动到组」下拉当前打开的会话，以及新建组输入
  const [moveMenuId, setMoveMenuId] = useState<string | undefined>();
  const [newGroupDraft, setNewGroupDraft] = useState("");
  const [newGroupFor, setNewGroupFor] = useState<string | undefined>();
  const [bulkConfirm, setBulkConfirm] = useState<{ action: BulkAction; ids: string[] } | undefined>();
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [groupConfirm, setGroupConfirm] = useState<string | undefined>();

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_GROUPS_COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      // 隐私模式：折叠记忆失效不影响使用
    }
  }, [collapsed]);

  const matched = useMemo(() => filterSessions(sessions ?? [], filter), [sessions, filter]);
  const { active, archived } = useMemo(() => splitArchived(matched), [matched]);
  const { groups, ungrouped } = useMemo(() => groupSessions(active), [active]);
  const knownGroups = useMemo(() => groupNames(sessions ?? []), [sessions]);
  const allVisibleIds = useMemo(() => active.map((session) => session.id), [active]);

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

  // 显示属性变更（重命名/置顶/分组/归档）：PATCH 后刷新会话列表（与当前详情，若是当前会话）
  const patchSession = (id: string, body: { title?: string; pinned?: boolean; group?: string; archived?: boolean }): Promise<unknown> => {
    return api.patchSession(id, body)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
        if (id === currentId) void queryClient.invalidateQueries({ queryKey: qk.session(id) });
      })
      .catch((error: unknown) => {
        // 归档遇到「有活动」等服务端拒绝：提示原文（如「请先停止运行再归档」）。
        // 不再向上抛：调用点多为 fire-and-forget（onClick 里的 void），重抛只会变成
        // 浏览器 unhandledrejection，而用户侧提示已经给出。
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
    void patchSession(session.id, { title });
  };

  const toggleCollapsed = (key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelected = (id: string): void => {
    setSelection((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 批量 PATCH：逐个提交（服务端按会话串行），最后统一刷新一次列表 */
  const bulkPatch = (ids: string[], body: { pinned?: boolean; archived?: boolean; group?: string }): void => {
    Promise.allSettled(ids.map((id) => api.patchSession(id, body)))
      .then((results) => {
        const failed = results.filter((result) => result.status === "rejected");
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
        if (failed.length > 0) {
          const first = failed[0] as PromiseRejectedResult;
          ui.notify(first.reason instanceof Error ? first.reason.message : t("部分会话更新失败", "Some sessions could not be updated"), "error");
        }
        setSelection(new Set());
        setMoveMenuId(undefined);
      });
  };

  const bulkDelete = (ids: string[]): void => {
    Promise.allSettled(ids.map((id) => api.deleteSession(id)))
      .then((results) => {
        const deleted = results.filter((result) => result.status === "fulfilled").length;
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
        ui.notify(t(`已删除 ${deleted} 个会话`, `Deleted ${deleted} session(s)`));
        setSelection(new Set());
      });
  };

  const runBulk = (action: BulkAction, ids: string[]): void => {
    if (action === "delete") { setBulkConfirm({ action, ids }); return; }
    if (action === "archive") {
      // 归档只对「已停下」的会话生效：运行中的会被服务端 409 拒绝，这里先在客户端跳过并说明，
      // 免得选中一整批（含正在跑的）时弹出一串同样的错误
      const running = ids.filter((id) => isBusyState(agentStates[id]));
      const rest = ids.filter((id) => !isBusyState(agentStates[id]));
      if (running.length > 0) {
        ui.notify(t(`已跳过 ${running.length} 个仍在运行的会话（先停止再归档）`, `Skipped ${running.length} running session(s) — stop them before archiving`));
      }
      if (rest.length > 0) bulkPatch(rest, { archived: true });
      else setSelection(new Set());
      return;
    }
    if (action === "unarchive") bulkPatch(ids, { archived: false });
    else if (action === "pin") bulkPatch(ids, { pinned: true });
    else bulkPatch(ids, { pinned: false });
  };

  /** 删除分组 = 组内会话回到未分组（不删会话） */
  const deleteGroup = (name: string): void => {
    const ids = (sessions ?? []).filter((session) => session.group === name).map((session) => session.id);
    setGroupConfirm(undefined);
    Promise.allSettled(ids.map((id) => api.patchSession(id, { group: "" })))
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: qk.sessions });
        ui.notify(t(`已删除分组「${name}」，${ids.length} 个会话回到未分组`, `Deleted group “${name}”; ${ids.length} session(s) moved to Ungrouped`));
      });
  };

  const renameGroup = (from: string, to: string): void => {
    setRenamingGroup(undefined);
    const name = to.trim();
    if (!name || name === from) return;
    const ids = (sessions ?? []).filter((session) => session.group === from).map((session) => session.id);
    bulkPatch(ids, { group: name });
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

  /** 单个会话项（分组区、未分组区、已归档区共用；archived 区多一个「恢复」动作） */
  const renderSession = (session: Session, options: { archived?: boolean } = {}): ReactElement => (
    <div key={session.id} className={`session-item${session.id === currentId ? " active" : ""}${multiSelect ? " selecting" : ""}`}>
      {multiSelect && (
        <input
          type="checkbox"
          className="session-select"
          checked={selection.has(session.id)}
          onChange={() => toggleSelected(session.id)}
          aria-label={t(`选择会话 ${session.title}`, `Select session ${session.title}`)}
        />
      )}
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
            onClick={() => (multiSelect ? toggleSelected(session.id) : onSelect(session.id))}
            onDoubleClick={() => startRename(session)}
            title={session.title}
          >
            <span className="session-title">{session.title}</span>
            <span className="session-meta">{session.provider} · {session.model}</span>
          </button>
          {!multiSelect && (
            <div className="session-actions">
              {/* 待回答角标优先于「运行中」圆点：等你操作比「它在忙」更需要被看见 */}
              {(() => {
                const counts = attention[session.id];
                if (!counts) {
                  return isBusyState(agentStates[session.id])
                    ? <span className="running-dot" role="status" aria-label={t("运行中", "Running")} title={t("运行中", "Running")} />
                    : null;
                }
                const label = attentionLabel(counts, t);
                return (
                  <span className="attention-badge" role="status" title={t(`等待你操作：${label}`, `Waiting for you: ${label}`)}>
                    <Icon name="circle-filled" size={9} />
                    {counts.permissions + counts.interactions}
                  </span>
                );
              })()}
              {attention[session.id] && isBusyState(agentStates[session.id]) && (
                <span className="running-dot" role="status" aria-label={t("运行中", "Running")} title={t("运行中", "Running")} />
              )}
              {options.archived && (
                <button
                  className="session-unarchive"
                  aria-label={t(`取消归档 ${session.title}`, `Unarchive ${session.title}`)}
                  title={t("取消归档（回到默认列表）", "Unarchive (back to the default list)")}
                  onClick={() => void patchSession(session.id, { archived: false })}
                >
                  <Icon name="upload" size={13} />
                </button>
              )}
              {!options.archived && (
                <span className="session-move">
                  <button
                    type="button"
                    className="session-move-trigger"
                    aria-label={t(`移动到分组 ${session.title}`, `Move to group: ${session.title}`)}
                    aria-expanded={moveMenuId === session.id}
                    title={t("移动到分组", "Move to group")}
                    onClick={() => setMoveMenuId(moveMenuId === session.id ? undefined : session.id)}
                  >
                    <Icon name="folder" size={13} />
                  </button>
                  {moveMenuId === session.id && (
                    <ul className="session-move-menu" role="menu">
                      {knownGroups.filter((name) => name !== session.group).map((name) => (
                        <li key={name}>
                          <button type="button" role="menuitem" onClick={() => { setMoveMenuId(undefined); void patchSession(session.id, { group: name }); }}>{name}</button>
                        </li>
                      ))}
                      {session.group && (
                        <li>
                          <button type="button" role="menuitem" onClick={() => { setMoveMenuId(undefined); void patchSession(session.id, { group: "" }); }}>
                            {t("移出分组", "Remove from group")}
                          </button>
                        </li>
                      )}
                      <li className="session-move-new">
                        <input
                          className="input"
                          value={newGroupFor === session.id ? newGroupDraft : ""}
                          placeholder={t("新建分组…", "New group…")}
                          aria-label={t("新分组名", "New group name")}
                          maxLength={40}
                          onFocus={() => setNewGroupFor(session.id)}
                          onChange={(event) => { setNewGroupFor(session.id); setNewGroupDraft(event.target.value); }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            const name = newGroupDraft.trim();
                            if (!name) return;
                            setNewGroupDraft("");
                            setNewGroupFor(undefined);
                            setMoveMenuId(undefined);
                            void patchSession(session.id, { group: name });
                          }}
                        />
                      </li>
                    </ul>
                  )}
                </span>
              )}
              {!options.archived && (
                <button
                  className="session-archive"
                  aria-label={t(`归档 ${session.title}`, `Archive ${session.title}`)}
                  title={t("归档（移出默认列表；有运行时需先停止）", "Archive (out of the default list; stop the run first)")}
                  onClick={() => void patchSession(session.id, { archived: true })}
                >
                  <Icon name="archive" size={13} />
                </button>
              )}
              <button
                className={`session-pin${session.pinned ? " active" : ""}`}
                aria-label={session.pinned ? t(`取消置顶 ${session.title}`, `Unpin ${session.title}`) : t(`置顶 ${session.title}`, `Pin ${session.title}`)}
                aria-pressed={session.pinned ?? false}
                title={session.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
                onClick={() => void patchSession(session.id, { pinned: !(session.pinned ?? false) })}
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
          )}
        </>
      )}
    </div>
  );

  const renderGroup = (key: string, header: ReactElement, items: Session[], options: { archived?: boolean; name?: string } = {}): ReactElement => {
    const isCollapsed = collapsed.has(key);
    return (
      <section className="session-group" data-collapsed={isCollapsed ? "true" : undefined} key={key}>
        <header className="session-group-header">
          <button
            type="button"
            className="session-group-toggle"
            aria-expanded={!isCollapsed}
            onClick={() => toggleCollapsed(key)}
          >
            <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={12} />
            {header}
          </button>
          {!multiSelect && options.name && (
            <span className="session-group-actions">
              <button
                type="button"
                aria-label={t(`重命名分组 ${options.name}`, `Rename group ${options.name}`)}
                title={t("重命名分组", "Rename group")}
                onClick={() => { setRenamingGroup(options.name); setGroupDraft(options.name!); }}
              ><Icon name="edit" size={12} /></button>
              <button
                type="button"
                aria-label={t(`删除分组 ${options.name}`, `Delete group ${options.name}`)}
                title={t("删除分组（会话回到未分组）", "Delete group (sessions return to Ungrouped)")}
                onClick={() => setGroupConfirm(options.name!)}
              ><Icon name="trash" size={12} /></button>
            </span>
          )}
        </header>
        {!isCollapsed && <div className="session-group-items">{items.map((session) => renderSession(session, options))}</div>}
      </section>
    );
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
        <button
          className="icon-btn"
          onClick={() => { setMultiSelect(false); setSelection(new Set()); setMoveMenuId(undefined); setBulkMoveOpen(false); }}
          aria-label={t("退出多选", "Exit multi-select")}
          title={t("退出多选", "Exit multi-select")}
          hidden={!multiSelect}
        >
          <Icon name="x" size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => { setMultiSelect(true); setSelection(new Set()); setMoveMenuId(undefined); setBulkMoveOpen(false); }}
          aria-label={t("多选会话", "Select sessions")}
          title={t("多选（批量删除/归档/置顶；分组用会话项上的文件夹按钮）", "Multi-select (bulk delete/archive/pin; use the folder button on a session to group)")}
          hidden={multiSelect}
        >
          <Icon name="check" size={15} />
        </button>
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
      {multiSelect && (
        <div className="session-bulk-bar" role="toolbar" aria-label={t("批量操作", "Bulk actions")}>
          <span className="session-bulk-count">{t(`已选 ${selection.size}`, `${selection.size} selected`)}</span>
          <button type="button" className="btn small" onClick={() => setSelection(selection.size === allVisibleIds.length && allVisibleIds.length > 0 ? new Set() : new Set(allVisibleIds))}>
            {selection.size === allVisibleIds.length && allVisibleIds.length > 0 ? t("取消全选", "Clear all") : t("全选", "Select all")}
          </button>
          <button type="button" className="btn small danger" onClick={() => runBulk("delete", [...selection])}>{t("删除", "Delete")}</button>
          <span className="session-bulk-move">
            <button
              type="button"
              className="btn small"
              aria-expanded={bulkMoveOpen}
              aria-label={t("批量移动到分组", "Move selected to group")}
              onClick={() => setBulkMoveOpen((open) => !open)}
            >{t("移动到组", "Move to group")}</button>
            {bulkMoveOpen && (
              <ul className="session-move-menu" role="menu">
                {knownGroups.map((name) => (
                  <li key={name}>
                    <button type="button" role="menuitem" onClick={() => {
                      setBulkMoveOpen(false);
                      bulkPatch([...selection], { group: name });
                    }}>{name}</button>
                  </li>
                ))}
                <li>
                  <button type="button" role="menuitem" onClick={() => {
                    setBulkMoveOpen(false);
                    bulkPatch([...selection], { group: "" });
                  }}>{t("移出分组（未分组）", "Remove from group (Ungrouped)")}</button>
                </li>
              </ul>
            )}
          </span>
          <button
            type="button"
            className="btn small"
            title={t("归档选中的已停下会话（运行中的会跳过）", "Archive the selected idle sessions (running ones are skipped)")}
            onClick={() => runBulk("archive", [...selection])}
          >{t("归档", "Archive")}</button>
          <button type="button" className="btn small" onClick={() => runBulk("unarchive", [...selection])}>{t("取消归档", "Unarchive")}</button>
          <button type="button" className="btn small" onClick={() => runBulk("pin", [...selection])}>{t("置顶", "Pin")}</button>
          <button type="button" className="btn small" onClick={() => runBulk("unpin", [...selection])}>{t("取消置顶", "Unpin")}</button>
        </div>
      )}
      <nav>
        {groups.map((group) => renderGroup(
          group.name,
          <>
            {renamingGroup === group.name ? (
              <input
                className="session-group-rename"
                value={groupDraft}
                maxLength={40}
                autoFocus
                aria-label={t("重命名分组", "Rename group")}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setGroupDraft(event.target.value)}
                onBlur={() => renameGroup(group.name, groupDraft)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") renameGroup(group.name, groupDraft);
                  if (event.key === "Escape") setRenamingGroup(undefined);
                }}
              />
            ) : (
              <>
                <span className="session-group-name">{group.name}</span>
                <span className="session-group-count">{group.sessions.length}</span>
              </>
            )}
          </>,
          group.sessions,
          { name: group.name },
        ))}

        {ungrouped.length > 0 && renderGroup(
          "ungrouped",
          <>
            <span className="session-group-name">{groups.length > 0 ? t("未分组", "Ungrouped") : t("全部会话", "All sessions")}</span>
            <span className="session-group-count">{ungrouped.length}</span>
          </>,
          ungrouped,
        )}

        {archived.length > 0 && renderGroup(
          "archived",
          <>
            <span className="session-group-name">{t("已归档", "Archived")}</span>
            <span className="session-group-count">{archived.length}</span>
          </>,
          archived,
          { archived: true },
        )}

        {sessions === undefined && <p className="muted-empty rail-empty">{t("加载中…", "Loading…")}</p>}
        {sessions !== undefined && sessions.length === 0 && <p className="muted-empty rail-empty">{t("还没有会话", "No sessions yet")}</p>}
        {sessions !== undefined && sessions.length > 0 && matched.length === 0 && <p className="muted-empty rail-empty">{t("无匹配会话", "No matching sessions")}</p>}
      </nav>
      <footer>
        <button className="icon-btn" onClick={toggleTheme} aria-label={t("切换主题", "Toggle theme")} title={t("切换主题", "Toggle theme")}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
        </button>
        <button className="icon-btn" onClick={() => ui.openSettings()} aria-label={t("设置", "Settings")} title={t("设置", "Settings")}><Icon name="settings" size={15} /></button>
      </footer>

      <ConfirmDialog
        open={bulkConfirm !== undefined}
        title={t("批量删除会话", "Delete sessions")}
        body={bulkConfirm
          ? t(`将删除 ${bulkConfirm.ids.length} 个会话：${bulkConfirm.ids.slice(0, 3).map((id) => (sessions ?? []).find((session) => session.id === id)?.title ?? id).join("、")}${bulkConfirm.ids.length > 3 ? " 等" : ""}。`,
            `Delete ${bulkConfirm.ids.length} session(s): ${bulkConfirm.ids.slice(0, 3).map((id) => (sessions ?? []).find((session) => session.id === id)?.title ?? id).join(", ")}${bulkConfirm.ids.length > 3 ? ", …" : ""}.`)
          : ""}
        warning={t("删除会移除消息历史、子代理转录与 artifacts；快照与托管工作区镜像不受影响，不可恢复。", "This removes message history, subagent transcripts and artifacts; snapshots and managed workspace images are untouched. This cannot be undone.")}
        confirmLabel={t("删除", "Delete")}
        onCancel={() => setBulkConfirm(undefined)}
        onConfirm={() => {
          const target = bulkConfirm;
          setBulkConfirm(undefined);
          if (target) bulkDelete(target.ids);
        }}
      />
      <ConfirmDialog
        open={groupConfirm !== undefined}
        title={t("删除分组", "Delete group")}
        body={groupConfirm ? t(`删除分组「${groupConfirm}」？组内会话会回到「未分组」，不会被删除。`, `Delete group “${groupConfirm}”? Its sessions return to Ungrouped; no session is deleted.`) : ""}
        confirmLabel={t("删除分组", "Delete group")}
        onCancel={() => setGroupConfirm(undefined)}
        onConfirm={() => { if (groupConfirm) deleteGroup(groupConfirm); }}
      />
    </aside>
  );
}
