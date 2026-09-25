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

/** dsh 运行态（主端口 `GET /api/dsh/status`）。 */
export interface DshRuntimeStatus {
  enabled: boolean;
  listening: boolean;
  address?: string;
  reason?: string;
}

/** 服务端未就绪原因 → 用户可读的双语提示（未知原因原样透出，便于诊断）。 */
export function dshNotReadyNotice(reason: string | undefined, port: number): { zh: string; en: string } {
  const suffix = `（端口 ${port}）`;
  switch (reason) {
    case "vendor missing":
      return {
        zh: `dsh 兼容模式未就绪${suffix}：缺少 dsh UI 产物，请先运行 node scripts/fetch-dsh-web.mjs（或用「dshUiPath」指向自选 UI 目录）`,
        en: `dsh compatibility mode is not ready (port ${port}): the dsh UI assets are missing. Run node scripts/fetch-dsh-web.mjs first (or point "dshUiPath" at a custom UI directory).`,
      };
    case "non-loopback without access token":
      return {
        zh: `dsh 兼容模式未就绪${suffix}：非回环监听需要访问令牌（设置 OWC_ACCESS_TOKEN 或使用启动器生成），未取得令牌时不启动该端口`,
        en: `dsh compatibility mode is not ready (port ${port}): a non-loopback listener requires an access token (set OWC_ACCESS_TOKEN or use the launcher-generated token); the port stays closed without one.`,
      };
    default:
      return {
        zh: `dsh 兼容模式未就绪${suffix}${reason === undefined ? "" : `：${reason}`}；请检查端口占用与设置后重试`,
        en: `dsh compatibility mode is not ready (port ${port})${reason === undefined ? "" : `: ${reason}`}; check the port and settings, then retry.`,
      };
  }
}
