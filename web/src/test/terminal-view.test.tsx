import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "../terminal/TerminalView";
import type { AuthStatus } from "../lib/contracts";
import { api } from "../lib/api";
import { uiStore } from "../app/ui-store";
import { makeSession } from "./helpers/fixtures";
import { FakeFitAddon, FakeTerminal } from "./helpers/fake-xterm";
import { renderWithClient } from "./helpers/with-client";

vi.mock("../lib/api", () => ({
  api: {
    authStatus: vi.fn(),
    session: vi.fn(),
  },
}));

const authStatus = vi.mocked(api.authStatus);
const sessionQuery = vi.mocked(api.session);

const xtermState = { fail: false };
vi.mock("../components/xterm-loader", () => ({
  loadXterm: () => (xtermState.fail
    ? Promise.reject(new Error("boom"))
    : Promise.resolve({ Terminal: FakeTerminal, FitAddon: FakeFitAddon })),
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

const session = makeSession({ id: "s1", cwd: "/workspace/project", title: "终端测试" });

function gate(partial: Partial<AuthStatus>): AuthStatus {
  return { totpEnabled: true, authenticated: true, terminalAvailable: true, gateReasons: [], ...partial };
}

async function connectedPty(): Promise<{ socket: StubSocket; term: FakeTerminal }> {
  await waitFor(() => expect(StubSocket.instances).toHaveLength(1));
  const socket = StubSocket.instances[0]!;
  const term = FakeTerminal.instances[0]!;
  act(() => socket.onopen?.());
  return { socket, term };
}

describe("TerminalView（真 PTY）", () => {
  beforeEach(() => {
    authStatus.mockReset();
    sessionQuery.mockReset();
    sessionQuery.mockResolvedValue(session);
    FakeTerminal.instances.length = 0;
    StubSocket.instances.length = 0;
    xtermState.fail = false;
    vi.stubGlobal("WebSocket", StubSocket);
    // ui-store 全局单例：用例间复位提示与设置深链状态
    uiStore.set({ notice: undefined, notifications: [], settingsOpen: false, settingsTab: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("生命周期：open → out 写入 xterm → in/resize 上行 → 卸载发送 close 并关 WS", async () => {
    authStatus.mockResolvedValue(gate({}));
    const view = renderWithClient(<TerminalView sessionId="s1" />);

    // cwd 与宿主机语义徽章
    expect(await screen.findByText(/宿主机终端 · 以应用身份运行 · 不经沙盒/)).toBeInTheDocument();
    expect(await screen.findByText("/workspace/project")).toBeInTheDocument();

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

  it("门槛不满足：渲染两条门槛状态与设置深链（ui.openSettings(remote)），不建 WS 不渲染 xterm", async () => {
    authStatus.mockResolvedValue(gate({ totpEnabled: false, terminalAvailable: false, gateReasons: ["totp_disabled", "host_not_loopback_or_lan"] }));
    renderWithClient(<TerminalView sessionId="s1" />);

    expect(await screen.findByText(/终端功能暂不可用/)).toBeInTheDocument();
    expect(screen.getByText(/TOTP 已开启/).textContent).toContain("❌");
    expect(screen.getByText(/监听地址为回环或局域网/).textContent).toContain("❌");

    fireEvent.click(screen.getByRole("button", { name: /远程访问/ }));
    expect(uiStore.get().settingsOpen).toBe(true);
    expect(uiStore.get().settingsTab?.tab).toBe("remote");

    expect(StubSocket.instances).toHaveLength(0);
    expect(FakeTerminal.instances).toHaveLength(0);
  });

  it("exit 帧：显示进程已退出提示（含退出码）", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);
    const { socket } = await connectedPty();

    act(() => socket.emit({ type: "exit", code: 3 }));
    expect(await screen.findByText(/退出码 3/)).toBeInTheDocument();
  });

  it("连接断开（非主动关闭）显示重连提示；重连发起新 PTY", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);
    const { socket } = await connectedPty();

    act(() => socket.onclose?.());
    expect(await screen.findByText(/连接已断开/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(StubSocket.instances).toHaveLength(2));
  });

  it("error 帧：错误态以 role=alert 展示，可重连", async () => {
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);
    const { socket } = await connectedPty();
    act(() => socket.emit({ type: "error", message: "PTY 创建失败" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PTY 创建失败");
  });

  it("xterm 加载失败：错误态 + ui.notify 错误提示，不建 WS", async () => {
    xtermState.fail = true;
    authStatus.mockResolvedValue(gate({}));
    renderWithClient(<TerminalView sessionId="s1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("终端组件加载失败");
    await waitFor(() => expect(uiStore.get().notice).toEqual({ kind: "error", text: "终端组件加载失败" }));
    expect(StubSocket.instances).toHaveLength(0);
  });
});
