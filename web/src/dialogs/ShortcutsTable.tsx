/**
 * 键盘快捷方式表格：设置「快捷键」页签的唯一实现，键位与命令标题源自 app/commands 注册表。
 * 不支持自定义键位，仅展示。
 */
import { useMemo, type ReactElement } from "react";
import { DEFAULT_KEYBINDINGS, formatCombo, getCommand, isMacPlatform } from "../app/commands";
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
