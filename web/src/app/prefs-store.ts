import { createStore, useStore } from "./store";
import {
  loadSendKey, loadSessionDefaults, saveSendKey, saveSessionDefaults,
  type SendKey, type SessionDefaults,
} from "../lib/prefs";
import { loadDesktopNotifyEnabled, saveDesktopNotifyEnabled } from "../lib/desktop-notify";

/**
 * 本地偏好（localStorage 持久化）的响应式 store：
 * Composer（sendKey）与 Phase 3 设置对话框共用；set 时同步落盘。
 * 每个偏好一个独立 store，读取方经 useStore 订阅，非 React 侧用 get。
 */

const sendKeyStore = createStore<{ value: SendKey }>({ value: loadSendKey() });
const sessionDefaultsStore = createStore<{ value: SessionDefaults }>({ value: loadSessionDefaults() });
const desktopNotifyStore = createStore<{ value: boolean }>({ value: loadDesktopNotifyEnabled() });

export function useSendKey(): SendKey {
  return useStore(sendKeyStore, (state) => state.value);
}

export function setSendKey(value: SendKey): void {
  saveSendKey(value);
  sendKeyStore.set({ value });
}

export function useSessionDefaults(): SessionDefaults {
  return useStore(sessionDefaultsStore, (state) => state.value);
}

export function setSessionDefaults(value: SessionDefaults): void {
  saveSessionDefaults(value);
  sessionDefaultsStore.set({ value });
}

export function useDesktopNotify(): boolean {
  return useStore(desktopNotifyStore, (state) => state.value);
}

export function getDesktopNotify(): boolean {
  return desktopNotifyStore.get().value;
}

export function setDesktopNotify(value: boolean): void {
  saveDesktopNotifyEnabled(value);
  desktopNotifyStore.set({ value });
}
