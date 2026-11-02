import { createStore, useStore } from "../app/store";

/**
 * 外观偏好：界面西文 / 界面 CJK / 代码字体、连字、界面缩放。
 * 全部为本地偏好（localStorage），即时写入 :root 变量，不改服务端设置。
 */

export interface FontPreset {
  id: string;
  zh: string;
  en: string;
  /** 预设栈；system 表示不覆写 token 默认值 */
  stack: string | null;
}

export const LATIN_PRESETS: FontPreset[] = [
  { id: "system", zh: "系统默认", en: "System default", stack: null },
  { id: "segoe", zh: "Segoe UI", en: "Segoe UI", stack: '"Segoe UI Variable Text", "Segoe UI", Arial, sans-serif' },
  { id: "sf", zh: "SF Pro Text", en: "SF Pro Text", stack: '"SF Pro Text", -apple-system, "Helvetica Neue", Arial, sans-serif' },
  { id: "inter", zh: "Inter", en: "Inter", stack: 'Inter, "Segoe UI", Arial, sans-serif' },
];

export const CJK_PRESETS: FontPreset[] = [
  { id: "system", zh: "系统默认", en: "System default", stack: null },
  { id: "pingfang", zh: "苹方", en: "PingFang SC", stack: '"PingFang SC", "Noto Sans SC", sans-serif' },
  { id: "yahei", zh: "微软雅黑", en: "Microsoft YaHei", stack: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif' },
  { id: "noto", zh: "思源黑体", en: "Noto Sans SC", stack: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif' },
];

export const MONO_PRESETS: FontPreset[] = [
  { id: "system", zh: "系统默认", en: "System default", stack: null },
  { id: "jetbrains", zh: "JetBrains Mono", en: "JetBrains Mono", stack: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
  { id: "cascadia", zh: "Cascadia Code", en: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { id: "fira", zh: "Fira Code", en: "Fira Code", stack: '"Fira Code", "Cascadia Code", Consolas, monospace' },
];

export type FontChoice = string; // 预设 id 或 custom:<font-family>
export type UiScale = 90 | 100 | 110 | 125;

const KEY_LATIN = "owc-font-ui-latin";
const KEY_CJK = "owc-font-ui-cjk";
const KEY_MONO = "owc-font-mono";
const KEY_LIGATURES = "owc-font-ligatures";
const KEY_SCALE = "owc-ui-scale";

const CUSTOM = "custom:";

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
    // 持久化失败不影响本次应用
  }
}

function readChoice(key: string, presets: FontPreset[]): FontChoice {
  const stored = read(key);
  if (!stored) return "system";
  if (presets.some((preset) => preset.id === stored)) return stored;
  if (stored.startsWith(CUSTOM) && stored.length > CUSTOM.length) return stored;
  return "system";
}

export function presetStack(choice: FontChoice, presets: FontPreset[]): string | null {
  if (choice.startsWith(CUSTOM)) return choice.slice(CUSTOM.length).trim() || null;
  return presets.find((preset) => preset.id === choice)?.stack ?? null;
}

function readScale(): UiScale {
  const stored = Number(read(KEY_SCALE));
  return stored === 90 || stored === 110 || stored === 125 ? stored : 100;
}

interface AppearanceState {
  latin: FontChoice;
  cjk: FontChoice;
  mono: FontChoice;
  ligatures: boolean;
  scale: UiScale;
}

const appearanceStore = createStore<AppearanceState>({
  latin: readChoice(KEY_LATIN, LATIN_PRESETS),
  cjk: readChoice(KEY_CJK, CJK_PRESETS),
  mono: readChoice(KEY_MONO, MONO_PRESETS),
  ligatures: read(KEY_LIGATURES) === "1",
  scale: readScale(),
});

/** 把偏好写入 :root；system 预设移除内联值以回落到 tokens 默认栈 */
export function applyAppearance(state: AppearanceState = appearanceStore.get()): void {
  const root = document.documentElement;
  const apply = (name: string, choice: FontChoice, presets: FontPreset[]): void => {
    const stack = presetStack(choice, presets);
    if (stack) root.style.setProperty(name, stack);
    else root.style.removeProperty(name);
  };
  apply("--font-ui-latin", state.latin, LATIN_PRESETS);
  apply("--font-ui-cjk", state.cjk, CJK_PRESETS);
  apply("--font-mono", state.mono, MONO_PRESETS);
  root.dataset.ligatures = state.ligatures ? "on" : "off";
  root.style.setProperty("--ui-scale", String(state.scale / 100));
}

function commit(key: string, value: string, partial: Partial<AppearanceState>): void {
  write(key, value);
  appearanceStore.set(partial);
  applyAppearance();
}

export function useAppearance(): AppearanceState & {
  setLatin(value: FontChoice): void;
  setCjk(value: FontChoice): void;
  setMono(value: FontChoice): void;
  setLigatures(value: boolean): void;
  setScale(value: UiScale): void;
} {
  const state = useStore(appearanceStore, (current) => current);
  return {
    ...state,
    setLatin: (value) => commit(KEY_LATIN, value, { latin: value }),
    setCjk: (value) => commit(KEY_CJK, value, { cjk: value }),
    setMono: (value) => commit(KEY_MONO, value, { mono: value }),
    setLigatures: (value) => commit(KEY_LIGATURES, value ? "1" : "0", { ligatures: value }),
    setScale: (value) => commit(KEY_SCALE, String(value), { scale: value }),
  };
}
