import { lazy, memo, Suspense, type ReactElement } from "react";

const MarkdownImpl = lazy(() => import("./MarkdownImpl"));
// 内容不变时不重复渲染：memo 比较字符串 children，相同内容直接跳过
//（包括 React 对已 resolve 的 Suspense 边界的重渲染）
const MemoMarkdownImpl = memo(MarkdownImpl);

// CodeBlock 保持同步可用（不依赖 react-markdown），供 PermissionCard、面板等直接引用
export { CodeBlock } from "./CodeBlock";

/** Markdown 按需加载（react-markdown/katex 独立 chunk），加载期间先渲染纯文本，不阻塞流式输出 */
export function Markdown({ children }: { children: string }): ReactElement {
  return (
    <Suspense fallback={<div className="markdown">{children}</div>}>
      <MemoMarkdownImpl>{children}</MemoMarkdownImpl>
    </Suspense>
  );
}
