// 删除会话确认对话框：ConfirmDialog 的薄封装（保留原 props 供 App.tsx 使用）。
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { ConfirmDialog } from "./ConfirmDialog";

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
  return (
    <ConfirmDialog
      open={open}
      title={t("删除会话", "Delete session")}
      body={t(`删除会话「${title}」？`, `Delete session “${title}”?`)}
      warning={running
        ? t("该会话正在运行，服务端会拒绝删除。请先在会话中中断任务，再删除。", "This session is running and the server will reject the delete. Stop the job first, then delete.")
        : t("删除后不可恢复。", "This cannot be undone.")}
      confirmLabel={t("删除", "Delete")}
      confirmDisabled={running}
      confirmDisabledReason={running ? t("请先中断运行中的任务", "Stop the running job first") : undefined}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
