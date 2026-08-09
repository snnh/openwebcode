// 侧边栏会话列表：选择 / 重命名 / 分享 / 分支 / 删除。
// 重命名与分享走 Overlay 弹层（禁 window.prompt/alert）；菜单为统一 Overlay 弹层，背板/Esc 关闭。
import { useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Overlay } from "../components/Overlay";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { ui } from "../app/ui-store";
import type { ChatSessionMeta, ChatShare } from "./types";

interface RenameTarget {
  id: string;
  title: string;
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
            const res = await fetch(`/api/chat/sessions/${id}`, { method: "DELETE", credentials: "include" });
            if (!res.ok) {
              notifyError(t("删除失败", "Delete failed"));
              return;
            }
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
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.status === 401) {
        notifyError(t("需要访问令牌才能修改", "Access token required"));
        return;
      }
      if (!res.ok) {
        notifyError(t("重命名失败", "Rename failed"));
        return;
      }
      props.onRefresh();
    } catch {
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
      const password = sharePassword.trim();
      const res = await fetch(`/api/chat/sessions/${shareSession.id}/share`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(password ? { password } : {}),
      });
      if (res.status === 401) {
        notifyError(t("需要访问令牌才能分享", "Access token required"));
        return;
      }
      if (!res.ok) {
        notifyError(t("创建分享失败", "Failed to create share"));
        return;
      }
      setShareResult((await res.json()) as ChatShare);
    } catch {
      notifyError(t("创建分享失败", "Failed to create share"));
    } finally {
      setShareBusy(false);
    }
  }

  async function revokeShare(): Promise<void> {
    if (!shareSession || shareBusy) return;
    setShareBusy(true);
    try {
      const res = await fetch(`/api/chat/sessions/${shareSession.id}/share`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        notifyError(t("撤销分享失败", "Failed to revoke share"));
        return;
      }
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
    try {
      await navigator.clipboard.writeText(url);
      ui.notify(t("分享链接已复制", "Share link copied"));
    } catch {
      notifyError(t("复制失败，请手动复制", "Copy failed; please copy manually"));
    }
  }

  async function handleBranch(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/chat/sessions/${id}/branches`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        notifyError(t("创建分支失败", "Failed to create branch"));
        return;
      }
      props.onRefresh();
    } catch {
      notifyError(t("创建分支失败", "Failed to create branch"));
    }
  }

  function runMenuAction(action: () => void): void {
    setMenuSession(undefined);
    action();
  }

  return (
    <div className="chat-sidebar-list">
      {props.sessions.map((session) => (
        <div
          key={session.id}
          className={`chat-session-item${session.id === props.activeId ? " active" : ""}`}
          onClick={() => props.onSelect(session.id)}
        >
          <span className="title">{session.title}</span>
          <button
            className="icon-btn"
            aria-label={t("更多操作", "More actions")}
            onClick={(event) => {
              event.stopPropagation();
              setMenuSession(session);
            }}
          >
            <Icon name="chevron-down" />
          </button>
        </div>
      ))}
      {props.sessions.length === 0 && (
        <p className="muted-empty">{t("暂无对话", "No conversations yet")}</p>
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
