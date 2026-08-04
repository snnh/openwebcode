// 通用确认对话框：替代原生 window.confirm（移动端/iframe 体验差，且样式不可控）。
// 原生 <dialog> 自带焦点陷阱与 Esc onCancel；初始焦点在「取消」（安全默认），背板点击放弃。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";

export function ConfirmDialog({ open, title, body, warning, confirmLabel, danger = true, confirmDisabled = false, confirmDisabledReason, onCancel, onConfirm }: {
  open: boolean;
  /** 对话框标题与 aria-label（调用方完成 i18n） */
  title: string;
  /** 正文（确认的问题句） */
  body: string;
  /** 追加警示（如「不可恢复」） */
  warning?: string;
  /** 确认按钮文案（调用方完成 i18n） */
  confirmLabel: string;
  /** 确认按钮是否危险样式（默认 true） */
  danger?: boolean;
  confirmDisabled?: boolean;
  /** 禁用原因（确认按钮 title 提示） */
  confirmDisabledReason?: string;
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
      aria-label={title}
      onClose={onCancel}
      onClick={(event) => {
        // 点击背板取消
        if (event.target === dialogRef.current) onCancel();
      }}
    >
      <h2>{title}</h2>
      <p>{body}</p>
      {warning && <p className="confirm-warning">{warning}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" autoFocus onClick={onCancel}>{t("取消", "Cancel")}</button>
        <button
          type="button"
          className={danger ? "btn danger" : "btn primary"}
          disabled={confirmDisabled}
          title={confirmDisabledReason}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export interface ConfirmRequest {
  title: string;
  body: string;
  warning?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
}

/**
 * 命令式确认 hook：`ask({...})` 打开对话框，确认后先关再执行 onConfirm；
 * 返回的 dialogElement 挂在组件 JSX 末尾。同一时刻只持有一个待决请求（模态语义）。
 */
export function useConfirmDialog(): { ask(request: ConfirmRequest): void; dialogElement: ReactElement } {
  const [request, setRequest] = useState<ConfirmRequest>();
  const close = (): void => setRequest(undefined);
  const dialogElement = (
    <ConfirmDialog
      open={request !== undefined}
      title={request?.title ?? ""}
      body={request?.body ?? ""}
      {...(request?.warning !== undefined ? { warning: request.warning } : {})}
      confirmLabel={request?.confirmLabel ?? ""}
      danger={request?.danger ?? true}
      onCancel={close}
      onConfirm={() => {
        const run = request?.onConfirm;
        close();
        run?.();
      }}
    />
  );
  return { ask: setRequest, dialogElement };
}
