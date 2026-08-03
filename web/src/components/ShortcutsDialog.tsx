/**
 * 键盘快捷方式速查（`?` 打开，0.4.0 Phase 5a §6.3）：
 * 表格实现与设置页签共用（ShortcutsTable），键位源自 commands/keybindings 注册表。
 */
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { ShortcutsTable } from "./ShortcutsTable";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }): ReactElement | null {
  const { t } = useI18n();
  if (!open) return null;

  return (
    <div className="wb-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wb-overlay shortcuts-dialog" role="dialog" aria-modal="true" aria-label={t("键盘快捷方式", "Keyboard Shortcuts")}>
        <header className="wb-overlay-header">
          <h2>{t("键盘快捷方式", "Keyboard Shortcuts")}</h2>
          <button className="icon-btn" aria-label={t("关闭", "Close")} onClick={onClose}>✕</button>
        </header>
        <ShortcutsTable />
        <p className="wb-overlay-hint">{t("按 Esc 关闭；F6 在界面区域间轮换焦点", "Press Esc to close; F6 cycles focus between regions")}</p>
      </div>
    </div>
  );
}
