// 消息列表：REST 拉历史 + SSE 增量（delta/done/error/stopped/python_status/connected）。
// 流式渲染复用 chat/stream-buffer（rAF 合批），滚动跟随复用 chat/scroll-controller（上翻不拽回）。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";
import { ui } from "../app/ui-store";
import { chatMode } from "../app/chat-mode-store";
import { streamBuffer, useStreamBlocks } from "../chat/stream-buffer";
import { createScrollFollower, type ScrollFollower } from "../chat/scroll-controller";
import type { ChatMessage, ChatSessionDetail, ChatStreamEvent, MessageContent } from "./types";

export function ChatMessageList({ sessionId }: { sessionId: string }): ReactElement {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [maxTurns, setMaxTurns] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followerRef = useRef<ScrollFollower | undefined>(undefined);
  const streamingBlocks = useStreamBlocks(sessionId);
  const streamingText = streamingBlocks.map((block) => block.parts.join("")).join("");

  function follower(): ScrollFollower {
    followerRef.current ??= createScrollFollower();
    return followerRef.current;
  }

  // 滚动容器挂载/卸载
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const instance = follower();
    instance.attach(el);
    return () => instance.detach();
  }, []);

  useEffect(() => {
    setError(undefined);
    setMaxTurns(false);
    streamBuffer.clear(sessionId);
    void loadMessages();
    // 切换会话后回到贴底跟随态
    follower().scrollToBottom();
    // sessionId 切换时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function loadMessages(): Promise<void> {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as ChatSessionDetail;
        setMessages(data.messages ?? []);
      }
    } catch {
      // 拉取失败保持现有列表
    }
  }

  // SSE 增量通道：出错不 close，交给浏览器自动重连（connected 帧带 running 可自愈）
  useEffect(() => {
    if (!sessionId) return undefined;

    const es = new EventSource(`/api/chat/sessions/${sessionId}/stream`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as ChatStreamEvent;
        if (data.type === "connected") {
          setRunning(data.running ?? false);
          chatMode.setRunning(sessionId, data.running ?? false);
          setDisconnected(false);
        } else if (data.type === "delta") {
          streamBuffer.queueDelta(sessionId, data.text ?? "");
          setRunning(true);
          chatMode.setRunning(sessionId, true);
        } else if (data.type === "python_status") {
          if (data.status) chatMode.setPythonStatus(sessionId, data.status);
        } else if (data.type === "stopped") {
          // 用户停止：已累积的部分文本由 server 落盘，刷新历史即可拿到，不加错误样式
          streamBuffer.finish();
          streamBuffer.clear(sessionId);
          setRunning(false);
          chatMode.setRunning(sessionId, false);
          void loadMessages();
        } else if (data.type === "done") {
          streamBuffer.clear(sessionId);
          setRunning(false);
          chatMode.setRunning(sessionId, false);
          setMaxTurns(data.stopReason === "max_turns");
          void loadMessages();
        } else if (data.type === "error") {
          setError(data.error ?? t("未知错误", "Unknown error"));
          streamBuffer.clear(sessionId);
          setRunning(false);
          chatMode.setRunning(sessionId, false);
        }
      } catch {
        // 忽略无法解析的帧（如 keepalive 注释不会走到这里）
      }
    };

    es.onerror = () => {
      // 不 close：EventSource 自动重连，connected 帧到达后恢复状态
      setDisconnected(true);
    };

    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 内容变化时仅跟随态吸底；用户上翻后不打断
  useEffect(() => {
    follower().notifyContentChanged();
  });

  async function handleRetry(messageId: string): Promise<void> {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages/${messageId}/retry`, {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 202) {
        // 清空本地流式缓冲，新分支内容依赖 SSE 推流渲染；done 后刷新活动路径
        streamBuffer.clear(sessionId);
        setError(undefined);
        setMaxTurns(false);
        setRunning(true);
        chatMode.setRunning(sessionId, true);
        return;
      }
      if (res.status === 409) {
        ui.notify(t("对话正在运行中，请稍后再试", "Chat is running; try again later"), "error");
      } else {
        ui.notify(t("重新生成失败", "Regenerate failed"), "error");
      }
    } catch {
      ui.notify(t("重新生成失败", "Regenerate failed"), "error");
    }
  }

  return (
    <div className="chat-messages" ref={scrollRef}>
      <div className="chat-messages-inner">
        {disconnected && (
          <p className="chat-muted-hint">{t("连接中断，正在重连…", "Connection lost, reconnecting…")}</p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-message ${msg.role}`}>
            {msg.content.map((block, index) => renderBlock(block, index, sessionId))}
            {msg.role === "assistant" && (
              <div className="actions">
                <button
                  className="btn small"
                  onClick={() => {
                    const text = msg.content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text ?? "")
                      .join("\n");
                    void navigator.clipboard.writeText(text);
                  }}
                >
                  {t("复制", "Copy")}
                </button>
                <button className="btn small" onClick={() => void handleRetry(msg.id)}>
                  {t("重新生成", "Regenerate")}
                </button>
              </div>
            )}
          </div>
        ))}
        {streamingText && (
          <div className="chat-message assistant">
            <Markdown>{streamingText}</Markdown>
            <span className="chat-streaming" />
          </div>
        )}
        {maxTurns && (
          <p className="chat-muted-hint">{t("达到最大轮次", "Max turns reached")}</p>
        )}
        {error && <div className="panel-error" role="alert">{error}</div>}
        {messages.length === 0 && !streamingText && !running && !error && (
          <div className="chat-empty">
            <p>{t("发送消息开始对话", "Send a message to start chatting")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function renderBlock(block: MessageContent, index: number, sessionId: string): ReactElement | null {
  if (block.type === "text") {
    return <Markdown key={index}>{block.text ?? ""}</Markdown>;
  }
  if (block.type === "image") {
    // 内联块用 data: URI；ref 块经 images 路由取字节（uploads/|generated/）
    const src = block.data
      ? `data:${block.mediaType ?? "image/png"};base64,${block.data}`
      : block.ref
        ? `/api/chat/sessions/${sessionId}/images/${block.ref}`
        : undefined;
    if (!src) return null;
    return <img key={index} src={src} alt="" className="chat-block-image" />;
  }
  if (block.type === "tool_call") {
    return (
      <div key={index} className="chat-tool-result">
        <span className="pill">{block.name ?? "tool"}</span>
      </div>
    );
  }
  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    return (
      <div key={index} className="chat-tool-result">
        <pre>{content}</pre>
      </div>
    );
  }
  return null;
}
