import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { DEFAULT_KEYBINDINGS, formatCombo, isMacPlatform } from "../../commands/keybindings";
import { getCommand } from "../../commands/registry";

/**
 * 快捷键分区（0.4.0 Phase 5b）：如实列出默认键位集与命令标题（与速查表同源）。
 * 0.4.0 不支持自定义键位，仅展示。
 */
export function ShortcutsSection(): ReactElement {
  const { t } = useI18n();
  const isMac = isMacPlatform();
  return (
    <>
      <p className="settings-note">{t("默认键位集（暂不支持自定义）。mod 在 Windows/Linux 为 Ctrl，macOS 为 Cmd。", "Default keybindings (customization is not supported yet). mod is Ctrl on Windows/Linux and Cmd on macOS.")}</p>
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
    </>
  );
}
