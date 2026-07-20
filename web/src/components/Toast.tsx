import { useEffect, type ReactElement } from "react";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

export interface Notice {
  kind: "info" | "error";
  text: string;
}

export function Toast({ notice, onDismiss }: { notice: Notice; onDismiss(): void }): ReactElement {
  const { t } = useI18n();
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  const isError = notice.kind === "error";
  return (
    <div
      className="toast"
      role={isError ? "alert" : "status"}
      style={isError ? { borderColor: "var(--danger-border)", color: "var(--danger)" } : undefined}
    >
      <span>{notice.text}</span>
      <button onClick={onDismiss} aria-label={t("关闭通知", "Dismiss notification")}><Icon name="x" size={14} /></button>
    </div>
  );
}
