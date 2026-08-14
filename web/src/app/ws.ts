import type { AppEvent } from "../lib/contracts";

/**
 * 全局事件流（/api/events）连接：生命周期正确性归这里，UI 只处理已去重、有序的事件。
 * 框架无关（可单测）；React 侧由 App 装配层在 effect 中 createEventSocket/close。
 *
 * 语义与旧 use-session-event-stream 一致：
 * - 断线按全局 seq 续传（?after=），服务端补发缺口；eventId 去重（4096 上限 FIFO 淘汰）。
 * - 指数退避重连（500ms 起，2 倍递增，封顶 10s），握手成功重置。
 * - 断开持续约 1 秒才上报 reconnecting（短暂抖动不打扰）；握手成功立即清除。
 * - close code 1008（服务端拒绝握手，如 TOTP 票据失效）停止重连，交 API 401 拦截统一回落登录页。
 */

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  close(): void;
}

export interface EventSocketEnv {
  /** 完整 ws(s):// URL；缺省按 location 推导 /api/events */
  url?: string;
  /** WebSocket 构造注入（测试用假实现） */
  createSocket?: (url: string) => WebSocketLike;
  /** 重连横幅防抖（默认 1000ms）与退避参数（测试可调 0） */
  bannerDelayMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface EventSocketOptions {
  onEvent(event: AppEvent): void;
  onReconnecting?(reconnecting: boolean): void;
  /** 连接被显式关闭（组件卸载/App  teardown）时调用：用于冲刷流式缓冲 */
  onDisconnect?(): void;
}

export interface EventSocket {
  close(): void;
}

const SEEN_EVENT_IDS_LIMIT = 4_096;

export function createEventSocket(options: EventSocketOptions, env: EventSocketEnv = {}): EventSocket {
  const bannerDelayMs = env.bannerDelayMs ?? 1_000;
  const baseDelayMs = env.baseDelayMs ?? 500;
  const maxDelayMs = env.maxDelayMs ?? 10_000;
  const createSocket = env.createSocket ?? ((url: string) => new WebSocket(url) as WebSocketLike);
  let retry = 0;
  let socket: WebSocketLike | undefined;
  let timer: number | undefined;
  let bannerTimer: number | undefined;
  let disposed = false;
  let reconnectingShown = false;
  let globalSeq = 0;
  const sessionSeq: Record<string, number> = {};
  const seenEventIds = new Set<string>();

  const reportReconnecting = (value: boolean): void => {
    if (value === reconnectingShown) return;
    reconnectingShown = value;
    options.onReconnecting?.(value);
  };

  const clearBanner = (): void => {
    if (bannerTimer !== undefined) {
      window.clearTimeout(bannerTimer);
      bannerTimer = undefined;
    }
    reportReconnecting(false);
  };

  const connect = (): void => {
    if (disposed) return;
    // 全局订阅按事件的全局 seq 续传，重连后服务端补发缺口，去重逻辑不变
    const base = env.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`;
    const separator = base.includes("?") ? "&" : "?";
    socket = createSocket(`${base}${separator}after=${globalSeq}`);
    socket.onopen = () => {
      retry = 0;
      if (!disposed) clearBanner();
    };
    socket.onmessage = (message) => {
      let event: AppEvent;
      try {
        event = JSON.parse(message.data as string) as AppEvent;
      } catch {
        return;
      }
      if (disposed) return;
      if (event.eventId) {
        if (seenEventIds.has(event.eventId)) return;
        seenEventIds.add(event.eventId);
        if (seenEventIds.size > SEEN_EVENT_IDS_LIMIT) {
          const oldest = seenEventIds.values().next().value;
          if (oldest) seenEventIds.delete(oldest);
        }
      }
      if (typeof event.seq === "number" && event.seq > globalSeq) {
        globalSeq = event.seq;
      }
      if (event.sessionId && typeof event.sessionSeq === "number") {
        if (event.sessionSeq <= (sessionSeq[event.sessionId] ?? 0)) return;
        sessionSeq[event.sessionId] = event.sessionSeq;
      }
      options.onEvent(event);
    };
    socket.onclose = (event) => {
      if (disposed) return;
      // 1008 = 服务端拒绝握手（如 TOTP 登录失效）：停止退避重连，交由 API 401 拦截统一回落登录页
      if (event?.code === 1008) return;
      if (bannerTimer === undefined) {
        bannerTimer = window.setTimeout(() => {
          bannerTimer = undefined;
          if (!disposed) reportReconnecting(true);
        }, bannerDelayMs);
      }
      timer = window.setTimeout(connect, Math.min(maxDelayMs, baseDelayMs * 2 ** retry++));
    };
  };

  connect();

  return {
    close(): void {
      disposed = true;
      if (bannerTimer !== undefined) window.clearTimeout(bannerTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
      }
      if (timer !== undefined) window.clearTimeout(timer);
      reportReconnecting(false);
      options.onDisconnect?.();
    },
  };
}
