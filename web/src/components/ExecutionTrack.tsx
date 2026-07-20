import { Fragment, useEffect, useRef, useState, type ReactElement } from "react";
import type { ChatMessage, SessionDetail } from "../lib/contracts";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { MessageCard } from "./MessageCard";
import { PermissionCard, type PermissionRequest } from "./PermissionCard";

/** 用户消息若以 `!` 开头则是 shell 快捷命令，返回命令文本；否则 undefined */
function shellCommandOf(message?: ChatMessage): string | undefined {
  if (!message || message.role !== "user") return undefined;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  return text.startsWith("!") ? text : undefined;
}

/** 工具消息的 tool_result 文本（shell 输出/错误） */
function toolResultOf(message?: ChatMessage): string {
  if (!message || message.role !== "tool") return "";
  return message.content
    .filter((block) => block.type === "tool_result")
    .map((block) => block.content ?? "")
    .join("\n");
}

export function ExecutionTrack({ session, cleared, streamText, thinkingText, permissions, onPermissionDone, onPermissionError, onSendToAgent }: {
  session: SessionDetail;
  cleared?: { uptoIndex: number; at: string };
  streamText: string;
  thinkingText?: string;
  permissions: PermissionRequest[];
  onPermissionDone(requestId: string): void;
  onPermissionError?(message: string): void;
  onSendToAgent?(cmd: string, output: string): void;
}): ReactElement {
  const trackRef = useRef<HTMLDivElement>(null);
  // 用户位于底部附近时新内容自动贴底；上翻阅读时不打扰
  const [pinned, setPinned] = useState(true);

  // jsdom 无 Element.scrollTo，测试环境回退到 scrollTop
  const scrollToBottom = (smooth = false): void => {
    const element = trackRef.current;
    if (!element) return;
    if (smooth && typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  };

  useEffect(() => {
    if (pinned) scrollToBottom();
  }, [pinned, session.messages.length, streamText, thinkingText, permissions.length]);

  return (
    <div className="execution-track-wrap">
      <div
        className="execution-track"
        ref={trackRef}
        onScroll={() => {
          const element = trackRef.current;
          if (element) setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
        }}
      >
        {session.messages.length === 0 && !streamText && (
          <p className="track-empty">还没有消息。在下方描述要完成的任务，开始第一项作业。</p>
        )}
        {session.messages.map((message, index) => {
          // shell 快捷命令的结果卡（user `!cmd` + tool_result 配对）附「发给 agent」按钮
          const shellCmd = message.role === "tool" ? shellCommandOf(session.messages[index - 1]) : undefined;
          return (
            <Fragment key={message.id}>
              {cleared && Math.min(cleared.uptoIndex, session.messages.length) === index && (
                <div className="context-cleared-divider" role="separator">上下文已清空（历史保留）</div>
              )}
              <MessageCard message={message} />
              {shellCmd && onSendToAgent && (
                <button
                  className="send-to-agent"
                  onClick={() => onSendToAgent(shellCmd, toolResultOf(message))}
                >
                  <Icon name="send" size={11} /> 发给 agent
                </button>
              )}
            </Fragment>
          );
        })}
        {cleared && Math.min(cleared.uptoIndex, session.messages.length) === session.messages.length && (
          <div className="context-cleared-divider" role="separator">上下文已清空（历史保留）</div>
        )}
        {(streamText || thinkingText) && (
          <article className="message assistant live">
            <span className="track-node" aria-hidden />
            <div className="message-meta">
              <span className="message-author">OpenWebCode</span>
              <span>正在输出</span>
            </div>
            {thinkingText && (
              <details className="thinking">
                <summary>思考过程</summary>
                <pre>{thinkingText}</pre>
              </details>
            )}
            {streamText && <Markdown>{streamText}</Markdown>}
            <span className="cursor" aria-hidden />
          </article>
        )}
        {permissions.map((permission) => (
          <PermissionCard key={permission.requestId} permission={permission} sessionId={session.id} onDone={onPermissionDone} onError={onPermissionError} />
        ))}
      </div>
      {!pinned && (
        <button
          className="scroll-bottom"
          onClick={() => {
            scrollToBottom(true);
            setPinned(true);
          }}
        >
          <Icon name="arrow-down" size={13} /> 回到底部
        </button>
      )}
    </div>
  );
}
