/**
 * 统一浮层对话框（wb-overlay 体系）：backdrop 点击关闭、Esc 关闭（document capture）、
 * role="dialog" + aria-modal、初始聚焦、Tab 焦点循环、关闭后焦点归还触发元素。
 * 原生 <dialog> 体系（ConfirmDialog/SettingsDialog/NewSessionDialog）不走这里。
 */
import { useEffect, useRef, type ReactElement, type ReactNode, type RefObject } from "react";

const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 浮层对话框行为 hook：Esc 关闭、焦点循环、初始聚焦、焦点归还。
 * Esc 在 document capture 阶段拦截并 stopPropagation，避免触发全局快捷键（如 Esc 中断运行）。
 */
function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  { open, initialFocus, onClose }: { open: boolean; initialFocus?: string; onClose(): void },
): void {
  useEffect(() => {
    if (!open) return undefined;
    const dialog = ref.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 初始聚焦：优先 initialFocus 选择器命中的元素，否则对话框本身（tabIndex=-1 才可聚焦）
    const target = (initialFocus ? dialog?.querySelector<HTMLElement>(initialFocus) : undefined) ?? dialog;
    target?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      // 焦点陷阱：Tab/Shift+Tab 在对话框内循环，不逃到遮罩下的页面（对齐 aria-modal 语义）
      if (event.key === "Tab" && dialog) {
        const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusables.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previouslyFocused?.focus();
    };
  }, [ref, open, initialFocus, onClose]);
}

export function Overlay({ open, label, className, initialFocus, onClose, children }: {
  open: boolean;
  /** 对话框 aria-label（i18n 后的文案） */
  label: string;
  /** 附加在 .wb-overlay 上的修饰类（如 "command-palette"） */
  className?: string;
  /** 打开时优先聚焦的元素选择器（相对对话框）；默认聚焦对话框本身 */
  initialFocus?: string;
  onClose(): void;
  children: ReactNode;
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, { open, ...(initialFocus !== undefined ? { initialFocus } : {}), onClose });

  if (!open) return null;

  return (
    <div className="wb-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={`wb-overlay${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
