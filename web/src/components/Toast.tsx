import { useEffect, type ReactElement } from "react";
import { m } from "motion/react";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";
import { useMotionPreference } from "../lib/motion-pref";

interface Notice {
  kind: "info" | "error";
  text: string;
}

export function Toast({ notice, onDismiss }: { notice: Notice; onDismiss(): void }): ReactElement {
  const { t } = useI18n();
  const { reduced } = useMotionPreference();
  const isError = notice.kind === "error";
  useEffect(() => {
    // error 常驻不自动关闭：报错信息常需读完（含命令输出、路径）再处理，6 秒自动消失会漏掉关键内容，
    // 只由用户手动关闭；info 等提示仍 6 秒后自动消失。
    if (isError) return;
    const timer = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss, isError]);
  return (
    <m.div
      className={`toast${isError ? " error" : ""}`}
      role={isError ? "alert" : "status"}
      initial={reduced ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: reduced ? 0 : 0.18, ease: [0.2, 0, 0, 1] }}
    >
      <span>{notice.text}</span>
      <button onClick={onDismiss} aria-label={t("关闭通知", "Dismiss notification")}><Icon name="x" size={14} /></button>
    </m.div>
  );
}
