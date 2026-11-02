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
  { id: "inter", zh: "Inter", en: "Inter", stack: 'Inter, "Segoe UI", Arial, sans-serif' },
];

export const CJK_PRESETS: FontPreset[] = [
  { id: "system", zh: "系统默认", en: "System default", stack: null },
  { id: "noto", zh: "思源黑体", en: "Source Han Sans", stack: '"Noto Sans SC", "Source Han Sans SC", sans-serif' },
];

export const MONO_PRESETS: FontPreset[] = [
  { id: "system", zh: "系统默认", en: "System default", stack: null },
  { id: "source", zh: "思源等宽（内嵌）", en: "Noto Sans Mono (bundled)", stack: '"OWC Noto Sans Mono", "Cascadia Code", Consolas, monospace' },
  { id: "jetbrains", zh: "JetBrains Mono", en: "JetBrains Mono", stack: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
  { id: "cascadia", zh: "Cascadia Code", en: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { id: "fira", zh: "Fira Code", en: "Fira Code", stack: '"Fira Code", "Cascadia Code", Consolas, monospace' },
];

export type FontChoice = string; // 预设 id、family:<字体族名> 或 custom:<font-family>
export type UiScale = 90 | 100 | 110 | 125;

const KEY_LATIN = "owc-font-ui-latin";
const KEY_CJK = "owc-font-ui-cjk";
const KEY_MONO = "owc-font-mono";
const KEY_LIGATURES = "owc-font-ligatures";
const KEY_SCALE = "owc-ui-scale";
const KEY_USER_FONTS = "owc-font-user";

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

function readChoice(key: string, presets: FontPreset[], fallback = "system"): FontChoice {
  const stored = read(key);
  if (!stored) return fallback;
  if (presets.some((preset) => preset.id === stored)) return stored;
  if (stored.startsWith(CUSTOM) && stored.length > CUSTOM.length) return stored;
  if (stored.startsWith(FAMILY) && stored.length > FAMILY.length) return stored;
  return fallback;
}

function readUserFonts(): string[] {
  try {
    const parsed = JSON.parse(read(KEY_USER_FONTS) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0))].slice(0, 50);
  } catch {
    return [];
  }
}

export const FAMILY = "family:";

export function presetStack(choice: FontChoice, presets: FontPreset[]): string | null {
  if (choice.startsWith(CUSTOM)) return choice.slice(CUSTOM.length).trim() || null;
  if (choice.startsWith(FAMILY)) {
    const family = choice.slice(FAMILY.length).trim();
    return family ? `"${family}", sans-serif` : null;
  }
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
  /** 用户添加并通过探测的字体族名（三组下拉共用） */
  userFonts: string[];
}

const appearanceStore = createStore<AppearanceState>({
  latin: readChoice(KEY_LATIN, LATIN_PRESETS),
  cjk: readChoice(KEY_CJK, CJK_PRESETS),
  mono: readChoice(KEY_MONO, MONO_PRESETS, "source"),
  userFonts: readUserFonts(),
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
  addUserFont(family: string): void;
  removeUserFont(family: string): void;
} {
  const state = useStore(appearanceStore, (current) => current);
  return {
    ...state,
    setLatin: (value) => commit(KEY_LATIN, value, { latin: value }),
    setCjk: (value) => commit(KEY_CJK, value, { cjk: value }),
    setMono: (value) => commit(KEY_MONO, value, { mono: value }),
    setLigatures: (value) => commit(KEY_LIGATURES, value ? "1" : "0", { ligatures: value }),
    setScale: (value) => commit(KEY_SCALE, String(value), { scale: value }),
    addUserFont: (family) => {
      const trimmed = family.trim();
      if (!trimmed) return;
      const next = [...new Set([...appearanceStore.get().userFonts, trimmed])].slice(0, 50);
      write(KEY_USER_FONTS, JSON.stringify(next));
      appearanceStore.set({ userFonts: next });
    },
    removeUserFont: (family) => {
      const next = appearanceStore.get().userFonts.filter((item) => item !== family);
      write(KEY_USER_FONTS, JSON.stringify(next));
      appearanceStore.set({ userFonts: next });
    },
  };
}
