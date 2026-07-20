import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";

export type Language = "zh-CN" | "en";

const LANGUAGE_KEY = "owc-language";

interface I18nValue {
  language: Language;
  locale: "zh-CN" | "en-US";
  setLanguage(language: Language): void;
  t(chinese: string, english: string): string;
}

const defaultValue: I18nValue = {
  language: "zh-CN",
  locale: "zh-CN",
  setLanguage: () => undefined,
  t: (chinese) => chinese,
};

const I18nContext = createContext<I18nValue>(defaultValue);

function initialLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_KEY);
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }): ReactElement {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  const setLanguage = useCallback((next: Language): void => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(LANGUAGE_KEY, next);
    } catch {
      // The in-memory selection still works when persistence is unavailable.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === "zh-CN" ? "OpenWebCode · 执行控制台" : "OpenWebCode · Coding Console";
  }, [language]);

  const value = useMemo<I18nValue>(() => ({
    language,
    locale: language === "zh-CN" ? "zh-CN" : "en-US",
    setLanguage,
    t: (chinese, english) => language === "zh-CN" ? chinese : english,
  }), [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
