// 聊天模式主视图：ChatGPT 风格 [侧边栏会话列表 | 头部 + 消息流 + 输入区]。
// 数据直接走 /api/chat/* REST + SSE（lib/api.ts 的 chat 封装就绪前先用 fetch）。
import { useEffect, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Overlay } from "../components/Overlay";
import { useStore } from "../app/store";
import { ui, uiStore } from "../app/ui-store";
import { router, useRoute } from "../app/router";
import { ChatSessionList } from "./ChatSessionList";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer } from "./ChatComposer";
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

  async function createSession(): Promise<void> {
    // provider/model 取全局 chat 配置默认，缺省取可用模型列表首项；无可用 provider 时不创建
    try {
      const configRes = await fetch("/api/chat/config", { credentials: "include" });
      const config = (configRes.ok ? await configRes.json() : {}) as { defaultProvider?: string; defaultModel?: string };
      const provider = config.defaultProvider ?? models.find((entry) => entry.models.length > 0)?.provider;
      const model = config.defaultModel ?? models.find((entry) => entry.models.length > 0)?.models[0]?.id;
      if (!provider || !model) {
        ui.notify(t("尚未配置可用模型，请先在设置中配置服务商", "No model available; configure a provider in Settings first"), "error");
        return;
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
      } else {
        ui.notify(t("创建对话失败", "Failed to create chat"), "error");
      }
    } catch {
      ui.notify(t("创建对话失败", "Failed to create chat"), "error");
    }
  }

  async function handleDeleted(id: string): Promise<void> {
    if (activeSessionId === id) setActiveSessionId(undefined);
    await loadSessions();
  }

  if (loading) {
    return <div className="chat-empty"><p>{t("加载中…", "Loading…")}</p></div>;
  }

  const activeTitle = sessions.find((s) => s.id === activeSessionId)?.title;

  return (
    <div className="chat-mode-shell">
      <div className={`chat-sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <div className="chat-sidebar-header">
          <button
            className="btn small primary"
            disabled={!canCreate}
            title={canCreate ? undefined : t("尚未配置可用模型，请先在设置中配置服务商", "No model available; configure a provider in Settings first")}
            onClick={() => void createSession()}
          >
            <Icon name="plus" /> {t("新建对话", "New Chat")}
          </button>
          <button
            className="icon-btn"
            aria-label={t("收起侧边栏", "Collapse sidebar")}
            onClick={() => setSidebarCollapsed(true)}
          >
            <Icon name="x" />
          </button>
        </div>
        <ChatSessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={setActiveSessionId}
          onRefresh={() => void loadSessions()}
          onDeleted={(id) => void handleDeleted(id)}
        />
      </div>
      <div className="chat-main">
        <div className="chat-main-header">
          <button
            className="icon-btn"
            aria-label={t("切换侧边栏", "Toggle sidebar")}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <Icon name="panel-left" />
          </button>
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
          <ModeToggle />
        </div>
        {activeSessionId ? (
          <>
            <ChatMessageList sessionId={activeSessionId} />
            <ChatComposer sessionId={activeSessionId} onSent={() => void loadSessions()} />
          </>
        ) : (
          <div className="chat-empty">
            <p>{t("开始新对话", "Start a new conversation")}</p>
            <button className="btn primary" disabled={!canCreate} onClick={() => void createSession()}>
              {t("新建对话", "New Chat")}
            </button>
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

/** chat / workbench 模式切换：写 ui store 并同步路由。 */
function ModeToggle(): ReactElement {
  const { t } = useI18n();
  const mode = useStore(uiStore, (s) => s.mode);
  useRoute(); // 订阅路由变化，保证 navigate 后按钮文案即时刷新

  return (
    <button
      className="btn small"
      onClick={() => {
        const next = mode === "chat" ? "workbench" : "chat";
        ui.setMode(next);
        router.navigate(next === "chat" ? "/" : "/workbench");
      }}
    >
      {mode === "chat" ? t("工作台", "Workbench") : t("聊天", "Chat")}
    </button>
  );
}
