import type { ReactElement } from "react";
import type { Session } from "../lib/contracts";
import { useI18n } from "../i18n";

export function EmptyState({ sessions, providers, onSelect, onCreate, onOpenSettings }: {
  sessions: Session[];
  /** 已启用服务商列表；undefined 表示仍在加载（加载期间不显示快速开始引导） */
  providers?: string[] | undefined;
  onSelect(id: string): void;
  onCreate(): void;
  /** 深链到设置页签（服务设置 server / 模型目录 models） */
  onOpenSettings?(tab: "server" | "models"): void;
}): ReactElement {
  const { t } = useI18n();
  const showGuide = providers !== undefined && providers.length === 0;
  return (
    <section className="empty-state">
      <div className="empty-card">
        <span className="brand-mark">OPENWEBCODE</span>
        <h1>{t("开始一项可回滚的编码作业", "Start a reversible coding job")}</h1>
        <p>{t("创建会话并选择工作目录后，每一次工具调用、权限确认与检查点都会记录在执行轨道上。", "Create a session and choose a workspace. Every tool call, permission decision, and checkpoint is recorded on the execution track.")}</p>
        {showGuide && (
          <div className="empty-guide">
            <h2>{t("快速开始", "Quick start")}</h2>
            <ol className="empty-guide-steps">
              <li>
                <button type="button" className="empty-guide-step" onClick={() => onOpenSettings?.("server")}>
                  <span className="empty-guide-num">①</span>
                  <span>{t("配置服务商与 API Key", "Configure a provider and API key")}</span>
                </button>
              </li>
              <li>
                <button type="button" className="empty-guide-step" onClick={() => onOpenSettings?.("models")}>
                  <span className="empty-guide-num">②</span>
                  <span>{t("刷新模型目录", "Refresh the model catalog")}</span>
                </button>
              </li>
              <li>
                <button type="button" className="empty-guide-step" onClick={onCreate}>
                  <span className="empty-guide-num">③</span>
                  <span>{t("新建会话", "Create a session")}</span>
                </button>
              </li>
            </ol>
          </div>
        )}
        <button className="btn primary" onClick={onCreate}>{t("新建会话", "New session")}</button>
      </div>
      {sessions.length > 0 && (
        <div className="empty-recent">
          <h2>{t("最近会话", "Recent sessions")}</h2>
          {sessions.slice(0, 5).map((session) => (
            <button key={session.id} className="recent-item" onClick={() => onSelect(session.id)}>
              <span className="session-title">{session.title}</span>
              <span className="session-meta">{session.provider} · {session.model}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
