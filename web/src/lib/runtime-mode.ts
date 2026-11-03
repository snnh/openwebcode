import type { SettingsView } from "./contracts";

/** Web 端运行模式：与 server runtime-mode.ts 的档位保持一致（仅渲染预算不同）。 */
export type WebRuntimeMode = "performance" | "balanced" | "memory";

export interface WebRuntimeProfile {
  webPageMessages: number;
  webPageSessions: number;
}

const WEB_RUNTIME_PROFILES: Record<WebRuntimeMode, WebRuntimeProfile> = {
  performance: { webPageMessages: 4000, webPageSessions: 20 },
  balanced: { webPageMessages: 2000, webPageSessions: 10 },
  memory: { webPageMessages: 1000, webPageSessions: 5 },
};

let currentMode: WebRuntimeMode = "balanced";

export function setWebRuntimeMode(mode: WebRuntimeMode): void {
  currentMode = mode;
}

export function webRuntimeProfile(): WebRuntimeProfile {
  return WEB_RUNTIME_PROFILES[currentMode];
}

/** 从 /api/settings 视图读取 runtimeMode；缺失/非法回退 balanced。 */
export function readRuntimeMode(view: SettingsView | undefined): WebRuntimeMode {
  const value = view?.groups.flatMap((group) => group.fields).find((field) => field.key === "runtimeMode")?.value;
  return value === "performance" || value === "balanced" || value === "memory" ? value : "balanced";
}
