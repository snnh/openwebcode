// 消息列表：REST 拉历史 + SSE 增量（delta/done/error/stopped/python_status/tool_call/connected）。
// 流式渲染复用 chat/stream-buffer（rAF 合批），滚动跟随复用 chat/scroll-controller（上翻不拽回）。
// reloadToken 由父组件在发送成功后递增——自己刚发的 user 消息立刻可见，不等 done 才刷新。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ui } from "../app/ui-store";
import { chatMode } from "../app/chat-mode-store";
import { streamBuffer, useStreamBlocks } from "../chat/stream-buffer";
import { createScrollFollower, type ScrollFollower } from "../chat/scroll-controller";
import { ChatBlocks } from "./ChatBlocks";
import type { ChatMessage, ChatSessionDetail, ChatStreamEvent } from "./types";

export function ChatMessageList({ sessionId, reloadToken }: {
  sessionId: string;
  /** 递增触发历史重拉（发送成功后父组件 bump，让自己的消息立即可见）。 */
  reloadToken?: number;
}): ReactElement {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [maxTurns, setMaxTurns] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  /** 工具循环进行中：最近一个 tool_call 的名字（delta/done 时清空）。 */
  const [toolActivity, setToolActivity] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();
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
    setToolActivity(undefined);
    streamBuffer.clear(sessionId);
    void loadMessages();
    // 切换会话后回到贴底跟随态
    follower().scrollToBottom();
    // sessionId / reloadToken 变化时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reloadToken]);

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
          setToolActivity(undefined);
          setRunning(true);
          chatMode.setRunning(sessionId, true);
        } else if (data.type === "tool_call") {
          setToolActivity(data.name ?? "tool");
          setRunning(true);
          chatMode.setRunning(sessionId, true);
        } else if (data.type === "python_status") {
          if (data.status) chatMode.setPythonStatus(sessionId, data.status);
        } else if (data.type === "stopped") {
          // 用户停止：已累积的部分文本由 server 落盘，刷新历史即可拿到，不加错误样式
          streamBuffer.finish();
          streamBuffer.clear(sessionId);
          setToolActivity(undefined);
          setRunning(false);
          chatMode.setRunning(sessionId, false);
          void loadMessages();
        } else if (data.type === "done") {
          streamBuffer.clear(sessionId);
          setToolActivity(undefined);
          setRunning(false);
          chatMode.setRunning(sessionId, false);
          setMaxTurns(data.stopReason === "max_turns");
          void loadMessages();
        } else if (data.type === "error") {
          setError(data.error ?? t("未知错误", "Unknown error"));
          streamBuffer.clear(sessionId);
          setToolActivity(undefined);
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

  function handleCopy(message: ChatMessage): void {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => (current === message.id ? undefined : current)), 1500);
    });
  }

  const isEmpty = messages.length === 0 && !streamingText && !running && !error;

  return (
    <div className="chat-messages" ref={scrollRef}>
      <div className="chat-messages-inner">
        {disconnected && (
          <p className="chat-muted-hint">{t("连接中断，正在重连…", "Connection lost, reconnecting…")}</p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-message ${msg.role}`}>
            <div className="chat-bubble">
              <ChatBlocks
                content={msg.content}
                resolveImageRef={(ref) => `/api/chat/sessions/${sessionId}/images/${ref}`}
              />
            </div>
            {msg.role === "assistant" && (
              <div className="actions">
                <button
                  className="icon-btn"
                  aria-label={copiedId === msg.id ? t("已复制", "Copied") : t("复制", "Copy")}
                  title={copiedId === msg.id ? t("已复制", "Copied") : t("复制", "Copy")}
                  onClick={() => handleCopy(msg)}
                >
                  <Icon name={copiedId === msg.id ? "check" : "copy"} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={t("重新生成", "Regenerate")}
                  title={t("重新生成", "Regenerate")}
                  onClick={() => void handleRetry(msg.id)}
                >
                  <Icon name="undo" />
                </button>
              </div>
            )}
          </div>
        ))}
        {streamingText !== "" && (
          <div className="chat-message assistant">
            <div className="chat-bubble">
              <MarkdownLazy text={streamingText} />
            </div>
          </div>
        )}
        {running && streamingText === "" && (
          <div className="chat-message assistant">
            <div className="chat-bubble">
              {toolActivity ? (
                <span className="chat-tool-activity">
                  <Icon name="wrench" size={12} />
                  {toolActivity}
                </span>
              ) : (
                <span className="chat-thinking" aria-label={t("正在思考…", "Thinking…")}>
                  <i /><i /><i />
                </span>
              )}
            </div>
          </div>
        )}
        {maxTurns && (
          <p className="chat-muted-hint">{t("达到最大轮次", "Max turns reached")}</p>
        )}
        {error && <div className="panel-error" role="alert">{error}</div>}
        {isEmpty && (
          <div className="chat-greeting">
            <h1>{t("有什么可以帮忙的？", "What can I help with?")}</h1>
          </div>
        )}
      </div>
    </div>
  );
}

/** 流式文本渲染：与历史消息同走 Markdown；包一层仅为语义清晰。 */
function MarkdownLazy({ text }: { text: string }): ReactElement {
  return (
    <>
      <Markdown>{text}</Markdown>
      <span className="chat-streaming" />
    </>
  );
}
