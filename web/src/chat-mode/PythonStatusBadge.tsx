// Python 沙盒状态徽标：订阅 chat-mode-store 中按会话键控的状态。
// 状态由 ChatMessageList 的 SSE python_status 事件写入；未初始化（idle）保持朴素 .pill。
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { useStore } from "../app/store";
import { chatModeStore } from "../app/chat-mode-store";

export function PythonStatusBadge({ sessionId }: { sessionId: string }): ReactElement {
  const { t } = useI18n();
  const status = useStore(chatModeStore, (s) => s.pythonStatus[sessionId] ?? "idle");

  const label = status === "preparing" ? t("启动中", "Preparing")
    : status === "ready" ? t("就绪", "Ready")
    : status === "error" ? t("失败", "Failed")
    : t("未初始化", "Not initialized");

  const cls = status === "preparing" ? "pill amber"
    : status === "ready" ? "pill ok"
    : status === "error" ? "pill danger"
    : "pill";

  return <span className={cls}>{label}</span>;
}
