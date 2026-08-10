// 消息内容块渲染：text / image / tool_call / tool_result。
// ChatMessageList 与 ShareView 共用（图片 ref 经 resolveImageRef 回调区分会话内与分享面路由）。
// tool_call 与配对的 tool_result 合并为一个可折叠块（默认折叠，ChatGPT「分析步骤」风格）。
import { memo, useMemo, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";
import { Icon } from "../components/Icon";
import type { MessageContent } from "./types";

export function ChatBlocks({ content, resolveImageRef }: {
  content: MessageContent[];
  /** image 块 ref 形态的字节路由（会话 images 路由或分享 images 路由，后者需透传 token）。 */
  resolveImageRef(ref: string): string;
}): ReactElement {
  const items: ReactElement[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]!;
    if (block.type === "text") {
      if (block.text) items.push(<Markdown key={index}>{block.text}</Markdown>);
      continue;
    }
    if (block.type === "image") {
      // 内联块用 data: URI；ref 块经调用方路由取字节
      items.push(
        <ChatImage
          key={index}
          data={block.data}
          mediaType={block.mediaType}
          refSrc={block.ref ? resolveImageRef(block.ref) : undefined}
        />,
      );
      continue;
    }
    if (block.type === "tool_call") {
      // 配对同 id 的 tool_result（通常在紧随其后的块里）
      const result = content.find(
        (candidate) => candidate.type === "tool_result" && candidate.toolCallId === block.id,
      );
      items.push(
        <ToolBlock
          key={index}
          name={block.name ?? "tool"}
          input={block.input}
          result={result?.content}
          isError={result?.isError}
        />,
      );
      continue;
    }
    if (block.type === "tool_result") {
      // 已被 tool_call 配对的不重复渲染；孤立结果（异常落盘）照常展示
      const paired = content.some(
        (candidate) => candidate.type === "tool_call" && candidate.id === block.toolCallId,
      );
      if (!paired) {
        items.push(<ToolBlock key={index} name="tool" result={block.content} isError={block.isError} />);
      }
    }
  }
  return <>{items}</>;
}

/**
 * 图片块（memo）：内嵌 base64 图（≤2MB）的 data: URI 拼接按块缓存，
 * 流式期间父列表重渲染时不再每帧×每图重建整条 URI。
 */
const ChatImage = memo(function ChatImage({ data, mediaType, refSrc }: {
  data?: string;
  mediaType?: string;
  refSrc?: string;
}): ReactElement | null {
  const src = useMemo(
    () => (data ? `data:${mediaType ?? "image/png"};base64,${data}` : refSrc),
    [data, mediaType, refSrc],
  );
  if (!src) return null;
  return <img src={src} alt="" className="chat-block-image" />;
});

function ToolBlock({ name, input, result, isError }: {
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className={`chat-tool${isError ? " error" : ""}`}>
      <button
        type="button"
        className="chat-tool-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        <Icon name="wrench" size={12} />
        <span className="chat-tool-name">{name}</span>
        {isError === true && <span className="pill danger small">{t("失败", "Failed")}</span>}
      </button>
      {open && (
        <div className="chat-tool-body">
          {input !== undefined && <pre>{JSON.stringify(input, null, 2)}</pre>}
          {result !== undefined && <pre>{result}</pre>}
        </div>
      )}
    </div>
  );
}
