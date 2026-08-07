import { useState, type ReactElement } from "react";
import { desktopNotifyPermission, requestDesktopNotifyPermission, type DesktopNotifyPermission } from "../../lib/desktop-notify";
import { useSendKey, setSendKey, useDesktopNotify, setDesktopNotify } from "../../app/prefs-store";
import { layout } from "../../workbench/layout";
import { useI18n } from "../../i18n";
import { ServerSettingsFields } from "./ServerSettingsFields";

export function GeneralSection({ onDirtyChange }: {
  onDirtyChange?(dirty: boolean): void;
}): ReactElement {
  const { t } = useI18n();
  const sendKey = useSendKey();
  const desktopNotify = useDesktopNotify();
  // 浏览器通知权限：渲染时读一次，请求后刷新；denied 时如实展示「浏览器已拒绝」
  const [notifyPermission, setNotifyPermission] = useState<DesktopNotifyPermission>(() => desktopNotifyPermission());
  const onToggleDesktopNotify = (checked: boolean): void => {
    if (!checked) {
      setDesktopNotify(false);
      return;
    }
    void requestDesktopNotifyPermission().then((permission) => {
      setNotifyPermission(permission);
      if (permission === "granted") setDesktopNotify(true);
    });
  };
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
      <h3>{t("桌面通知", "Desktop notifications")}</h3>
      <div className="settings-row">
        <label className="theme-option">
          <input type="checkbox" checked={desktopNotify} onChange={(event) => onToggleDesktopNotify(event.target.checked)} />
          {t("页面在后台时弹出系统通知（权限待批、等待回复、任务完成/失败）", "Show system notifications while the page is in the background (permission requests, pending replies, run finished/failed)")}
        </label>
      </div>
      {notifyPermission === "denied" && (
        <p className="settings-note">{t("浏览器已拒绝桌面通知权限，需在浏览器站点设置中手动允许。", "Desktop notifications are blocked by the browser; allow them in the browser's site settings.")}</p>
      )}
      {notifyPermission === "unsupported" && (
        <p className="settings-note">{t("当前浏览器不支持桌面通知。", "This browser does not support desktop notifications.")}</p>
      )}
      <h3>{t("布局", "Layout")}</h3>
      <p className="settings-note">{t("会话栏宽度/折叠、底部面板高度与开合保存在本机。", "The session rail width and collapsed state, plus bottom-panel height and visibility, are saved locally.")}</p>
      <button className="btn small" onClick={() => layout.resetLayout()}>{t("重置布局为默认", "Reset layout")}</button>
      <h3>{t("语言与货币", "Language and currency")}</h3>
      <ServerSettingsFields
        showGroup={(groupId) => groupId === "general"}
        note={["模型回复的默认语言与计费币种（界面语言在「外观」页签切换，两者相互独立）。", "Default language for model replies and the billing currency (the interface language is switched in the Appearance tab; the two are independent)."]}
        onDirtyChange={onDirtyChange}
      />
    </>
  );
}
