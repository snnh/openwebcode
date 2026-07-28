import type { ReactElement } from "react";
import type { SendKey } from "../../lib/prefs";
import { useI18n } from "../../i18n";
import { ServerSettingsFields } from "./ServerSettingsFields";

export function GeneralSection({ sendKey, setSendKey, onResetLayout, onDirtyChange }: {
  sendKey: SendKey;
  setSendKey(value: SendKey): void;
  onResetLayout(): void;
  onDirtyChange?(dirty: boolean): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <>
      <h3>{t("发送方式", "Send shortcut")}</h3>
      <div className="settings-row" role="radiogroup" aria-label={t("发送方式", "Send shortcut")}>
        <label className="theme-option">
          <input type="radio" name="send-key" checked={sendKey === "enter"} onChange={() => setSendKey("enter")} />
          {t("Enter 发送", "Send with Enter")}
        </label>
        <label className="theme-option">
          <input type="radio" name="send-key" checked={sendKey === "ctrl-enter"} onChange={() => setSendKey("ctrl-enter")} />
          {t("Ctrl+Enter 发送", "Send with Ctrl+Enter")}
        </label>
      </div>
      <h3>{t("布局", "Layout")}</h3>
      <p className="settings-note">{t("会话栏宽度/折叠、底部面板高度与开合保存在本机。", "The session rail width and collapsed state, plus bottom-panel height and visibility, are saved locally.")}</p>
      <button className="btn small" onClick={onResetLayout}>{t("重置布局为默认", "Reset layout")}</button>
      <h3>{t("语言与货币", "Language and currency")}</h3>
      <ServerSettingsFields
        showGroup={(groupId) => groupId === "general"}
        note={["模型回复的默认语言与计费币种（界面语言在「外观」页签切换，两者相互独立）。", "Default language for model replies and the billing currency (the interface language is switched in the Appearance tab; the two are independent)."]}
        onDirtyChange={onDirtyChange}
      />
    </>
  );
}
