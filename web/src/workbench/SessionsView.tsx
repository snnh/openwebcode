/**
 * 极简会话列表（侧栏 sessions 视图）：
 * 置顶在前、运行点（agent 运行态）、选中态、底部「新建会话」按钮。
 * 重命名/置顶/删除/导入在 Phase 2 接入。
 */
import type { ReactElement } from "react";
import type { Session } from "../lib/contracts";
import { isBusyState } from "../lib/agent-state";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";

export interface SessionsViewProps {
  /** undefined 表示仍在加载 */
  sessions?: Session[] | undefined;
  currentId?: string | undefined;
  /** 按会话键控的 agent 运行态（session-store.agentStates） */
  agentStates: Record<string, string>;
  onSelect(id: string): void;
  onCreate(): void;
}

export function SessionsView({ sessions, currentId, agentStates, onSelect, onCreate }: SessionsViewProps): ReactElement {
  const { t } = useI18n();
  // 置顶优先，组内保持服务端 updatedAt 降序（稳定排序）
  const ordered = sessions && [...sessions].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  return (
    <aside className="sessions-view" aria-label={t("会话", "Sessions")}>
      <nav>
        {ordered?.map((session) => (
          <div key={session.id} className={`session-item${session.id === currentId ? " active" : ""}`}>
            <button className="session-link" onClick={() => onSelect(session.id)} title={session.title}>
              <span className="session-title">{session.title}</span>
              <span className="session-meta">{session.provider} · {session.model}</span>
            </button>
            {isBusyState(agentStates[session.id]) && (
              <span className="running-dot" role="status" aria-label={t("运行中", "Running")} title={t("运行中", "Running")} />
            )}
          </div>
        ))}
        {sessions === undefined && <p className="muted-empty rail-empty">{t("加载中…", "Loading…")}</p>}
        {sessions !== undefined && sessions.length === 0 && <p className="muted-empty rail-empty">{t("还没有会话", "No sessions yet")}</p>}
      </nav>
      <footer>
        <button className="btn primary sessions-new-btn" onClick={onCreate}>
          <Icon name="plus" size={14} />
          {t("新建会话", "New session")}
        </button>
      </footer>
    </aside>
  );
}
