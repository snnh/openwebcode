// 聊天模式主视图：ChatGPT 风格 [侧边栏会话列表 | 头部 + 消息流 + 输入区]。
// 数据直接走 /api/chat/* REST + SSE（lib/api.ts 的 chat 封装就绪前先用 fetch）。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "../components/Icon";
import { Overlay } from "../components/Overlay";
import { ui } from "../app/ui-store";
import { router } from "../app/router";
import { ChatSessionList } from "./ChatSessionList";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer, type ChatComposerApi } from "./ChatComposer";
import { ChatSettings } from "./ChatSettings";
import { PythonStatusBadge } from "./PythonStatusBadge";
import type { ChatModelEntry, ChatSessionMeta } from "./types";

export function ChatModeView(): ReactElement {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [models, setModels] = useState<ChatModelEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 发送成功后递增，驱动 ChatMessageList 重拉历史（自己的消息立即可见）。 */
  const [messagesVersion, setMessagesVersion] = useState(0);
  /** 首页空态（居中问候 + 居中输入框）：无会话或新建会话尚未发消息时为 true。 */
  const [fresh, setFresh] = useState(false);
  /** ChatComposer 建议行注入接口。 */
  const composerApi = useRef<ChatComposerApi | undefined>(undefined);

  // 无可用 provider（未配置任何模型）时禁用新建会话
  const canCreate = models.some((entry) => entry.models.length > 0);

  useEffect(() => {
    // 仅挂载时加载一次会话列表与可用模型
    void loadSessions();
    void loadModels();
  }, []);

  async function loadModels(): Promise<void> {
    try {
      const res = await fetch("/api/chat/models", { credentials: "include" });
      if (res.ok) setModels((await res.json()) as ChatModelEntry[]);
    } catch {
      // 模型列表拉取失败保持现状（按无可用 provider 处理）
    }
  }

  async function loadSessions(): Promise<void> {
    try {
      const res = await fetch("/api/chat/sessions", { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as ChatSessionMeta[];
        setSessions(data);
        setActiveSessionId((current) => current ?? data[0]?.id);
      }
    } catch {
      // 列表拉取失败保持现状，下一次刷新重试
    }
    setLoading(false);
  }

  /** 新建会话并选中；成功返回会话 id（首页直发时由 ChatComposer ensureSession 调用）。 */
  async function createSession(): Promise<string | undefined> {
    // provider/model 取全局 chat 配置默认，缺省取可用模型列表首项；无可用 provider 时不创建
    try {
      const configRes = await fetch("/api/chat/config", { credentials: "include" });
      const config = (configRes.ok ? await configRes.json() : {}) as { defaultProvider?: string; defaultModel?: string };
      const provider = config.defaultProvider ?? models.find((entry) => entry.models.length > 0)?.provider;
      const model = config.defaultModel ?? models.find((entry) => entry.models.length > 0)?.models[0]?.id;
      if (!provider || !model) {
        ui.notify(t("尚未配置可用模型，请先在设置中配置服务商", "No model available; configure a provider in Settings first"), "error");
        return undefined;
      }

      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model }),
      });
      if (res.ok) {
        const session = (await res.json()) as ChatSessionMeta;
        setSessions((previous) => [session, ...previous]);
        setActiveSessionId(session.id);
        setFresh(true);
        return session.id;
      }
      ui.notify(t("创建对话失败", "Failed to create chat"), "error");
    } catch {
      ui.notify(t("创建对话失败", "Failed to create chat"), "error");
    }
    return undefined;
  }

  async function handleDeleted(id: string): Promise<void> {
    if (activeSessionId === id) {
      setActiveSessionId(undefined);
      setFresh(false);
    }
    await loadSessions();
  }

  function handleSelect(id: string): void {
    setFresh(false);
    setActiveSessionId(id);
  }

  /** 首页空态发送成功后切回常规布局并刷新。 */
  function handleSent(): void {
    setFresh(false);
    setMessagesVersion((version) => version + 1);
    void loadSessions();
  }

  if (loading) {
    return <div className="chat-empty"><p>{t("加载中…", "Loading…")}</p></div>;
  }

  const activeTitle = sessions.find((s) => s.id === activeSessionId)?.title;

  return (
    <div className={`chat-mode-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <div className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button
            className="chat-sidebar-row"
            disabled={!canCreate}
            title={canCreate ? undefined : t("尚未配置可用模型，请先在设置中配置服务商", "No model available; configure a provider in Settings first")}
            onClick={() => void createSession()}
          >
            <Icon name="edit" /> {t("新对话", "New chat")}
          </button>
          <button
            className="icon-btn"
            aria-label={t("收起侧边栏", "Collapse sidebar")}
            onClick={() => setSidebarCollapsed(true)}
          >
            <Icon name="chevrons-left" />
          </button>
        </div>
        <ChatSessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={handleSelect}
          onRefresh={() => void loadSessions()}
          onDeleted={(id) => void handleDeleted(id)}
        />
        <div className="chat-sidebar-footer">
          <button
            className="chat-sidebar-row"
            onClick={() => {
              ui.setMode("workbench");
              router.navigate("/workbench");
            }}
          >
            <Icon name="terminal" /> {t("工作台", "Workbench")}
          </button>
        </div>
      </div>
      <div className="chat-main">
        <div className="chat-main-header">
          {sidebarCollapsed && (
            <>
              <button
                className="icon-btn"
                aria-label={t("展开侧边栏", "Expand sidebar")}
                onClick={() => setSidebarCollapsed(false)}
              >
                <Icon name="panel-left" />
              </button>
              <button
                className="icon-btn"
                aria-label={t("新对话", "New chat")}
                disabled={!canCreate}
                onClick={() => void createSession()}
              >
                <Icon name="edit" />
              </button>
              <button
                className="icon-btn"
                aria-label={t("工作台", "Workbench")}
                title={t("工作台", "Workbench")}
                onClick={() => {
                  ui.setMode("workbench");
                  router.navigate("/workbench");
                }}
              >
                <Icon name="terminal" />
              </button>
            </>
          )}
          <span className="title">{activeTitle ?? t("新对话", "New Chat")}</span>
          {activeSessionId && <PythonStatusBadge sessionId={activeSessionId} />}
          {activeSessionId && (
            <button
              className="icon-btn"
              aria-label={t("对话设置", "Chat settings")}
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="settings" />
            </button>
          )}
        </div>
        {activeSessionId && !fresh ? (
          <>
            <ChatMessageList sessionId={activeSessionId} reloadToken={messagesVersion} />
            <ChatComposer sessionId={activeSessionId} onSent={handleSent} />
          </>
        ) : (
          <div className="chat-home">
            <h1 className="chat-home-greeting">{t("有什么可以帮忙的？", "What can I help with?")}</h1>
            <ChatComposer
              sessionId={activeSessionId}
              ensureSession={createSession}
              onSent={handleSent}
              apiRef={composerApi}
            />
            <div className="chat-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.icon}
                  type="button"
                  className="chat-suggestion"
                  onClick={() => composerApi.current?.insert(t(suggestion.zh, suggestion.en))}
                >
                  <Icon name={suggestion.icon} size={16} />
                  {t(suggestion.labelZh, suggestion.labelEn)}
                </button>
              ))}
            </div>
            {!canCreate && (
              <p className="chat-muted-hint">
                {t("尚未配置可用模型，请先在设置中配置服务商", "No model available; configure a provider in Settings first")}
              </p>
            )}
          </div>
        )}
      </div>
      <Overlay
        open={settingsOpen && activeSessionId !== undefined}
        label={t("对话设置", "Chat settings")}
        onClose={() => setSettingsOpen(false)}
      >
        {activeSessionId && (
          <ChatSettings
            sessionId={activeSessionId}
            onClose={() => setSettingsOpen(false)}
            onSaved={() => void loadSessions()}
          />
        )}
      </Overlay>
    </div>
  );
}

/** 首页空态建议行（ChatGPT 风格）：点击注入引导文本并聚焦输入框。 */
const SUGGESTIONS: Array<{ icon: IconName; labelZh: string; labelEn: string; zh: string; en: string }> = [
  { icon: "image", labelZh: "生成图片", labelEn: "Generate an image", zh: "帮我生成一张图片：", en: "Generate an image of " },
  { icon: "edit", labelZh: "撰写或编辑", labelEn: "Write or edit", zh: "帮我写", en: "Help me write " },
  { icon: "search", labelZh: "搜索网页", labelEn: "Search the web", zh: "搜索一下：", en: "Search the web for " },
];
