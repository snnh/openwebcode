/**
 * 键盘快捷方式速查（`?` 打开，0.4.0 Phase 5a §6.3）：
 * 如实列出默认键位集与对应命令标题。
 */
import { useMemo, type ReactElement } from "react";
import { DEFAULT_KEYBINDINGS, formatCombo, isMacPlatform } from "../commands/keybindings";
import { getCommand } from "../commands/registry";
import { useI18n } from "../i18n";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }): ReactElement | null {
  const { t } = useI18n();
  const isMac = useMemo(isMacPlatform, []);
  if (!open) return null;

  return (
    <div className="wb-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wb-overlay shortcuts-dialog" role="dialog" aria-modal="true" aria-label={t("键盘快捷方式", "Keyboard Shortcuts")}>
        <header className="wb-overlay-header">
          <h2>{t("键盘快捷方式", "Keyboard Shortcuts")}</h2>
          <button className="icon-btn" aria-label={t("关闭", "Close")} onClick={onClose}>✕</button>
        </header>
        <table className="shortcuts-table">
          <tbody>
            {DEFAULT_KEYBINDINGS.map((binding) => {
              const command = getCommand(binding.command);
              return (
                <tr key={`${binding.command}-${binding.key}`}>
                  <td>{command ? t(command.title.zh, command.title.en) : binding.command}</td>
                  <td><kbd>{formatCombo(binding.key, isMac)}</kbd></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="wb-overlay-hint">{t("按 Esc 关闭；F6 在界面区域间轮换焦点", "Press Esc to close; F6 cycles focus between regions")}</p>
      </div>
    </div>
  );
}
