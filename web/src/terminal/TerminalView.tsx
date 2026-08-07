/**
 * 终端标签内容：每会话一个真 PTY。
 * 激活标签时建立 WS（/api/sessions/:id/terminal），上行 open/in/resize/close 帧，
 * 下行 opened/out/exit/error 帧（data 一律 base64）；xterm.js 懒加载为独立 chunk。
 * 与 Composer 的 `!` 命令通道（走 agent 权限链与沙盒）语义区分：本终端在宿主机以应用身份运行，不经沙盒。
 * props 瘦身为 sessionId：cwd 经共享的会话详情查询取，通知走 ui.notify，设置深链 ui.openSettings("remote")。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ITheme, Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { api } from "../lib/api";
import type { AuthStatus } from "../lib/contracts";
import { useI18n } from "../i18n";
import { useSessionQuery } from "../app/queries";
import { ui } from "../app/ui-store";
import { AUTH_STATUS_QUERY_KEY } from "../components/AuthGate";
import { loadXterm } from "../components/xterm-loader";

/** 上行帧（与 server 逐字一致） */
type TerminalClientFrame =
  | { type: "open"; cols: number; rows: number; shell?: string }
  | { type: "in"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" };

/** 下行帧（与 server 逐字一致） */
type TerminalServerFrame =
  | { type: "opened" }
  | { type: "out"; data: string }
  | { type: "exit"; code?: number }
  | { type: "error"; message: string };

type PtyPhase = "connecting" | "open" | "exited" | "disconnected" | "error";

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function cssVar(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || undefined;
}

/** xterm 主题跟随亮/暗：直接取当前 CSS 变量值，切换主题时经 MutationObserver 重取 */
function xtermThemeFromCssVars(): ITheme {
  return {
    background: cssVar("--panel"),
    foreground: cssVar("--text"),
    cursor: cssVar("--accent"),
    cursorAccent: cssVar("--panel"),
    selectionBackground: cssVar("--accent-soft"),
  };
}

/** 门槛不满足时的状态块：两条门槛 ✅/❌ + 设置远程访问区深链；不渲染 xterm */
function TerminalGate({ status }: { status: AuthStatus }): ReactElement {
  const { t } = useI18n();
  const totpOk = status.totpEnabled;
  const hostOk = !status.gateReasons.includes("host_not_loopback_or_lan");
  return (
    <div className="terminal-gate">
      <p className="terminal-gate-title">{t("终端功能暂不可用：需同时满足以下两项。", "Terminal is not available yet: both conditions below must be met.")}</p>
      <ul className="totp-gate-list">
        <li>{totpOk ? "✅" : "❌"} {t("TOTP 已开启", "TOTP enabled")}</li>
        <li>{hostOk ? "✅" : "❌"} {t("监听地址为回环或局域网", "Listen address is loopback or LAN")}</li>
      </ul>
      <button type="button" onClick={() => ui.openSettings("remote")}>
        {t("前往「设置 → 远程访问」", "Open Settings → Remote Access")}
      </button>
    </div>
  );
}

/** 单个 PTY 终端：xterm 实例 + WS 生命周期；generation 自增即整体重建（重连 = 新 PTY） */
function PtyTerminal({ sessionId }: { sessionId: string }): ReactElement {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<PtyPhase>("connecting");
  const [detail, setDetail] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let socketOpen = false;
    let terminal: XtermTerminal | undefined;
    let themeObserver: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const send = (frame: TerminalClientFrame): void => {
      if (socketOpen && socket) socket.send(JSON.stringify(frame));
    };

    void (async () => {
      const host = hostRef.current;
      if (!host) return;
      let xterm: Awaited<ReturnType<typeof loadXterm>>;
      try {
        xterm = await loadXterm();
      } catch {
        if (!disposed) {
          setPhase("error");
          setDetail(t("终端组件加载失败。", "Could not load the terminal component."));
          ui.notify(t("终端组件加载失败", "Could not load the terminal component"), "error");
        }
        return;
      }
      if (disposed) return;

      terminal = new xterm.Terminal({
        fontSize: 12.5,
        cursorBlink: true,
        theme: xtermThemeFromCssVars(),
        ...(cssVar("--font-mono") ? { fontFamily: cssVar("--font-mono") } : {}),
      });
      const fit: FitAddon = new xterm.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      try { fit.fit(); } catch { /* jsdom 等无真实布局环境 */ }

      // 亮/暗主题切换 → 重取 CSS 变量值映射进 xterm
      themeObserver = new MutationObserver(() => {
        if (terminal) terminal.options.theme = xtermThemeFromCssVars();
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });

      // 容器尺寸变化 → fit → 尺寸经 onResize 上行
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => { try { fit.fit(); } catch { /* 无布局环境忽略 */ } });
        resizeObserver.observe(host);
      }

      terminal.onData((data) => send({ type: "in", data: encodeBase64(data) }));
      terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));

      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sessions/${encodeURIComponent(sessionId)}/terminal`);
      socket.onopen = () => {
        socketOpen = true;
        send({ type: "open", cols: terminal?.cols ?? 80, rows: terminal?.rows ?? 24 });
      };
      socket.onmessage = (message) => {
        if (disposed) return;
        let frame: TerminalServerFrame;
        try {
          frame = JSON.parse(String(message.data)) as TerminalServerFrame;
        } catch {
          return;
        }
        switch (frame.type) {
          case "opened":
            setPhase("open");
            break;
          case "out":
            terminal?.write(decodeBase64(frame.data));
            break;
          case "exit":
            setPhase("exited");
            setDetail(frame.code !== undefined ? String(frame.code) : undefined);
            break;
          case "error":
            setPhase("error");
            setDetail(frame.message);
            break;
        }
      };
      socket.onclose = () => {
        socketOpen = false;
        if (disposed) return;
        // 非主动断开：旧 PTY 已随 WS 被 server 关闭，提示重连（重连 = 新 PTY）
        setPhase((previous) => (previous === "exited" || previous === "error" ? previous : "disconnected"));
      };
    })();

    return () => {
      disposed = true;
      // 标签关闭/组件卸载：先上行 close 帧再关 WS
      send({ type: "close" });
      socketOpen = false;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
      }
      themeObserver?.disconnect();
      resizeObserver?.disconnect();
      terminal?.dispose();
    };
  }, [sessionId, generation]); // eslint-disable-line react-hooks/exhaustive-deps

  const reconnect = (): void => {
    setPhase("connecting");
    setDetail(undefined);
    setGeneration((previous) => previous + 1);
  };

  const statusText = phase === "connecting"
    ? t("正在连接终端…", "Connecting…")
    : phase === "exited"
      ? (detail !== undefined
        ? t(`进程已退出（退出码 ${detail}）。`, `Process exited (code ${detail}).`)
        : t("进程已退出。", "Process exited."))
      : phase === "disconnected"
        ? t("连接已断开，原终端会话已结束。", "Connection lost; the terminal session has ended.")
        : (detail ?? t("终端错误。", "Terminal error."));

  return (
    <div className="terminal-pty">
      <div className="terminal-pty-host" ref={hostRef} />
      {phase !== "open" && (
        <div className={`terminal-pty-status${phase === "error" ? " error" : ""}`} role={phase === "error" ? "alert" : "status"}>
          <span>{statusText}</span>
          {phase !== "connecting" && (
            <button type="button" onClick={reconnect}>{t("重新连接", "Reconnect")}</button>
          )}
        </div>
      )}
    </div>
  );
}

export function TerminalView({ sessionId }: { sessionId: string }): ReactElement {
  const { t } = useI18n();
  // cwd 展示用共享的会话详情缓存（ChatView 已挂载同一查询，不额外发请求）
  const detail = useSessionQuery(sessionId);
  // 与 AuthGate 同 key 共享缓存；retry:false 与全局一致
  const status = useQuery({ queryKey: AUTH_STATUS_QUERY_KEY, queryFn: api.authStatus, retry: false, staleTime: 5 * 60_000 });
  const cwd = detail.data?.cwd;

  return (
    <div className="terminal-view">
      {cwd && <div className="terminal-cwd mono" title={cwd}>{cwd}</div>}
      <div className="terminal-badge" role="note">{t("宿主机终端 · 以应用身份运行 · 不经沙盒", "Host terminal · runs as the app · not sandboxed")}</div>
      {status.isPending ? (
        <p className="terminal-note">{t("正在检查终端可用性…", "Checking terminal availability…")}</p>
      ) : status.isError ? (
        <p className="terminal-note" role="alert">{t("无法获取终端门槛状态。", "Could not load the terminal gate status.")}</p>
      ) : !status.data.terminalAvailable ? (
        <TerminalGate status={status.data} />
      ) : (
        <PtyTerminal sessionId={sessionId} />
      )}
    </div>
  );
}
