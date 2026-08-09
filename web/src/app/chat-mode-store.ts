// 聊天模式全局 UI 状态：Python 沙盒运行态、消息运行态等按会话键控的轻量状态。
// 由 chat-mode 组件的 SSE 事件处理写入，组件经 useStore 订阅。
import { createStore } from "./store";

/** Python 沙盒状态：对齐 server python_status SSE 事件（preparing/ready/error），idle 为未初始化。 */
export type ChatPythonStatus = "idle" | "preparing" | "ready" | "error";

export interface ChatModeState {
  /** 按会话键控的 Python 沙盒状态；缺省视为 idle。 */
  pythonStatus: Record<string, ChatPythonStatus>;
  /** 按会话键控的消息运行态（connected/delta/done/stopped/error 事件驱动）；缺省 false。 */
  running: Record<string, boolean>;
}

export const chatModeStore = createStore<ChatModeState>({ pythonStatus: {}, running: {} });

export const chatMode = {
  setPythonStatus(sessionId: string, status: ChatPythonStatus): void {
    chatModeStore.set((previous) => ({
      pythonStatus: { ...previous.pythonStatus, [sessionId]: status },
    }));
  },
  setRunning(sessionId: string, running: boolean): void {
    chatModeStore.set((previous) => ({
      running: { ...previous.running, [sessionId]: running },
    }));
  },
};
