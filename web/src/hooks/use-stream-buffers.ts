import { useCallback, useRef, useState } from "react";

export interface StreamBuffers {
  /** 已提交的流式正文（按会话键控；append-only 分片，消费方 join 后渲染） */
  stream: Record<string, string[]>;
  /** 已提交的流式思考内容（按会话键控；append-only 分片） */
  thinkingStream: Record<string, string[]>;
  /** 追加一个 token delta；同一帧内的多个 delta 只提交一次状态 */
  queueDelta(sessionId: string, text: string, thinking?: boolean): void;
  /** 立即提交缓冲区中尚未落状态的 delta */
  flush(): void;
  /** 取消挂起的合批帧并立即提交（卸载/断线前调用，避免丢尾部 token） */
  finish(): void;
  /** run 结束且历史消息重新拉取后，清空该会话的临时流 */
  clear(sessionId: string): void;
  /** 会话删除时丢弃其已提交状态与未提交缓冲 */
  discard(sessionId: string): void;
}

/**
 * WebSocket 的 token delta 往往是很小的分片，逐片进 React 状态会导致每个 token
 * 一次整页渲染。这里把 delta 缓冲在 React 之外，每个动画帧最多提交一次；
 * 无 rAF 的环境（测试/SSR）退化为 80ms 定时器。
 * 状态保持 append-only 分片数组：每帧只追加入帧文本，不再复制累计全串
 * （旧实现每帧 `${prev}${delta}` 全量拷贝，长流下是 O(n²) 的分配 churn）。
 */
export function useStreamBuffers(): StreamBuffers {
  const [stream, setStream] = useState<Record<string, string[]>>({});
  const [thinkingStream, setThinkingStream] = useState<Record<string, string[]>>({});
  const streamBuffers = useRef<Record<string, string[]>>({});
  const thinkingBuffers = useRef<Record<string, string[]>>({});
  const flushHandle = useRef<number | undefined>(undefined);

  const flush = useCallback((): void => {
    flushHandle.current = undefined;
    const text = streamBuffers.current;
    const thinking = thinkingBuffers.current;
    streamBuffers.current = {};
    thinkingBuffers.current = {};
    if (Object.keys(text).length) {
      setStream((previous) => {
        const next = { ...previous };
        for (const [id, chunks] of Object.entries(text)) next[id] = [...(next[id] ?? []), chunks.join("")];
        return next;
      });
    }
    if (Object.keys(thinking).length) {
      setThinkingStream((previous) => {
        const next = { ...previous };
        for (const [id, chunks] of Object.entries(thinking)) next[id] = [...(next[id] ?? []), chunks.join("")];
        return next;
      });
    }
  }, []);

  const queueDelta = useCallback((sessionId: string, text: string, thinking = false): void => {
    const buffers = thinking ? thinkingBuffers.current : streamBuffers.current;
    (buffers[sessionId] ??= []).push(text);
    if (flushHandle.current !== undefined) return;
    flushHandle.current = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(flush)
      : window.setTimeout(flush, 80);
  }, [flush]);

  const finish = useCallback((): void => {
    if (flushHandle.current !== undefined) {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(flushHandle.current);
      else window.clearTimeout(flushHandle.current);
    }
    flush();
  }, [flush]);

  const clear = useCallback((sessionId: string): void => {
    setStream((value) => ({ ...value, [sessionId]: [] }));
    setThinkingStream((value) => ({ ...value, [sessionId]: [] }));
  }, []);

  const discard = useCallback((sessionId: string): void => {
    const removeKey = <T,>(previous: Record<string, T>): Record<string, T> => {
      if (!(sessionId in previous)) return previous;
      const { [sessionId]: _removed, ...remaining } = previous;
      return remaining;
    };
    setStream(removeKey);
    setThinkingStream(removeKey);
    delete streamBuffers.current[sessionId];
    delete thinkingBuffers.current[sessionId];
  }, []);

  return { stream, thinkingStream, queueDelta, flush, finish, clear, discard };
}
