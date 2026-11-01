// Python 沙盒状态徽标：订阅 chat-mode-store 中按会话键控的状态。
// idle（未初始化）时徽标不占位；preparing/ready/error 才显示，避免顶栏长期挂一条无信息状态。
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { useStore } from "../app/store";
import { chatModeStore } from "../app/chat-mode-store";

export function PythonStatusBadge({ sessionId }: { sessionId: string }): ReactElement | null {
  const { t } = useI18n();
  const status = useStore(chatModeStore, (s) => s.pythonStatus[sessionId] ?? "idle");

  if (status === "idle") return null;

  const label = status === "preparing" ? t("启动中", "Preparing")
    : status === "ready" ? t("就绪", "Ready")
    : t("失败", "Failed");

  const cls = status === "preparing" ? "pill amber"
    : status === "ready" ? "pill ok"
    : "pill danger";

  return <span className={cls}>{label}</span>;
}
