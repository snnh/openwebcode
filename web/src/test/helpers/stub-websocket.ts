import { afterEach, beforeEach, vi } from "vitest";

export interface StubSocket {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: () => void;
  send: (data?: unknown) => void;
}

/** 当前文件内已创建的 stub socket（vitest 按文件隔离模块态）。 */
export const sockets: StubSocket[] = [];

let seq = 0;

/**
 * 注册 beforeEach/afterEach：安装 StubWebSocket 全局类 + matchMedia 兜底，
 * 收尾 vi.unstubAllGlobals 并还原原始 WebSocket。在 describe 或文件顶层调用一次。
 */
export function setupStubWebSocket(): void {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    sockets.length = 0;
    seq = 0;
    originalWebSocket = globalThis.WebSocket;
    class StubWebSocket implements StubSocket {
      readyState = 1;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor() { sockets.push(this); }
      close(): void { this.readyState = 3; }
      send(): void { /* no-op */ }
      addEventListener(): void { /* no-op */ }
      removeEventListener(): void { /* no-op */ }
    }
    vi.stubGlobal("WebSocket", StubWebSocket);
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() { /* no-op */ }, removeListener() { /* no-op */ }, addEventListener() { /* no-op */ }, removeEventListener() { /* no-op */ }, dispatchEvent() { return false; } })) as unknown as typeof window.matchMedia;
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });
}

export function lastSocket(): StubSocket {
  return sockets[sockets.length - 1]!;
}

/** 向 socket 推一帧 server 事件（seq 自增；调用方自行包 act()）。 */
export function emitEvent(
  socket: StubSocket,
  type: string,
  payload: unknown,
  options?: { sessionId?: string; sessionSeq?: number },
): void {
  seq += 1;
  socket.onmessage?.({
    data: JSON.stringify({
      source: "server",
      type,
      sessionId: options?.sessionId ?? "s1",
      seq,
      sessionSeq: options?.sessionSeq ?? seq,
      createdAt: "2026-07-17T00:00:00.000Z",
      payload,
    }),
  } as MessageEvent);
}
