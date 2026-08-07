import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { ShortcutsTable } from "../../dialogs/ShortcutsTable";

/**
 * 快捷键分区（0.4.0 Phase 5b）：与速查浮层共用 ShortcutsTable（键位注册表单一来源）。
 * 0.4.0 不支持自定义键位，仅展示。
 */
export function ShortcutsSection(): ReactElement {
  const { t } = useI18n();
  return (
    <>
      <p className="settings-note">{t("默认键位集（暂不支持自定义）。mod 在 Windows/Linux 为 Ctrl，macOS 为 Cmd。", "Default keybindings (customization is not supported yet). mod is Ctrl on Windows/Linux and Cmd on macOS.")}</p>
      <ShortcutsTable />
    </>
  );
}
