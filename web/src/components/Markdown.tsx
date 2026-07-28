import { Fragment, lazy, memo, Suspense, useMemo, type ReactElement } from "react";
import { splitMarkdownBlocks } from "./markdown-split";

// 分块渲染单元：与整篇渲染同一条 react-markdown/katex 管线，只是不带 .markdown 外壳
const MarkdownBlock = lazy(() =>
  import("./MarkdownImpl").then((module) => ({ default: module.MarkdownBlock })),
);
// 稳定块内容不变时 memo（字符串浅比较）直接跳过：流式期间每个稳定块只解析一次，
// 只有末尾块随文本增长重渲染，工作量从 O(全文) 降到 O(末尾块)
const MemoMarkdownBlock = memo(MarkdownBlock);

// CodeBlock 保持同步可用（不依赖 react-markdown），供 PermissionCard、面板等直接引用
export { CodeBlock } from "./CodeBlock";

/**
 * Markdown 按需加载（react-markdown/katex 独立 chunk），加载期间先渲染纯文本，不阻塞流式输出。
 * 文本按空行切分为块（围栏代码/$$ 数学块内部不拆分）：除末尾块外均为稳定块，
 * 流式增长或父组件重渲染时只有内容变化的块会重新走 markdown 管线。
 */
export function Markdown({ children }: { children: string }): ReactElement {
  const blocks = useMemo(() => splitMarkdownBlocks(children), [children]);
  return (
    <Suspense fallback={<div className="markdown">{children}</div>}>
      <div className="markdown">
        {blocks.map((block, index) => (
          // 块间补 "\n" 文本节点：与 react-markdown 整篇渲染时顶层元素间的换行保持一致
          <Fragment key={index}>
            {index > 0 ? "\n" : null}
            <MemoMarkdownBlock>{block}</MemoMarkdownBlock>
          </Fragment>
        ))}
      </div>
    </Suspense>
  );
}
