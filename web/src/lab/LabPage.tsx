import { useState, type ReactElement } from "react";
import { LazyMotion, domAnimation } from "motion/react";
import { MotionPreview } from "../settings/sections/MotionPreview";

/**
 * 开发期组件陈列页（仅 DEV/`/__lab` 可达，不进入生产入口）。
 * 用于双主题截图对比与动画模式走查；用真实 class 与 token，不另造样式体系。
 */
export function LabPage(): ReactElement {
  const [theme, setTheme] = useState<"light" | "dark">(
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const applyTheme = (next: "light" | "dark"): void => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };
  return (
    <LazyMotion features={domAnimation}>
      <div className="lab">
      <style>{LAB_CSS}</style>
      <header className="lab-bar">
        <strong>OWC UI Lab</strong>
        <div>
          <button type="button" className={theme === "dark" ? "active" : ""} onClick={() => applyTheme("dark")}>Dark</button>
          <button type="button" className={theme === "light" ? "active" : ""} onClick={() => applyTheme("light")}>Light</button>
        </div>
      </header>

      <section className="lab-section">
        <h2>Surfaces</h2>
        <div className="lab-swatches">
          {["canvas", "card", "inset", "floating", "subtle", "hover", "active"].map((name) => (
            <div key={name} className={`lab-swatch sw-${name}`}>{name}</div>
          ))}
        </div>
      </section>

      <section className="lab-section">
        <h2>Type scale</h2>
        <div className="lab-type">
          {[["2xs", 11], ["xs", 12], ["s", 13], ["m", 14], ["l", 16], ["xl", 20], ["2xl", 26]].map(([name, size]) => (
            <p key={name} style={{ fontSize: `var(--text-${name})` }}>{name} · {size}px · 中文排版示例 OpenWebCode</p>
          ))}
        </div>
      </section>

      <section className="lab-section">
        <h2>Messages</h2>
        <article className="message assistant">
          <div className="message-meta"><span className="message-author">OpenWebCode</span><time>14:11</time></div>
          <div className="markdown">
            <h2>实现方案</h2>
            <p>正文 14px / 1.7，行内 <code>code</code> 使用等宽字体。</p>
            <pre className="mono code-block-wrap"><code>const surface = "card";</code></pre>
            <table><thead><tr><th>token</th><th>value</th></tr></thead><tbody><tr><td>canvas</td><td>#181818</td></tr></tbody></table>
            <blockquote>引用块使用弱底与左侧细线。</blockquote>
          </div>
          <div className="message-actions">
            <button type="button" className="action-btn" aria-label="复制">⧉</button>
            <button type="button" className="action-btn" aria-label="重试">↻</button>
          </div>
        </article>
        <article className="message user">
          <div className="markdown"><p>用户消息右对齐、浅底块。</p></div>
          <div className="message-meta"><time>14:12</time></div>
        </article>
        <article className="message assistant">
          <div className="message-meta"><span className="message-author">OpenWebCode</span><time>14:13</time></div>
          <details className="thinking"><summary>思考了 6s</summary><p>左侧细轨、无灰底。</p></details>
          <div className="tool-row"><div className="collapse-row"><span className="tool-row-status done">✓</span><b className="tool-row-name">bash</b><span className="tool-row-summary mono">npm run build</span><span className="tool-row-actions"><span className="tool-row-meta mono">exit 0 · 15.4s</span><span>›</span></span></div></div>
          <div className="tool-row error"><div className="collapse-row"><span className="tool-row-status error">✕</span><b className="tool-row-name">edit_file</b><span className="tool-row-summary mono">oldText not found</span><span className="tool-row-actions"><span className="tool-row-meta mono">failed · 12ms</span><span>›</span></span></div></div>
        </article>
      </section>

      <section className="lab-section">
        <h2>Composer</h2>
        <div className="composer-card">
          <div style={{ color: "var(--text-3)", fontSize: "var(--text-s)", padding: "4px 2px" }}>向正在执行的作业补充指令…</div>
          <div className="composer-toolbar">
            <button type="button" className="composer-menu-btn" aria-label="附件">📎</button>
            <span className="composer-menu-btn" style={{ color: "var(--amber)" }}>智能审核</span>
            <span className="composer-menu-btn">模式</span>
            <span className="composer-toolbar-spacer" />
            <span className="composer-menu-btn">deepseek-v4.1-flash <span className="model-menu-btn-thinking">思考 max</span></span>
            <span className="queue-option selected">补充</span>
            <span className="queue-option">续跑</span>
            <button type="button" className="composer-send" aria-label="发送">↑</button>
          </div>
        </div>
      </section>

      <section className="lab-section">
        <h2>Panels</h2>
        <div className="panel-tabs"><button type="button" className="active">Files</button><button type="button">Search</button><button type="button">Git</button></div>
        <div className="file-tree">
          <div className="file-row dir">▾ web</div>
          <div className="file-row" style={{ paddingLeft: 26 }}>App.tsx</div>
          <div className="file-row active" style={{ paddingLeft: 26 }}>main.tsx</div>
          <div className="file-row dir">▸ server</div>
        </div>
      </section>

      <section className="lab-section">
        <h2>Motion preview</h2>
        <MotionPreview />
      </section>
      </div>
    </LazyMotion>
  );
}

const LAB_CSS = `
.lab { max-width: 1080px; margin: 0 auto; padding: 24px 24px 80px; background: var(--surface-canvas); color: var(--text); min-height: 100vh; }
.lab-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.lab-bar button { margin-left: 6px; padding: 4px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border); color: var(--text-2); }
.lab-bar button.active { background: var(--surface-active); color: var(--text); border-color: var(--border-strong); }
.lab-section { margin-bottom: 32px; }
.lab-section h2 { font-size: var(--text-l); font-weight: var(--fw-600); margin: 0 0 12px; }
.lab-swatches { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
.lab-swatch { height: 64px; border: 1px solid var(--border); border-radius: var(--radius); display: flex; align-items: flex-end; padding: 6px; font-size: var(--text-2xs); color: var(--text-2); }
.sw-canvas { background: var(--surface-canvas); }
.sw-card { background: var(--surface-card); }
.sw-inset { background: var(--surface-inset); }
.sw-floating { background: var(--surface-floating); }
.sw-subtle { background: var(--surface-subtle); }
.sw-hover { background: var(--surface-hover); }
.sw-active { background: var(--surface-active); }
.lab-type p { margin: 0 0 6px; }
.lab .message { margin-bottom: 16px; }
.lab .composer-card { position: static; }
.lab .composer-toolbar { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
`;
