// 删除会话确认对话框：替代原生 window.confirm，Esc/背板/取消均放弃，初始焦点在「取消」（安全默认）。
import { useEffect, useRef, type ReactElement } from "react";
import { useI18n } from "../i18n";

export function ConfirmDeleteDialog({ open, title, running = false, onCancel, onConfirm }: {
  open: boolean;
  /** 目标会话标题（仅展示用） */
  title: string;
  /** 会话正在运行时追加警示 */
  running?: boolean;
  onCancel(): void;
  onConfirm(): void;
}): ReactElement | null {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="session-dialog confirm-dialog"
      aria-label={t("删除会话", "Delete session")}
      onClose={onCancel}
      onClick={(event) => {
        // 点击背板取消
        if (event.target === dialogRef.current) onCancel();
      }}
    >
      <h2>{t("删除会话", "Delete session")}</h2>
      <p>
        {running
          ? t(`该会话正在运行。删除会话「${title}」？`, `This session is running. Delete session “${title}”?`)
          : t(`删除会话「${title}」？`, `Delete session “${title}”?`)}
      </p>
      <p className="confirm-warning">{t("删除后不可恢复。", "This cannot be undone.")}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" autoFocus onClick={onCancel}>{t("取消", "Cancel")}</button>
        <button type="button" className="btn danger" onClick={onConfirm}>{t("删除", "Delete")}</button>
      </div>
    </dialog>
  );
}
