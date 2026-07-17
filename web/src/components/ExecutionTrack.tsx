import { useEffect, useRef, useState, type ReactElement } from "react";
import type { SessionDetail } from "../lib/contracts";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { MessageCard } from "./MessageCard";
import { PermissionCard, type PermissionRequest } from "./PermissionCard";

export function ExecutionTrack({ session, streamText, thinkingText, permissions, onPermissionDone }: {
  session: SessionDetail;
  streamText: string;
  thinkingText?: string;
  permissions: PermissionRequest[];
  onPermissionDone(requestId: string): void;
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
        {session.messages.map((message) => <MessageCard key={message.id} message={message} />)}
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
          <PermissionCard key={permission.requestId} permission={permission} sessionId={session.id} onDone={onPermissionDone} />
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
