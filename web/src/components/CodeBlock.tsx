import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { highlightCode } from "../highlight";
import { writeClipboard } from "../lib/clipboard";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

/** 代码块：高亮器就绪前渲染纯文本，就绪后注入双主题高亮 HTML；悬停显示复制按钮 */
export function CodeBlock({ lang, code }: { lang?: string; code: string }): ReactElement {
  const { t } = useI18n();
  const [html, setHtml] = useState<string>();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    let alive = true;
    setHtml(undefined);
    void highlightCode(code, lang).then((result) => {
      if (alive && result) setHtml(result);
    });
    return () => { alive = false; };
  }, [code, lang]);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  return (
    <div className="code-block-wrap">
      {html
        ? <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="code-block code-plain"><code>{code}</code></pre>}
      <button
        type="button"
        className="code-copy-btn"
        aria-label={copied ? t("已复制", "Copied") : t("复制代码", "Copy code")}
        onClick={() => {
          void writeClipboard(code).then((ok) => {
            if (!ok) return;
            setCopied(true);
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
        {copied ? t("已复制", "Copied") : t("复制", "Copy")}
      </button>
    </div>
  );
}

export function extractCode(children: ReactNode): { lang?: string; code: string } {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const lang = /language-([\w#+-]+)/.exec(child.props.className ?? "")?.[1];
    const raw = child.props.children;
    const code = (Array.isArray(raw) ? raw.join("") : String(raw ?? "")).replace(/\n$/, "");
    return { lang, code };
  }
  return { code: String(children ?? "") };
}
