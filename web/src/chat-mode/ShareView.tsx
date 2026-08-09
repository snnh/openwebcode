// 分享页（只读）：/share/:shareId/:slug 公开访问，口令保护时先验证再拉消息。
// 服务端 /api/share/:shareId/messages 校验口令（verify 颁发 token 后附带查询参数）。
// verify 按 IP 连续 5 次失败锁 60 秒，锁定期间 429（error 文本含剩余秒数）。
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { ChatBlocks } from "./ChatBlocks";
import type { ChatMessage } from "./types";

export function ShareView({ shareId }: { shareId: string; slug: string }): ReactElement {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  /** verify 颁发的访问令牌；ref 图片经 /api/share/:shareId/images/<ref>?token= 取字节时需透传。 */
  const [shareToken, setShareToken] = useState<string>();

  const loadMessages = useCallback(async (token?: string): Promise<boolean> => {
    try {
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      const res = await fetch(`/api/share/${shareId}/messages${qs}`);
      if (!res.ok) return false;
      const data = (await res.json()) as { title: string; messages?: ChatMessage[] };
      setTitle(data.title);
      setMessages(data.messages ?? []);
      return true;
    } catch {
      return false;
    }
  }, [shareId]);

  // password 为 undefined 时探测是否需口令；服务端 401 区分「需要口令」与「口令错误」靠调用方上下文
  const verify = useCallback(async (pw?: string): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/share/${shareId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pw ? { password: pw } : {}),
      });
      if (res.ok) {
        const data = (await res.json()) as { verified: boolean; token?: string };
        if (await loadMessages(data.token)) {
          setShareToken(data.token);
          setNeedsPassword(false);
        } else {
          setError(t("加载失败", "Failed to load"));
        }
      } else if (res.status === 429) {
        // 连续失败锁定：error 文本含剩余秒数
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const seconds = body.error?.match(/(\d+)\s*s/)?.[1];
        setNeedsPassword(true);
        setError(seconds
          ? t(`尝试次数过多，请 ${seconds} 秒后重试`, `Too many attempts, try again in ${seconds}s`)
          : t("尝试次数过多，请稍后再试", "Too many attempts, try again later"));
      } else if (res.status === 401) {
        setNeedsPassword(true);
        if (pw) setError(t("密码错误", "Invalid password"));
      } else {
        setError(t("分享不存在或已撤销", "Share not found or revoked"));
      }
    } catch {
      setError(t("加载失败", "Failed to load"));
    }
    setLoading(false);
  }, [shareId, loadMessages, t]);

  useEffect(() => {
    void verify();
    // shareId 切换时重新探测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId]);

  function handleVerify(): void {
    const pw = password.trim();
    if (pw) void verify(pw);
  }

  if (loading) {
    return (
      <div className="chat-empty share-full">
        <p>{t("加载中…", "Loading…")}</p>
      </div>
    );
  }

  if (needsPassword) {
    return (
      <div className="share-gate">
        <div className="share-gate-card">
          <h2>{t("密码保护", "Password Protected")}</h2>
          <p className="muted-empty">{t("此分享需要密码才能查看", "This share requires a password to view")}</p>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleVerify(); }}
            placeholder={t("输入密码", "Enter password")}
            aria-label={t("输入密码", "Enter password")}
          />
          <button className="btn primary" onClick={handleVerify}>
            {t("验证", "Verify")}
          </button>
          {error && <p className="panel-error" role="alert">{error}</p>}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="chat-empty share-full">
        <p className="panel-error" role="alert">{error}</p>
      </div>
    );
  }

  return (
    <div className="share-page">
      <h1 className="share-title">{title}</h1>
      <div className="share-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-message ${msg.role}`}>
            <div className="chat-bubble">
              <ChatBlocks
                content={msg.content}
                resolveImageRef={(ref) =>
                  `/api/share/${shareId}/images/${ref}${shareToken ? `?token=${encodeURIComponent(shareToken)}` : ""}`}
              />
            </div>
          </div>
        ))}
      </div>
      <footer className="share-footer">
        {t("由 openwebcode 分享", "Shared via openwebcode")}
      </footer>
    </div>
  );
}
