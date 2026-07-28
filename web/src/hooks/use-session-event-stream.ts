import { useEffect, useRef, useState } from "react";
import type { AppEvent } from "../lib/contracts";

export interface SessionEventStreamOptions {
  sessionId?: string;
  onEvent(event: AppEvent): void;
  /** Lets callers flush transient UI buffers before a session switch/unmount. */
  onDisconnect?(): void;
}

export interface SessionEventStreamState {
  /** 连接断开后退避重连进行中；恢复（onopen）后归 false。仅作展示，不阻塞交互。 */
  reconnecting: boolean;
}

/**
 * Owns the lifecycle correctness of the session-scoped event socket. UI code
 * receives already de-duplicated, in-order events and only decides how to
 * render them. A socket generation is disposed on every session switch so an
 * old connection can never reconnect into the newly selected session.
 */
export function useSessionEventStream({ sessionId, onEvent, onDisconnect }: SessionEventStreamOptions): SessionEventStreamState {
  const onEventRef = useRef(onEvent);
  const onDisconnectRef = useRef(onDisconnect);
  const sessionSeq = useRef<Record<string, number>>({});
  const globalSeq = useRef(0);
  const seenEventIds = useRef<Set<string>>(new Set());
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onDisconnectRef.current = onDisconnect; }, [onDisconnect]);

  useEffect(() => {
    let retry = 0;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let disposed = false;
    const connect = (): void => {
      if (disposed) return;
      // 会话级订阅按该会话的 sessionSeq 续传；全局订阅（不传 sessionId）
      // 按事件的全局 seq 续传，重连后服务端补发缺口，去重逻辑不变。
      const after = sessionId ? sessionSeq.current[sessionId] ?? 0 : globalSeq.current;
      const query = new URLSearchParams({ after: String(after), ...(sessionId ? { sessionId } : {}) });
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events?${query}`);
      socket.onopen = () => {
        if (!disposed) setReconnecting(false);
      };
      socket.onmessage = (message) => {
        let event: AppEvent;
        try {
          event = JSON.parse(message.data) as AppEvent;
        } catch {
          return;
        }
        if (disposed) return;
        if (event.eventId) {
          if (seenEventIds.current.has(event.eventId)) return;
          seenEventIds.current.add(event.eventId);
          if (seenEventIds.current.size > 4_096) {
            const oldest = seenEventIds.current.values().next().value;
            if (oldest) seenEventIds.current.delete(oldest);
          }
        }
        if (typeof event.seq === "number" && event.seq > globalSeq.current) {
          globalSeq.current = event.seq;
        }
        if (event.sessionId && typeof event.sessionSeq === "number") {
          if (event.sessionSeq <= (sessionSeq.current[event.sessionId] ?? 0)) return;
          sessionSeq.current = { ...sessionSeq.current, [event.sessionId]: event.sessionSeq };
        }
        onEventRef.current(event);
      };
      socket.onclose = () => {
        if (disposed) return;
        setReconnecting(true);
        timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      disposed = true;
      setReconnecting(false);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
      }
      socket?.close();
      if (timer !== undefined) window.clearTimeout(timer);
      onDisconnectRef.current?.();
    };
  }, [sessionId]);
  return { reconnecting };
}
