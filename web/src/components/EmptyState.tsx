import type { ReactElement } from "react";
import type { Session } from "../lib/contracts";
import { useI18n } from "../i18n";

export function EmptyState({ sessions, onSelect, onCreate }: {
  sessions: Session[];
  onSelect(id: string): void;
  onCreate(): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <section className="empty-state">
      <div className="empty-card">
        <span className="brand-mark">OPENWEBCODE</span>
        <h1>{t("开始一项可回滚的编码作业", "Start a reversible coding job")}</h1>
        <p>{t("创建会话并选择工作目录后，每一次工具调用、权限确认与检查点都会记录在执行轨道上。", "Create a session and choose a workspace. Every tool call, permission decision, and checkpoint is recorded on the execution track.")}</p>
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
