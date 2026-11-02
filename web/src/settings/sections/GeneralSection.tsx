import { useState, type ReactElement } from "react";
import { desktopNotifyPermission, requestDesktopNotifyPermission, type DesktopNotifyPermission } from "../../lib/desktop-notify";
import { useSendKey, setSendKey, useDesktopNotify, setDesktopNotify } from "../../app/prefs-store";
import { layout } from "../../workbench/layout";
import { useI18n } from "../../i18n";
import { ServerSettingsFields } from "./ServerSettingsFields";
import { useConfirmDialog } from "../../components/ConfirmDialog";
import { Segmented, SettingsCard, SettingsRow, Switch } from "../controls";

export function GeneralSection({ onDirtyChange }: {
  onDirtyChange?(dirty: boolean): void;
}): ReactElement {
  const { t } = useI18n();
  const sendKey = useSendKey();
  const desktopNotify = useDesktopNotify();
  // 浏览器通知权限：渲染时读一次，请求后刷新；denied 时如实展示「浏览器已拒绝」
  const [notifyPermission, setNotifyPermission] = useState<DesktopNotifyPermission>(() => desktopNotifyPermission());
  const { ask: askResetLayout, dialogElement: resetLayoutDialog } = useConfirmDialog();
  const requestNotify = (): void => {
    void requestDesktopNotifyPermission().then((permission) => {
      setNotifyPermission(permission);
      if (permission === "granted") setDesktopNotify(true);
    });
  };
  const onToggleDesktopNotify = (checked: boolean): void => {
    if (!checked) {
      setDesktopNotify(false);
      return;
    }
    requestNotify();
  };
  const permissionLabel = notifyPermission === "granted"
    ? t("浏览器已允许", "Allowed in this browser")
    : notifyPermission === "denied"
      ? t("浏览器已拒绝", "Blocked by this browser")
      : notifyPermission === "unsupported"
        ? t("当前浏览器不支持", "Not supported in this browser")
        : t("尚未授权", "Not granted yet");
  return (
    <>
      <SettingsCard title={t("输入", "Input")}>
        <SettingsRow label={t("发送方式", "Send shortcut")}>
          <Segmented
            ariaLabel={t("发送方式", "Send shortcut")}
            value={sendKey}
            onChange={(value) => setSendKey(value)}
            options={[
              { value: "enter", label: t("Enter 发送", "Enter") },
              { value: "ctrl-enter", label: t("Ctrl+Enter 发送", "Ctrl+Enter") },
            ]}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("通知", "Notifications")}>
        <SettingsRow
          inline
          label={t("桌面通知", "Desktop notifications")}
          description={t("页面在后台时弹出系统通知：权限待批、等待回复、任务完成或失败。", "Show system notifications while the page is in the background: permission requests, pending replies, and run completion or failure.")}
        >
          <Switch checked={desktopNotify} onChange={onToggleDesktopNotify} label={t("桌面通知", "Desktop notifications")} disabled={notifyPermission === "unsupported"} />
        </SettingsRow>
        <SettingsRow label={t("浏览器权限", "Browser permission")} description={permissionLabel}>
          {(notifyPermission === "denied" || notifyPermission === "default") && (
            <button type="button" className="btn small" onClick={requestNotify}>{t("重新请求", "Request again")}</button>
          )}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("布局", "Layout")}>
        <SettingsRow label={t("复原界面布局", "Reset layout")} description={t("会话栏宽度与折叠、底部面板高度与开合保存在本机。", "The session rail width and collapsed state, plus bottom-panel height and visibility, are saved locally.")}>
          <button
            type="button"
            className="btn small"
            onClick={() => askResetLayout({
              title: t("复原界面布局？", "Reset layout?"),
              body: t("会话栏、侧边栏与底部面板将回到默认尺寸和开合状态。", "The session rail, sidebar, and bottom panel will return to their default size and visibility."),
              confirmLabel: t("复原", "Reset"),
              danger: false,
              onConfirm: () => layout.resetLayout(),
            })}
          >
            {t("重置布局为默认", "Reset layout")}
          </button>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard className="settings-card-server" title={t("语言、货币与模式", "Language, currency, and mode")}>
        <ServerSettingsFields
          showGroup={(groupId) => groupId === "general"}
          note={["模型回复的默认语言、计费币种与 Chat 模式开关（界面语言在「外观」页签切换，两者相互独立）。", "Default language for model replies, the billing currency, and the Chat mode toggle (the interface language is switched in the Appearance tab; the two are independent)."]}
          onDirtyChange={onDirtyChange}
        />
      </SettingsCard>
      {resetLayoutDialog}
    </>
  );
}
