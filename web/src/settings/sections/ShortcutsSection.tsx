import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { ShortcutsTable } from "../../dialogs/ShortcutsTable";

/**
 * 快捷键分区（0.4.0 Phase 5b → 1.9 自定义键位）：与速查浮层共用 ShortcutsTable
 * （键位注册表单一来源）；自定义覆盖存 localStorage（owc-keybindings），
 * 分发与展示统一走合并注册表。
 */
export function ShortcutsSection(): ReactElement {
  const { t } = useI18n();
  return (
    <>
      <p className="settings-note">{t("点击键位可录制自定义组合键；恢复默认或重置全部即时生效。mod 在 Windows/Linux 为 Ctrl，macOS 为 Cmd。", "Click a keybinding to record a custom combo; reset per-row or all at once. mod is Ctrl on Windows/Linux and Cmd on macOS.")}</p>
      <ShortcutsTable />
    </>
  );
}
