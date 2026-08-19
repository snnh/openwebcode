/**
 * 键盘快捷方式表格：设置「快捷键」页签的唯一实现（速查入口 shift+? 也指向本页）。
 * 展示与分发一致的合并注册表（默认 + 自定义覆盖）；点键位进入录制模式
 * （按组合键确定，Esc 取消），冲突检测拒绝保存；支持单行恢复默认与整体重置。
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { DEFAULT_KEYBINDINGS, mergeKeybindings, formatCombo, getCommand, isMacPlatform, comboFromEvent } from "../app/commands";
import { useKeybindingOverrides, setKeybinding, resetKeybinding, resetAllKeybindings } from "../app/prefs-store";
import { useI18n } from "../i18n";

export function ShortcutsTable(): ReactElement {
  const { t } = useI18n();
  const isMac = useMemo(isMacPlatform, []);
  const overrides = useKeybindingOverrides();
  // 与分发一致的合并注册表（useGlobalKeybindings 同款合并逻辑）
  const bindings = useMemo(() => mergeKeybindings(DEFAULT_KEYBINDINGS, overrides), [overrides]);
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // capture 阶段拦截：stopImmediatePropagation 挡住窗口冒泡阶段的全局分发，避免一键双触发
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.key === "Escape") { setRecording(null); return; }
      const combo = comboFromEvent(event);
      if (!combo) return;
      const clash = bindings.some((binding) => binding.command !== recording && binding.key === combo);
      if (clash) { setConflict(combo); setRecording(null); return; }
      setKeybinding(recording, combo);
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, bindings]);

  const overriddenCount = Object.keys(overrides).length;

  return (
    <>
      {conflict && (
        <p className="panel-error">
          {t(`组合键 ${conflict} 已被其他命令占用，未保存。`, `Combo ${conflict} is already used by another command; not saved.`)}
        </p>
      )}
      <table className="shortcuts-table">
        <tbody>
          {bindings.map((binding) => {
            const command = getCommand(binding.command);
            const isOverridden = binding.command in overrides;
            const isRecording = recording === binding.command;
            return (
              <tr key={binding.command} className={isRecording ? "recording" : undefined}>
                <td>{command ? t(command.title.zh, command.title.en) : binding.command}</td>
                <td>
                  {isRecording ? (
                    <kbd className="recording">{t("按下新组合键…（Esc 取消）", "Press new combo… (Esc to cancel)")}</kbd>
                  ) : (
                    <button
                      type="button"
                      className="shortcut-combo"
                      onClick={() => { setConflict(null); setRecording(binding.command); }}
                      title={t("点击录制新键位", "Click to record a new keybinding")}
                    >
                      <kbd>{formatCombo(binding.key, isMac)}</kbd>
                    </button>
                  )}
                </td>
                <td>
                  {isOverridden && (
                    <button type="button" className="shortcut-reset" onClick={() => { setConflict(null); resetKeybinding(binding.command); }}>
                      {t("恢复默认", "Reset")}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {overriddenCount > 0 && (
        <div className="shortcuts-footer">
          <button type="button" onClick={() => { setConflict(null); resetAllKeybindings(); }}>
            {t(`重置全部（${overriddenCount} 项自定义）`, `Reset all (${overriddenCount} custom)`) }
          </button>
        </div>
      )}
    </>
  );
}
