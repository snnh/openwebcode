import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { highlightLines } from "../../highlight";
import { useI18n } from "../../i18n";

// 单文件渲染行数上限：诊断跳转只读预览不需要全文，超限截断避免大文件拖慢面板
const MAX_LINES = 2000;

export interface CodeViewProps {
  code: string;
  /** shiki 语言 ID（highlight.ts 支持集之外的语言自动回退纯文本） */
  lang?: string;
  /** 1-based 目标行：渲染后滚动到该行并高亮 */
  targetLine?: number;
  /** 1-based 目标列：仅作位置标注（aria-label/title），行高亮不变 */
  targetColumn?: number;
}

/**
 * 只读代码视图（editor 的只读部分，0.5.0 再扩可编辑能力）：
 * 行号 + Shiki 按行高亮（高亮器未就绪或语言不支持时回退纯文本），支持跳转到指定行列。
 */
export const CodeView = memo(function CodeView({ code, lang, targetLine, targetColumn }: CodeViewProps): ReactElement {
  const { t } = useI18n();
  const [highlighted, setHighlighted] = useState<string[]>();
  const targetRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => code.split("\n"), [code]);
  const truncated = lines.length > MAX_LINES;
  const visibleCount = truncated ? MAX_LINES : lines.length;
  const target = targetLine && targetLine >= 1 && targetLine <= visibleCount ? targetLine : undefined;

  useEffect(() => {
    let alive = true;
    setHighlighted(undefined);
    void highlightLines(lines.slice(0, MAX_LINES).join("\n"), lang).then((result) => {
      if (alive && result) setHighlighted(result);
    });
    return () => { alive = false; };
  }, [lines, lang]);

  // 跳转到目标行；jsdom 等环境没有 scrollIntoView，缺省时静默跳过
  useEffect(() => {
    if (target !== undefined) targetRef.current?.scrollIntoView?.({ block: "center" });
  }, [target, highlighted]);

  const rows: ReactElement[] = [];
  for (let index = 0; index < visibleCount; index++) {
    const lineNo = index + 1;
    const isTarget = lineNo === target;
    rows.push(
      <div
        key={lineNo}
        ref={isTarget ? targetRef : undefined}
        className={`code-view-line${isTarget ? " code-view-target" : ""}`}
        aria-label={isTarget
          ? t(`第 ${lineNo} 行${targetColumn ? `，第 ${targetColumn} 列` : ""}`, `Line ${lineNo}${targetColumn ? `, column ${targetColumn}` : ""}`)
          : undefined}
      >
        <span className="code-view-no">{lineNo}</span>
        {highlighted ? (
          <span className="code-view-text" dangerouslySetInnerHTML={{ __html: highlighted[index] ?? "" }} />
        ) : (
          <span className="code-view-text">{lines[index] || " "}</span>
        )}
      </div>,
    );
  }

  return (
    <div className="code-view" data-lang={lang}>
      {/* shiki class 让暗色主题的 --shiki-dark 变量规则生效（见 styles.css 双主题段） */}
      <pre className="shiki">{rows}</pre>
      {truncated && <p className="muted-empty preview-note">{t(`内容过长，仅显示前 ${MAX_LINES} 行。`, `Content is too long; showing the first ${MAX_LINES} lines.`)}</p>}
    </div>
  );
});
