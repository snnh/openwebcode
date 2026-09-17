import { afterEach, beforeEach, vi } from "vitest";

interface StubSocket {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: () => void;
  send: (data?: unknown) => void;
}

/** 当前文件内已创建的 stub socket（vitest 按文件隔离模块态）。 */
const sockets: StubSocket[] = [];

/**
 * 注册 beforeEach/afterEach：安装 StubWebSocket 全局类 + matchMedia 兜底，
 * 收尾 vi.unstubAllGlobals 并还原原始 WebSocket。在 describe 或文件顶层调用一次。
 */
export function setupStubWebSocket(): void {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    sockets.length = 0;
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
