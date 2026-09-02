/**
 * 应用装配：全局事件流（ws）+ 事件路由（router）+ 通知通路的一次性接线。
 * createAppWiring 为框架无关工厂（可单测）；useAppWiring 是 React 生命周期 hook（App 顶层调用）。
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { AppEvent, Session, SubagentStartedEvent } from "../lib/contracts";
import { getDesktopNotify } from "./prefs-store";
import { maybeDesktopNotify } from "../lib/desktop-notify";
import { createEventRouter, type EventRouter } from "./event-router";
import { createEventSocket, type EventSocketEnv } from "./ws";
import { ui, uiStore } from "./ui-store";
import { live } from "./live-store";
import { streamBuffer, type StreamBuffer } from "../chat/stream-buffer";
import { clearOlderMessages } from "../chat/pagination-store";

interface AppWiringOptions {
  queryClient: QueryClient;
  /** 取最新 i18n t 函数（语言切换后通知文案跟随） */
  getT(): (chinese: string, english: string) => string;
  /** 会话列表快照（完成/桌面通知的标题来源） */
  getSessions(): Session[] | undefined;
  applyRunEvent(event: AppEvent): void;
  /** subagent.started 到达时回调（主区标签自动创建；useSubagentTabs.openFromStarted） */
  onSubagentStarted?(sessionId: string, payload: SubagentStartedEvent): void;
  onReconnecting?(reconnecting: boolean): void;
  /** 测试注入：假 WebSocket / 退避参数 */
  socketEnv?: EventSocketEnv;
  /** 测试注入：隔离的流式缓冲（默认应用级单例） */
  stream?: StreamBuffer;
  /** 桌面通知开关读取（默认读 prefs-store 镜像） */
  desktopNotifyEnabled?(): boolean;
}

interface AppWiring {
  router: EventRouter;
  close(): void;
}

export function createAppWiring(options: AppWiringOptions): AppWiring {
  const stream = options.stream ?? streamBuffer;
  const router = createEventRouter({
    queryClient: options.queryClient,
    getCurrentSessionId: () => uiStore.get().sessionId,
    getSessions: options.getSessions,
    t: (chinese, english) => options.getT()(chinese, english),
    notify: (text, kind) => ui.notify(text, kind),
    pushEventNotification: (text, kind, target) => ui.pushEventNotification(text, kind, target),
    // 页面失焦时的系统通知；点击聚焦窗口并跳到对应会话
    desktopNotify: ({ sessionId, title, body }) => {
      maybeDesktopNotify((options.desktopNotifyEnabled ?? getDesktopNotify)(), {
        title,
        body,
        onClick: () => ui.selectSession(sessionId),
      });
    },
    applyRunEvent: options.applyRunEvent,
    // 实时数据（子代理运行/活动条）直接写 live-store，组件经 useStore 选择器读取
    applyActivityEvent: (event) => live.applyActivityEvent(event),
    applySubagentEvent: (event) => live.applySubagentEvent(event, options.onSubagentStarted),
    applyCompactionEvent: (event) => live.applyCompactionEvent(event),
    clearRunningCompaction: (sessionId) => live.clearRunningCompaction(sessionId),
    stream,
    // resync 命中当前会话：分页缓存可能已过期，清空重建
    onResyncCurrent: (sessionId) => clearOlderMessages(sessionId),
  });
  const socket = createEventSocket(
    {
      onEvent: (event) => router.route(event),
      ...(options.onReconnecting ? { onReconnecting: options.onReconnecting } : {}),
      // 连接显式关闭（App teardown）：冲刷流式缓冲，避免丢尾部 token
      onDisconnect: () => stream.finish(),
    },
    options.socketEnv ?? {},
  );
  return { router, close: () => socket.close() };
}

interface UseAppWiringResult {
  reconnecting: boolean;
  /** 删除会话时清理路由的完成检测残留（router.forgetSession） */
  routerRef: MutableRefObject<EventRouter | undefined>;
}

/** App 顶层接线 hook：options 经 ref 取最新，socket/router 只建一次，卸载时关闭 */
export function useAppWiring(options: Omit<AppWiringOptions, "onReconnecting" | "socketEnv">): UseAppWiringResult {
  const [reconnecting, setReconnecting] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const routerRef = useRef<EventRouter | undefined>(undefined);
  const { queryClient } = options;

  useEffect(() => {
    const wiring = createAppWiring({
      queryClient,
      getT: () => optionsRef.current.getT(),
      getSessions: () => optionsRef.current.getSessions(),
      applyRunEvent: (event) => optionsRef.current.applyRunEvent(event),
      ...(optionsRef.current.onSubagentStarted ? { onSubagentStarted: (sessionId, payload) => optionsRef.current.onSubagentStarted!(sessionId, payload) } : {}),
      ...(optionsRef.current.desktopNotifyEnabled ? { desktopNotifyEnabled: () => optionsRef.current.desktopNotifyEnabled!() } : {}),
      onReconnecting: setReconnecting,
    });
    routerRef.current = wiring.router;
    return () => {
      routerRef.current = undefined;
      wiring.close();
    };
  }, [queryClient]);

  return { reconnecting, routerRef };
}
