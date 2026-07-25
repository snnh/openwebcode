import type { ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { CodeBlock, extractCode } from "./CodeBlock";

// Markdown 完整实现：react-markdown/katex 体积大，由 Markdown.tsx 懒加载成独立 chunk
export default function MarkdownImpl({ children }: { children: string }): ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          pre: ({ children }) => {
            const { lang, code } = extractCode(children);
            return <CodeBlock lang={lang} code={code} />;
          },
          code: ({ children }) => <code className="inline-code">{children}</code>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
