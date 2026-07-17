import type { ReactElement } from "react";
import type { Session } from "../lib/contracts";

export function EmptyState({ sessions, onSelect, onCreate }: {
  sessions: Session[];
  onSelect(id: string): void;
  onCreate(): void;
}): ReactElement {
  return (
    <section className="empty-state">
      <div className="empty-card">
        <span className="brand-mark">OPENWEBCODE</span>
        <h1>开始一项可回滚的编码作业</h1>
        <p>创建会话并选择工作目录后，每一次工具调用、权限确认与检查点都会记录在执行轨道上。</p>
        <button className="btn primary" onClick={onCreate}>新建会话</button>
      </div>
      {sessions.length > 0 && (
        <div className="empty-recent">
          <h2>最近会话</h2>
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
