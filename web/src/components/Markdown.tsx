import { Children, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { highlightCode } from "../highlight";

/** 代码块：高亮器就绪前渲染纯文本，就绪后注入双主题高亮 HTML */
export function CodeBlock({ lang, code }: { lang?: string; code: string }): ReactElement {
  const [html, setHtml] = useState<string>();
  useEffect(() => {
    let alive = true;
    setHtml(undefined);
    void highlightCode(code, lang).then((result) => {
      if (alive && result) setHtml(result);
    });
    return () => { alive = false; };
  }, [code, lang]);
  if (html) return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre className="code-block code-plain"><code>{code}</code></pre>;
}

function extractCode(children: ReactNode): { lang?: string; code: string } {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const lang = /language-([\w#+-]+)/.exec(child.props.className ?? "")?.[1];
    const raw = child.props.children;
    const code = (Array.isArray(raw) ? raw.join("") : String(raw ?? "")).replace(/\n$/, "");
    return { lang, code };
  }
  return { code: String(children ?? "") };
}

export function Markdown({ children }: { children: string }): ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
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
