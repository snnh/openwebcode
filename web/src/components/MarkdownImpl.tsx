import type { ComponentProps, ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { CodeBlock, extractCode } from "./CodeBlock";

// Markdown 完整实现：react-markdown/katex 体积大，由 Markdown.tsx 懒加载成独立 chunk

// 插件与组件配置为模块级常量：每次渲染重建数组会让 react-markdown 认为配置变化而全量重解析
type MarkdownConfig = ComponentProps<typeof ReactMarkdown>;
const REMARK_PLUGINS: MarkdownConfig["remarkPlugins"] = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: MarkdownConfig["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];
const COMPONENTS: MarkdownConfig["components"] = {
  pre: ({ children }) => {
    const { lang, code } = extractCode(children);
    return <CodeBlock lang={lang} code={code} />;
  },
  code: ({ children }) => <code className="inline-code">{children}</code>,
};

/** 渲染单个 markdown 文本块（不带 .markdown 外壳，由调用方包裹），供 Markdown.tsx 分块增量渲染 */
export function MarkdownBlock({ children }: { children: string }): ReactElement {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}

export default function MarkdownImpl({ children }: { children: string }): ReactElement {
  return (
    <div className="markdown">
      <MarkdownBlock>{children}</MarkdownBlock>
    </div>
  );
}
