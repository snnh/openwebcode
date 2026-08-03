import { useCallback, useEffect, useState } from "react";
import { deriveAccentVars } from "./lib/accent-color";

export type Theme = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";
/** 预设强调色 + 自定义任意 RGB（custom:#rrggbb）。graphite 为默认（对应 :root 内置灰阶变量） */
export type AccentPreset = "graphite" | "teal" | "violet" | "blue" | "orange" | "rose" | "green";
export type AccentPreference = AccentPreset | `custom:${string}`;

const STORAGE_KEY = "owc-theme";
const STORAGE_KEY_ACCENT = "owc-accent";
const DEFAULT_ACCENT: AccentPreference = "graphite";
const CUSTOM_ACCENT_PATTERN = /^custom:#[0-9a-fA-F]{6}$/;

const ACCENT_VAR_KEYS = ["--accent", "--accent-hover", "--on-accent", "--accent-soft"] as const;

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage 不可用时跟随系统
  }
  return "system";
}

const VALID_PRESETS: AccentPreset[] = ["graphite", "teal", "violet", "blue", "orange", "rose", "green"];

/** 解析持久化的强调色：预设名或 custom:#rrggbb；非法值回落默认 */
export function parseAccent(stored: string | null): AccentPreference {
  if (stored && (VALID_PRESETS as string[]).includes(stored)) return stored as AccentPreset;
  if (stored && CUSTOM_ACCENT_PATTERN.test(stored)) return stored as AccentPreference;
  return DEFAULT_ACCENT;
}

function readAccent(): AccentPreference {
  try {
    return parseAccent(window.localStorage.getItem(STORAGE_KEY_ACCENT));
  } catch {
    // localStorage 不可用
    return DEFAULT_ACCENT;
  }
}

const systemPrefersDark = (): boolean => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setPreference(value: ThemePreference): void;
  toggleTheme(): void;
  accent: AccentPreference;
  setAccent(value: AccentPreference): void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const [accent, setAccentState] = useState<AccentPreference>(readAccent);

  // preference 为 system 时跟随系统切换
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media?.addEventListener) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const theme: Theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 预设走 data-accent + CSS 规则；自定义任意 RGB 由内联变量注入（按亮/暗主题重新派生）
  useEffect(() => {
    const root = document.documentElement;
    if (accent.startsWith("custom:")) {
      const vars = deriveAccentVars(accent.slice("custom:".length), theme);
      root.dataset.accent = "custom";
      if (vars) {
        root.style.setProperty("--accent", vars.accent);
        root.style.setProperty("--accent-hover", vars.accentHover);
        root.style.setProperty("--on-accent", vars.onAccent);
        root.style.setProperty("--accent-soft", vars.accentSoft);
      }
      return;
    }
    root.dataset.accent = accent;
    for (const key of ACCENT_VAR_KEYS) root.style.removeProperty(key);
  }, [accent, theme]);

  const setPreference = useCallback((value: ThemePreference): void => {
    setPreferenceState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // 持久化失败不影响本次切换
    }
  }, []);

  const setAccent = useCallback((value: AccentPreference): void => {
    setAccentState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY_ACCENT, value);
    } catch {
      // 持久化失败不影响本次切换
    }
  }, []);

  const toggleTheme = useCallback(() => setPreference(theme === "dark" ? "light" : "dark"), [theme, setPreference]);

  return { theme, preference, setPreference, toggleTheme, accent, setAccent };
}
