import type { SettingsView } from "../lib/contracts";

/** dsh 兼容模式的前端可见状态（来自服务端设置视图，热生效）。 */
export interface DshModeSettings {
  /** dshCompatEnabled：为真时顶栏显示 dsh 入口。 */
  enabled: boolean;
  /** dshPort：独立端口（默认 3211）。 */
  port: number;
}

/** 默认端口（与服务端 DEFAULT_DSH_PORT 一致；设置缺失时用它拼链接）。 */
export const DEFAULT_DSH_PORT = 3211;

function field(view: SettingsView, key: string): unknown {
  return view.groups.flatMap((group) => group.fields).find((entry) => entry.key === key)?.value;
}

/**
 * 从服务设置视图读取 dsh 兼容模式开关与端口。
 * 返回 undefined 表示设置尚未加载或服务端无该字段——调用方据此不改动本地状态，
 * 避免 settings 到达前把入口闪成默认值。
 */
export function readDshMode(view: SettingsView | undefined): DshModeSettings | undefined {
  if (!view) return undefined;
  const enabled = field(view, "dshCompatEnabled");
  if (enabled === undefined) return undefined;
  const rawPort = field(view, "dshPort");
  const port = typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : DEFAULT_DSH_PORT;
  return { enabled: enabled === true, port };
}

/**
 * dsh 端口入口 URL：同 hostname、换端口。
 * 当前页面若带 `?token=`（CLI/局域网首次访问）就一并转发，dsh 端口收到后同样换 HttpOnly cookie；
 * 否则依赖浏览器已持有的同名 cookie（两个端口同 host 共享）。
 */
export function dshEntryUrl(mode: DshModeSettings, location: { protocol: string; hostname: string; search: string }): string {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const query = token === null || token === "" ? "" : `?token=${encodeURIComponent(token)}`;
  return `${location.protocol}//${location.hostname}:${mode.port}/${query}`;
}
