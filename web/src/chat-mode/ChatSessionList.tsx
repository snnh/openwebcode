// 侧边栏会话列表：选择 / 重命名 / 分享 / 分支 / 删除。
// 重命名与分享走 Overlay 弹层（禁 window.prompt/alert）；菜单为统一 Overlay 弹层，背板/Esc 关闭。
import { useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Overlay } from "../components/Overlay";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { ui } from "../app/ui-store";
import { api, ApiError } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import type { ChatSessionMeta, ChatShare } from "./types";

interface RenameTarget {
  id: string;
  title: string;
}

interface SessionGroup {
  label: string;
  items: ChatSessionMeta[];
}

/** 按 updatedAt 分组（今天/昨天/过去 7 天/更早），ChatGPT 侧栏风格；组内保持 updatedAt 倒序。 */
function groupSessionsByDate(
  sessions: ChatSessionMeta[],
  t: (chinese: string, english: string) => string,
): SessionGroup[] {
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const groups: SessionGroup[] = [];
  for (const session of sorted) {
    const ts = new Date(session.updatedAt).getTime();
    const label = Number.isNaN(ts) || ts >= startOfToday
      ? t("今天", "Today")
      : ts >= startOfToday - dayMs
        ? t("昨天", "Yesterday")
        : ts >= startOfToday - 7 * dayMs
          ? t("过去 7 天", "Previous 7 days")
          : t("更早", "Older");
    let group = groups.find((candidate) => candidate.label === label);
    if (!group) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(session);
  }
  return groups;
}

