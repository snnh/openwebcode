import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";
export type AccentPreference = "teal" | "violet" | "blue" | "orange" | "rose" | "green";

const STORAGE_KEY = "owc-theme";
const STORAGE_KEY_ACCENT = "owc-accent";
const DEFAULT_ACCENT: AccentPreference = "teal";

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage 不可用时跟随系统
  }
  return "system";
}

const VALID_ACCENTS: AccentPreference[] = ["teal", "violet", "blue", "orange", "rose", "green"];
function readAccent(): AccentPreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY_ACCENT) as AccentPreference | null;
    if (stored && VALID_ACCENTS.includes(stored)) return stored;
  } catch {
    // localStorage 不可用
  }
  return DEFAULT_ACCENT;
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

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

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
