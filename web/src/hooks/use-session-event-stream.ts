import { useEffect, useRef } from "react";
import type { AppEvent } from "../lib/contracts";

export interface SessionEventStreamOptions {
  sessionId?: string;
  onEvent(event: AppEvent): void;
  /** Lets callers flush transient UI buffers before a session switch/unmount. */
  onDisconnect?(): void;
}

/**
 * Owns the lifecycle correctness of the session-scoped event socket. UI code
 * receives already de-duplicated, in-order events and only decides how to
 * render them. A socket generation is disposed on every session switch so an
 * old connection can never reconnect into the newly selected session.
 */
export function useSessionEventStream({ sessionId, onEvent, onDisconnect }: SessionEventStreamOptions): void {
  const onEventRef = useRef(onEvent);
  const onDisconnectRef = useRef(onDisconnect);
  const sessionSeq = useRef<Record<string, number>>({});
  const seenEventIds = useRef<Set<string>>(new Set());

  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onDisconnectRef.current = onDisconnect; }, [onDisconnect]);

  useEffect(() => {
    let retry = 0;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let disposed = false;
    const connect = (): void => {
      if (disposed) return;
      const after = sessionId ? sessionSeq.current[sessionId] ?? 0 : 0;
      const query = new URLSearchParams({ after: String(after), ...(sessionId ? { sessionId } : {}) });
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events?${query}`);
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
        if (event.sessionId && typeof event.sessionSeq === "number") {
          if (event.sessionSeq <= (sessionSeq.current[event.sessionId] ?? 0)) return;
          sessionSeq.current = { ...sessionSeq.current, [event.sessionId]: event.sessionSeq };
        }
        onEventRef.current(event);
      };
      socket.onclose = () => {
        if (!disposed) timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      disposed = true;
      if (socket) {
        socket.onmessage = null;
        socket.onclose = null;
      }
      socket?.close();
      if (timer !== undefined) window.clearTimeout(timer);
      onDisconnectRef.current?.();
    };
  }, [sessionId]);
}
