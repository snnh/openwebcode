import type { PermissionMode } from "./contracts";

export type SendKey = "enter" | "ctrl-enter";

export interface SessionDefaults {
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

const SEND_KEY = "owc-send-key";
const DEFAULTS_KEY = "owc-session-defaults";

function read(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 持久化失败不影响使用
  }
}

export function loadSendKey(): SendKey {
  return read(SEND_KEY) === "ctrl-enter" ? "ctrl-enter" : "enter";
}

export function saveSendKey(value: SendKey): void {
  write(SEND_KEY, value);
}

export function loadSessionDefaults(): SessionDefaults {
  try {
    const parsed = JSON.parse(read(DEFAULTS_KEY) ?? "{}") as SessionDefaults;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSessionDefaults(value: SessionDefaults): void {
  write(DEFAULTS_KEY, JSON.stringify(value));
}
