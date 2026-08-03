/**
 * 键盘快捷方式表格：速查浮层（ShortcutsDialog）与设置页签（ShortcutsSection）共用的唯一实现，
 * 键位与命令标题源自 commands/keybindings 注册表。0.4.0 不支持自定义键位，仅展示。
 */
import { useMemo, type ReactElement } from "react";
import { DEFAULT_KEYBINDINGS, formatCombo, isMacPlatform } from "../commands/keybindings";
import { getCommand } from "../commands/registry";
import { useI18n } from "../i18n";

export function ShortcutsTable(): ReactElement {
  const { t } = useI18n();
  const isMac = useMemo(isMacPlatform, []);
  return (
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
  );
}