export function ChatSessionList(props: {
  sessions: ChatSessionMeta[];
  activeId?: string;
  onSelect(id: string): void;
  onRefresh(): void;
  onDeleted?(id: string): void;
}): ReactElement {
  const { t } = useI18n();
  const confirm = useConfirmDialog();
  const [menuSession, setMenuSession] = useState<ChatSessionMeta>();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [renameDraft, setRenameDraft] = useState("");
  const [shareSession, setShareSession] = useState<ChatSessionMeta>();
  const [sharePassword, setSharePassword] = useState("");
  const [shareResult, setShareResult] = useState<ChatShare>();
  const [shareBusy, setShareBusy] = useState(false);
  // 会话搜索：按标题大小写不敏感过滤；有查询时保持日期分组，仅隐藏不匹配的会话
  const [query, setQuery] = useState("");

  function notifyError(text: string): void {
    ui.notify(text, "error");
  }

  function handleDelete(id: string): void {
    confirm.ask({
      title: t("删除对话", "Delete chat"),
      body: t("确定删除此对话？此操作不可撤销。", "Delete this conversation? This cannot be undone."),
      confirmLabel: t("删除", "Delete"),
      onConfirm: () => {
        void (async () => {
          try {
            await api.chatDelete(id);
            if (props.onDeleted) props.onDeleted(id);
            else props.onRefresh();
          } catch {
            notifyError(t("删除失败", "Delete failed"));
          }
        })();
      },
    });
  }

  function openRename(session: ChatSessionMeta): void {
    setRenameTarget({ id: session.id, title: session.title });
    setRenameDraft(session.title);
  }

  async function submitRename(): Promise<void> {
    if (!renameTarget) return;
    const title = renameDraft.trim();
    if (!title) return;
    const { id } = renameTarget;
    setRenameTarget(undefined);
    try {
      await api.chatPatch(id, { title });
      props.onRefresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        notifyError(t("需要访问令牌才能修改", "Access token required"));
        return;
      }
      notifyError(t("重命名失败", "Rename failed"));
    }
  }

  function openShare(session: ChatSessionMeta): void {
    setShareSession(session);
    setSharePassword("");
    setShareResult(session.share);
  }

  async function createShare(): Promise<void> {
    if (!shareSession || shareBusy) return;
    setShareBusy(true);
    try {
      const share = await api.chatCreateShare(shareSession.id, sharePassword.trim() || undefined);
      setShareResult(share);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        notifyError(t("需要访问令牌才能分享", "Access token required"));
        return;
      }
      notifyError(t("创建分享失败", "Failed to create share"));
    } finally {
      setShareBusy(false);
    }
  }

  async function revokeShare(): Promise<void> {
    if (!shareSession || shareBusy) return;
    setShareBusy(true);
    try {
      await api.chatRevokeShare(shareSession.id);
      setShareResult(undefined);
      props.onRefresh();
    } catch {
      notifyError(t("撤销分享失败", "Failed to revoke share"));
    } finally {
      setShareBusy(false);
    }
  }

  async function copyShareUrl(): Promise<void> {
    if (!shareResult) return;
    const url = `${window.location.origin}/share/${shareResult.id}/${shareResult.slug}`;
    const ok = await writeClipboard(url);
    if (ok) ui.notify(t("分享链接已复制", "Share link copied"));
    else notifyError(t("复制失败，请手动复制", "Copy failed; please copy manually"));
  }

  async function handleBranch(id: string): Promise<void> {
    try {
      await api.chatBranches(id);
      props.onRefresh();
    } catch {
      notifyError(t("创建分支失败", "Failed to create branch"));
    }
  }

  function runMenuAction(action: () => void): void {
    setMenuSession(undefined);
    action();
  }

  const needle = query.trim().toLowerCase();
  const visibleSessions = needle
    ? props.sessions.filter((session) => session.title.toLowerCase().includes(needle))
    : props.sessions;
  const groups = groupSessionsByDate(visibleSessions, t);

  return (
    <div className="chat-sidebar-list">
      <div className="chat-sidebar-search">
        <Icon name="search" size={12} />
        <input
          type="search"
          value={query}
          aria-label={t("搜索对话", "Search chats")}
          placeholder={t("搜索对话", "Search chats")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="chat-session-group">{group.label}</div>
          {group.items.map((session) => (
            <div
              key={session.id}
              className={`chat-session-item${session.id === props.activeId ? " active" : ""}`}
              onClick={() => props.onSelect(session.id)}
            >
              <span className="title">{session.title}</span>
              <button
                className="icon-btn chat-session-menu"
                aria-label={t("更多操作", "More actions")}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuSession(session);
                }}
              >
                <Icon name="more" />
              </button>
            </div>
          ))}
        </div>
      ))}
      {props.sessions.length === 0 && (
        <p className="muted-empty">{t("暂无对话", "No conversations yet")}</p>
      )}
      {props.sessions.length > 0 && visibleSessions.length === 0 && (
        <p className="muted-empty">{t("没有匹配的对话", "No matching chats")}</p>
      )}
      {confirm.dialogElement}

      <Overlay
        open={menuSession !== undefined}
        label={t("对话操作", "Chat actions")}
        onClose={() => setMenuSession(undefined)}
      >
        {menuSession && (
          <div className="chat-dialog">
            <h3>{menuSession.title}</h3>
            <div className="chat-dialog-menu">
              <button className="btn small" onClick={() => runMenuAction(() => openRename(menuSession))}>
                {t("重命名", "Rename")}
              </button>
              <button className="btn small" onClick={() => runMenuAction(() => openShare(menuSession))}>
                {t("分享", "Share")}
              </button>
              <button className="btn small" onClick={() => runMenuAction(() => void handleBranch(menuSession.id))}>
                {t("分支", "Branch")}
              </button>
              <button className="btn small danger" onClick={() => runMenuAction(() => handleDelete(menuSession.id))}>
                {t("删除", "Delete")}
              </button>
            </div>
          </div>
        )}
      </Overlay>

      <Overlay
        open={renameTarget !== undefined}
        label={t("重命名对话", "Rename chat")}
        initialFocus="input"
        onClose={() => setRenameTarget(undefined)}
      >
        <form
          className="chat-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <h3>{t("重命名对话", "Rename chat")}</h3>
          <input
            className="input"
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            placeholder={t("对话标题", "Chat title")}
          />
          <div className="chat-dialog-actions">
            <button type="button" className="btn" onClick={() => setRenameTarget(undefined)}>
              {t("取消", "Cancel")}
            </button>
            <button type="submit" className="btn primary" disabled={!renameDraft.trim()}>
              {t("确定", "OK")}
            </button>
          </div>
        </form>
      </Overlay>

      <Overlay
        open={shareSession !== undefined}
        label={t("分享对话", "Share chat")}
        onClose={() => setShareSession(undefined)}
      >
        {shareSession && (
          <div className="chat-dialog">
            <h3>{t("分享对话", "Share chat")}</h3>
            {shareResult ? (
              <>
                <div className="chat-share-url-row">
                  <code className="chat-share-url">
                    {`${window.location.origin}/share/${shareResult.id}/${shareResult.slug}`}
                  </code>
                  <button className="btn small" onClick={() => void copyShareUrl()}>
                    <Icon name="copy" /> {t("复制", "Copy")}
                  </button>
                </div>
                {shareResult.hasPassword && (
                  <p className="chat-muted-hint">{t("此分享已设置访问密码", "This share is password protected")}</p>
                )}
                <div className="chat-dialog-actions">
                  <button className="btn small danger" disabled={shareBusy} onClick={() => void revokeShare()}>
                    {t("撤销分享", "Revoke share")}
                  </button>
                  <button className="btn" onClick={() => setShareSession(undefined)}>
                    {t("关闭", "Close")}
                  </button>
                </div>
              </>
            ) : (
              <form
                className="chat-dialog"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createShare();
                }}
              >
                <label className="chat-dialog-field">
                  {t("访问密码（可选，留空则公开）", "Password (optional, leave empty for public)")}
                  <input
                    className="input"
                    type="password"
                    value={sharePassword}
                    onChange={(event) => setSharePassword(event.target.value)}
                    placeholder={t("访问密码", "Password")}
                  />
                </label>
                <div className="chat-dialog-actions">
                  <button type="button" className="btn" onClick={() => setShareSession(undefined)}>
                    {t("取消", "Cancel")}
                  </button>
                  <button type="submit" className="btn primary" disabled={shareBusy}>
                    {shareBusy ? t("创建中…", "Creating…") : t("创建分享链接", "Create share link")}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </Overlay>
    </div>
  );
}
