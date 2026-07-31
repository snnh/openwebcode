import { vi } from "vitest";

/** jsdom 无真实布局，xterm 以假实现替代（接口对齐组件用到的面，含实例追踪与事件注入） */
export class FakeTerminal {
  static instances: FakeTerminal[] = [];
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  written: string[] = [];
  disposed = false;
  private dataHandlers: Array<(data: string) => void> = [];
  private resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeTerminal.instances.push(this);
  }
  loadAddon(): void { /* no-op */ }
  open(): void { /* no-op */ }
  write(data: Uint8Array): void { this.written.push(new TextDecoder().decode(data)); }
  onData(handler: (data: string) => void): { dispose(): void } {
    this.dataHandlers.push(handler);
    return { dispose: () => undefined };
  }
  onResize(handler: (size: { cols: number; rows: number }) => void): { dispose(): void } {
    this.resizeHandlers.push(handler);
    return { dispose: () => undefined };
  }
  emitData(data: string): void { for (const handler of this.dataHandlers) handler(data); }
  emitResize(cols: number, rows: number): void { for (const handler of this.resizeHandlers) handler({ cols, rows }); }
  dispose(): void { this.disposed = true; }
}

export class FakeFitAddon {
  fit = vi.fn();
}
