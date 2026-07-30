import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { TerminalView } from "../components/TerminalView";
import type { AuthStatus, SessionDetail } from "../lib/contracts";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: { authStatus: vi.fn() },
}));

const authStatus = vi.mocked(api.authStatus);

/** jsdom 无真实布局，xterm 以最小假实现替代（接口对齐本组件用到的面） */
class FakeTerminal {
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

class FakeFitAddon {
  fit = vi.fn();
}

vi.mock("../components/xterm-loader", () => ({
  loadXterm: () => Promise.resolve({ Terminal: FakeTerminal, FitAddon: FakeFitAddon }),
}));

class StubSocket {
  static instances: StubSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) { StubSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  emit(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  frames(): unknown[] { return this.sent.map((raw) => JSON.parse(raw) as unknown); }
}

const AT = "2026-07-28T00:00:00.000Z";

const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "终端测试",
  createdAt: AT,
  updatedAt: AT,
  messages: [],
};

function gate(partial: Partial<AuthStatus>): AuthStatus {
  return { totpEnabled: true, authenticated: true, terminalAvailable: true, gateReasons: [], ...partial };
}

function renderTerminal(node: ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

async function connectedPty(): Promise<{ socket: StubSocket; term: FakeTerminal }> {
  await waitFor(() => expect(StubSocket.instances).toHaveLength(1));
  const socket = StubSocket.instances[0]!;
  const term = FakeTerminal.instances[0]!;
  act(() => socket.onopen?.());
  return { socket, term };
}

describe("TerminalView（真 PTY，提交⑦）", () => {
  beforeEach(() => {
    authStatus.mockReset();
    FakeTerminal.instances.length = 0;
    StubSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", StubSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("生命周期：open → out 写入 xterm → in/resize 上行 → 卸载发送 close 并关 WS", async () => {
    authStatus.mockResolvedValue(gate({}));
    const view = renderTerminal(<TerminalView session={session} />);

    // 徽章如实标注宿主机终端语义
    expect(await screen.findByText(/宿主机终端 · 以应用身份运行 · 不经沙盒/)).toBeInTheDocument();

    await waitFor(() => expect(StubSocket.instances).toHaveLength(1));
    const { socket, term } = await connectedPty();
    expect(socket.url).toContain("/api/sessions/s1/terminal");
    expect(socket.frames()).toEqual([{ type: "open", cols: 80, rows: 24 }]);

    // opened 后状态条消失
    act(() => socket.emit({ type: "opened" }));
    await waitFor(() => expect(screen.queryByText(/正在连接终端/)).toBeNull());

    // out（base64）解码写进 xterm
    act(() => socket.emit({ type: "out", data: btoa("hello world") }));
    expect(term.written).toEqual(["hello world"]);

    // xterm 输入 → base64 上行 in；尺寸变化 → resize
    act(() => term.emitData("ls\r"));
    act(() => term.emitResize(100, 30));
    expect(socket.frames()[1]).toEqual({ type: "in", data: btoa("ls\r") });
    expect(socket.frames()[2]).toEqual({ type: "resize", cols: 100, rows: 30 });

    // 组件卸载：close 帧 + 关 WS + dispose xterm
    view.unmount();
    expect(socket.frames()[3]).toEqual({ type: "close" });
    expect(socket.closed).toBe(true);
    expect(term.disposed).toBe(true);
  });

  it("门槛不满足：渲染两条门槛状态与设置深链，不建 WS 不渲染 xterm", async () => {
    authStatus.mockResolvedValue(gate({ totpEnabled: false, terminalAvailable: false, gateReasons: ["totp_disabled", "host_not_loopback_or_lan"] }));
    const onOpenSettings = vi.fn();
    renderTerminal(<TerminalView session={session} onOpenSettings={onOpenSettings} />);

    expect(await screen.findByText(/终端功能暂不可用/)).toBeInTheDocument();
    expect(screen.getByText(/TOTP 已开启/).textContent).toContain("❌");
    expect(screen.getByText(/监听地址为回环或局域网/).textContent).toContain("❌");

    fireEvent.click(screen.getByRole("button", { name: /远程访问/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    expect(StubSocket.instances).toHaveLength(0);
    expect(FakeTerminal.instances).toHaveLength(0);
  });

  it("exit 帧：显示进程已退出提示（含退出码）", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderTerminal(<TerminalView session={session} />);
    const { socket } = await connectedPty();

    act(() => socket.emit({ type: "exit", code: 3 }));
    expect(await screen.findByText(/退出码 3/)).toBeInTheDocument();
  });

  it("连接断开（非主动关闭）显示重连提示；重连发起新 PTY", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderTerminal(<TerminalView session={session} />);
    const { socket } = await connectedPty();

    act(() => socket.onclose?.());
    expect(await screen.findByText(/连接已断开/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(StubSocket.instances).toHaveLength(2));
  });
});
