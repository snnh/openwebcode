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

/** 自定义键位覆盖：command → combo（如 "mod+b"）；null = 解除绑定（该命令不再分发）。 */
export type KeybindingOverrides = Record<string, string | null>;

const KEYBINDINGS_KEY = "owc-keybindings";

export function loadKeybindingOverrides(): KeybindingOverrides {
  try {
    const parsed = JSON.parse(read(KEYBINDINGS_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: KeybindingOverrides = {};
    for (const [command, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) out[command] = value;
      else if (value === null) out[command] = null;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveKeybindingOverrides(value: KeybindingOverrides): void {
  write(KEYBINDINGS_KEY, JSON.stringify(value));
}
