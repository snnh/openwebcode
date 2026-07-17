import { useEffect, type ReactElement } from "react";
import { Icon } from "./Icon";

export function Toast({ message, onDismiss }: { message: string; onDismiss(): void }): ReactElement {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button onClick={onDismiss} aria-label="关闭通知"><Icon name="x" size={14} /></button>
    </div>
  );
}
