import type { ReactElement } from "react";
import type { Session } from "../lib/contracts";
import { useI18n } from "../i18n";
import { MobileNavTrigger } from "../workbench/MobileNavMenu";

export function EmptyState({ sessions, providers, onSelect, onCreate, onOpenSettings, onExample, onOpenNavMenu }: {
  sessions: Session[];
  /** 已启用服务商列表；undefined 表示仍在加载（加载期间不显示快速开始引导） */
  providers?: string[] | undefined;
  onSelect(id: string): void;
  onCreate(): void;
  /** 深链到设置页签（模型目录 models） */
  onOpenSettings?(tab: "models"): void;
  /** 示例任务 chip 点击：把文案交给调用方（复制到剪贴板），由用户粘贴进新会话输入框 */
  onExample?(text: string): void;
  /** 移动端导航菜单触发（≤1024px 渲染在卡片左上角；桌面端不渲染入口） */
  onOpenNavMenu?(): void;
}): ReactElement {
  const { t } = useI18n();
  const showGuide = providers !== undefined && providers.length === 0;
  const examples: Array<{ zh: string; en: string }> = [
    { zh: "解释这个仓库的结构", en: "Explain the structure of this repository" },
    { zh: "修一个 failing test 并给出原因", en: "Fix a failing test and explain the cause" },
    { zh: "给一个模块补充单元测试", en: "Add unit tests for a module" },
  ];
  return (
    <section className="empty-state">
      <div className="empty-card">
        {onOpenNavMenu && <MobileNavTrigger onOpen={onOpenNavMenu} />}
        <span className="brand-mark">OPENWEBCODE</span>
        <h1>{t("开始一项可回滚的编码作业", "Start a reversible coding job")}</h1>
        <p>{t("创建会话并选择工作目录后，每一次工具调用、权限确认与检查点都会记录在执行轨道上。", "Create a session and choose a workspace. Every tool call, permission decision, and checkpoint is recorded on the execution track.")}</p>
        {showGuide && (
          <div className="empty-guide">
            <h2>{t("快速开始", "Quick start")}</h2>
            <ol className="empty-guide-steps">
              <li>
                <button type="button" className="empty-guide-step" onClick={() => onOpenSettings?.("models")}>
                  <span className="empty-guide-num" aria-hidden />
                  <span>{t("配置服务商与 API Key", "Configure a provider and API key")}</span>
                </button>
              </li>
              <li>
                <button type="button" className="empty-guide-step" onClick={() => onOpenSettings?.("models")}>
                  <span className="empty-guide-num" aria-hidden />
                  <span>{t("刷新模型目录", "Refresh the model catalog")}</span>
                </button>
              </li>
              <li>
                <button type="button" className="empty-guide-step" onClick={onCreate}>
                  <span className="empty-guide-num" aria-hidden />
                  <span>{t("新建会话", "Create a session")}</span>
                </button>
              </li>
            </ol>
          </div>
        )}
        <button className="btn primary" onClick={onCreate}>{t("新建会话", "New session")}</button>
        {onExample && (
          <div className="empty-examples">
            <h2>{t("试试这些任务", "Try these tasks")}</h2>
            <div className="empty-example-chips">
              {examples.map((example) => (
                <button
                  key={example.zh}
                  type="button"
                  className="empty-example-chip"
                  title={t("复制到剪贴板，粘贴进新会话输入框", "Copy to clipboard, then paste into the composer of a new session")}
                  onClick={() => onExample(t(example.zh, example.en))}
                >
                  {t(example.zh, example.en)}
                </button>
              ))}
            </div>
          </div>
        )}
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
