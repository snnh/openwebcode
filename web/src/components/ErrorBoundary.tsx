/**
 * 错误边界（0.6.0 白屏护栏）：React 19 下渲染期/生命周期里抛出的异常若无边界，
 * 会卸载整棵树 —— 用户看到的就是白屏。这里把失败收敛到出错区域：
 * 默认渲染一张可行动卡片（重试 / 重新加载 / 复制诊断），也可以由调用方给降级视图。
 *
 * 用法约定：
 * - 顶层（main.tsx）一层，兜住任何未预料错误；
 * - 每个 lazy() 视图外一层：分块加载失败是渲染错误，Suspense 不接手；
 * - 内容块（Markdown）用 fallback 降级为纯文本，一个块失败不牵连同屏其它内容。
 *
 * 兜底 UI 刻意不依赖任何 hook 与业务组件（可能正是它们失败），中英文案并列显示。
 */
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { crashReport, crashRecords, recordCrash } from "../lib/crash-log";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 区域名（诊断与提示用），例如「对话区」「代码编辑器」 */
  label?: string;
  /** 变化即重置边界（会话/路由切换后不应停在旧错误上） */
  resetKey?: string | number | undefined;
  /** 自定义降级内容；提供后不再渲染内置卡片 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** 额外的错误上报（默认已 console.error + 记入崩溃环形缓冲） */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | undefined;
  seenKey: string | number | undefined;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined, seenKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.seenKey ? null : { error: undefined, seenKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    recordCrash("render", error, this.props.label ? `${this.props.label}${info.componentStack ? `\n${info.componentStack.slice(0, 600)}` : ""}` : info.componentStack?.slice(0, 600));
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: undefined, seenKey: this.props.resetKey });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <CrashFallback error={error} label={this.props.label} onRetry={this.reset} />;
  }
}

/** 内置兜底卡片：不依赖 i18n/业务组件，双语文案并列。 */
function CrashFallback({ error, label, onRetry }: { error: Error; label?: string; onRetry: () => void }): ReactElement {
  const records = crashRecords();
  const last = records[records.length - 1];
  return (
    <div className="crash-fallback" role="alert">
      <div className="crash-fallback-head">
        <b>{label ? `${label}渲染失败` : "界面渲染失败"} · Rendering failed</b>
        <span className="crash-fallback-hint">
          对话与任务状态保存在服务端，刷新后不会丢失。Chat and task state live on the server — reloading is safe.
        </span>
      </div>
      <p className="crash-fallback-message mono">{error.message || String(error)}</p>
      <div className="crash-fallback-actions">
        <button type="button" className="btn" onClick={onRetry}>重试 · Retry</button>
        <button type="button" className="btn" onClick={() => window.location.reload()}>重新加载 · Reload</button>
        <button
          type="button"
          className="btn"
          onClick={() => { void navigator.clipboard?.writeText(crashReport()).catch(() => undefined); }}
        >
          复制诊断 · Copy diagnostics
        </button>
      </div>
      {last && (
        <details className="crash-fallback-details">
          <summary>{`最近 ${records.length} 条错误记录 · Recent errors`}</summary>
          <pre className="mono">{crashReport()}</pre>
        </details>
      )}
    </div>
  );
}
