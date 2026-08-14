/**
 * 桌面通知封装（提交⑪）：Notification API + 本机开关持久化。
 * 开关默认关；开启需浏览器授权（Notification.requestPermission）。
 * 仅页面失焦（document.hidden）且权限 granted 时弹通知；点击聚焦窗口并回调跳转。
 * 全部直接读全局对象，测试用 vi.stubGlobal / spyOnProperty 即可替换。
 */

const ENABLED_KEY = "owc-desktop-notify";

export type DesktopNotifyPermission = "unsupported" | "denied" | "granted" | "default";

export function loadDesktopNotifyEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveDesktopNotifyEnabled(value: boolean): void {
  try {
    window.localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
  } catch {
    // 持久化失败不影响使用
  }
}

/** 浏览器当前通知权限：不支持 / 已拒绝 / 已允许 / 未询问。 */
export function desktopNotifyPermission(): DesktopNotifyPermission {
  if (!("Notification" in window) || typeof window.Notification === "undefined") return "unsupported";
  return window.Notification.permission;
}

/** 请求通知权限（仅 default 状态会真正弹浏览器询问）；返回请求后的权限状态。 */
export async function requestDesktopNotifyPermission(): Promise<DesktopNotifyPermission> {
  const current = desktopNotifyPermission();
  if (current !== "default") return current;
  try {
    return await window.Notification.requestPermission();
  } catch {
    return desktopNotifyPermission();
  }
}

interface DesktopNotifyInput {
  title: string;
  body: string;
  /** 点击通知：先聚焦窗口，再执行跳转（如切换到对应会话） */
  onClick?(): void;
}

/**
 * 失焦门控的通知发送：开关关闭、页面可见、权限未授予或不支持时不弹。
 * 返回是否真的弹出了通知。
 */
export function maybeDesktopNotify(enabled: boolean, input: DesktopNotifyInput): boolean {
  if (!enabled) return false;
  if (!document.hidden) return false;
  if (desktopNotifyPermission() !== "granted") return false;
  try {
    const notification = new window.Notification(input.title, { body: input.body });
    notification.onclick = () => {
      window.focus();
      input.onClick?.();
    };
    return true;
  } catch {
    return false;
  }
}
