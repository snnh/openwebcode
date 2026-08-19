// 消息列表：REST 拉历史 + SSE 增量（delta/done/error/stopped/python_status/tool_call/connected）。
// 流式渲染复用 chat/stream-buffer（rAF 合批），滚动跟随复用 chat/scroll-controller（上翻不拽回）。
// reloadToken 由父组件在发送成功后递增——自己刚发的 user 消息立刻可见，不等 done 才刷新。
import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ui } from "../app/ui-store";
import { chatMode } from "../app/chat-mode-store";
import { api, ApiError } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { streamBuffer, useStreamBlocks, type StreamBlock } from "../chat/stream-buffer";
import { createScrollFollower, type ScrollFollower } from "../chat/scroll-controller";
import { ThinkingBlock } from "../chat/MessageCard";
import { ChatBlocks } from "./ChatBlocks";
import type { ChatMessage, ChatStreamEvent } from "./types";

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
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followerRef = useRef<ScrollFollower | undefined>(undefined);
  const streamingBlocks = useStreamBlocks(sessionId);
  // 块引用级 join 缓存：stream-buffer 提交时未触碰的块保持引用稳定，直接复用上次 join 结果，
  // 流式期间每帧只重 join 末尾活跃块，不再 O(全长) 复制
  const joinCacheRef = useRef(new WeakMap<StreamBlock, string>());
  const joinBlock = (block: StreamBlock): string => {
    const cached = joinCacheRef.current.get(block);
    if (cached !== undefined) return cached;
    const joined = block.parts.join("");
    joinCacheRef.current.set(block, joined);
    return joined;
  };
  // 文本与思考分通道：文本走 MarkdownLazy 流式渲染，思考块渲染为流式 ThinkingBlock（对齐工作台）
  const streamingText = streamingBlocks.filter((block) => block.kind === "text").map(joinBlock).join("");
  const thinkingBlocks = streamingBlocks.filter((block) => block.kind === "thinking");
  // 图片 ref 路由回调按会话稳定（避免击穿消息项 memo）
  const resolveImageRef = useCallback((ref: string): string => `/api/chat/sessions/${sessionId}/images/${ref}`, [sessionId]);

  function follower(): ScrollFollower {
    followerRef.current ??= createScrollFollower();
    return followerRef.current;
  }

  // 滚动容器挂载/卸载；following 变化经订阅进 React 状态（仅布尔翻转，驱动「回到底部」浮钮）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const instance = follower();
    instance.attach(el);
    const unsubscribe = instance.onFollowingChange(setFollowing);
    return () => {
      unsubscribe();
      instance.detach();
    };
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

  const loadMessages = useCallback(async (): Promise<void> => {
    try {
      const data = await api.chatSession(sessionId);
      setMessages(data.messages ?? []);
    } catch {
      // 拉取失败保持现有列表
    }
  }, [sessionId]);

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
        } else if (data.type === "thinking_delta") {
          // 思考增量进 thinking 通道（stream-buffer 按块缓冲，thinking 与 text 分块渲染）
          streamBuffer.queueDelta(sessionId, data.text ?? "", true);
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
  }, [messages.length, streamingText]);

  const handleRetry = useCallback(async (messageId: string): Promise<void> => {
    try {
      await api.chatRetry(sessionId, messageId);
      // 清空本地流式缓冲，新分支内容依赖 SSE 推流渲染；done 后刷新活动路径
      streamBuffer.clear(sessionId);
      setError(undefined);
      setMaxTurns(false);
      setRunning(true);
      chatMode.setRunning(sessionId, true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        ui.notify(t("对话正在运行中，请稍后再试", "Chat is running; try again later"), "error");
      } else {
        ui.notify(t("重新生成失败", "Regenerate failed"), "error");
      }
    }
  }, [sessionId, t]);

  // 编辑重发：与 retry 同语义（回溯长出文本已编辑的新分支），202 后走同一接管逻辑
  const handleEdit = useCallback(async (messageId: string, text: string): Promise<void> => {
    try {
      await api.chatEdit(sessionId, messageId, text);
      streamBuffer.clear(sessionId);
      setError(undefined);
      setMaxTurns(false);
      setRunning(true);
      chatMode.setRunning(sessionId, true);
      void loadMessages();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        ui.notify(t("对话正在运行中，请稍后再试", "Chat is running; try again later"), "error");
      } else {
        ui.notify(t("编辑重发失败", "Edit & resend failed"), "error");
      }
    }
  }, [sessionId, t, loadMessages]);

  const handleCopy = useCallback((message: ChatMessage): void => {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => (current === message.id ? undefined : current)), 1500);
    });
  }, []);

  const isEmpty = messages.length === 0 && !streamingText && !running && !error;

  return (
    <div className="chat-messages-wrap">
      <div className="chat-messages" ref={scrollRef}>
        <div className="chat-messages-inner">
        {disconnected && (
          <p className="chat-muted-hint">{t("连接中断，正在重连…", "Connection lost, reconnecting…")}</p>
        )}
        {messages.map((msg) => (
          <ChatMessageItem
            key={msg.id}
            message={msg}
            copied={copiedId === msg.id}
            resolveImageRef={resolveImageRef}
            onCopy={handleCopy}
            onRetry={handleRetry}
            onEdit={handleEdit}
          />
        ))}
        {thinkingBlocks.length > 0 && (
          <div className="chat-message assistant">
            <div className="chat-bubble">
              {thinkingBlocks.map((block) => (
                <ThinkingBlock key={block.id} text={joinBlock(block)} streaming />
              ))}
            </div>
          </div>
        )}
        {streamingText !== "" && (
          <div className="chat-message assistant">
            <div className="chat-bubble">
              <MarkdownLazy text={streamingText} />
            </div>
          </div>
        )}
        {running && streamingText === "" && thinkingBlocks.length === 0 && (
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
      {!following && (
        <button
          type="button"
          className="scroll-bottom"
          aria-label={t("回到底部", "Jump to bottom")}
          onClick={() => follower().scrollToBottom(true)}
        >
          <Icon name="arrow-down" size={13} /> <span className="scroll-bottom-label">{t("回到底部", "Jump to bottom")}</span>
        </button>
      )}
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

/**
 * 历史消息项（memo）：消息对象引用稳定即跳过渲染。
 * 流式期间 streamingBlocks 每个 rAF 提交换引用会带着列表重渲染，
 * 无 memo 时全部历史消息（含内嵌 base64 图片）每帧重建。
 */
const ChatMessageItem = memo(function ChatMessageItem({ message, copied, resolveImageRef, onCopy, onRetry, onEdit }: {
  message: ChatMessage;
  copied: boolean;
  resolveImageRef(ref: string): string;
  onCopy(message: ChatMessage): void;
  onRetry(messageId: string): void;
  onEdit(messageId: string, text: string): void;
}): ReactElement {
  const { t } = useI18n();
  // 用户消息编辑重发：就地展开 textarea，确认后经 edit 路由长出新分支
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const messageText = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  // 仅纯文本用户消息可编辑（带图片的消息经编辑重发会丢图片块，不开放）
  const canEdit = message.role === "user" && !message.content.some((block) => block.type === "image");
  return (
    <div className={`chat-message ${message.role}`}>
      {editing ? (
        <div className="chat-bubble chat-edit-bubble">
          <textarea
            className="chat-edit-textarea"
            value={draft}
            aria-label={t("编辑消息", "Edit message")}
            rows={Math.min(12, Math.max(2, draft.split("\n").length))}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <div className="chat-edit-actions">
            <button type="button" className="btn small" onClick={() => setEditing(false)}>{t("取消", "Cancel")}</button>
            <button
              type="button"
              className="btn small primary"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false);
                onEdit(message.id, draft);
              }}
            >
              {t("保存并发送", "Save & send")}
            </button>
          </div>
        </div>
      ) : (
        <div className="chat-bubble">
          <ChatBlocks content={message.content} resolveImageRef={resolveImageRef} />
        </div>
      )}
      {message.role === "assistant" && (
        <div className="actions">
          <button
            className="icon-btn"
            aria-label={copied ? t("已复制", "Copied") : t("复制", "Copy")}
            title={copied ? t("已复制", "Copied") : t("复制", "Copy")}
            onClick={() => onCopy(message)}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
          <button
            className="icon-btn"
            aria-label={t("重新生成", "Regenerate")}
            title={t("重新生成", "Regenerate")}
            onClick={() => void onRetry(message.id)}
          >
            <Icon name="undo" />
          </button>
        </div>
      )}
      {canEdit && !editing && (
        <div className="actions">
          <button
            className="icon-btn"
            aria-label={t("编辑重发", "Edit & resend")}
            title={t("编辑重发", "Edit & resend")}
            onClick={() => {
              setDraft(messageText);
              setEditing(true);
            }}
          >
            <Icon name="edit" />
          </button>
        </div>
      )}
    </div>
  );
});
