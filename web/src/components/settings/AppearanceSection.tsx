import type { ReactElement } from "react";
import type { ThemePreference, AccentPreference } from "../../theme";
import { useI18n, type Language } from "../../i18n";

const THEME_OPTIONS: Array<{ value: ThemePreference; zh: string; en: string }> = [
  { value: "light", zh: "浅色", en: "Light" },
  { value: "dark", zh: "深色", en: "Dark" },
  { value: "system", zh: "跟随系统", en: "System" },
];

const ACCENT_OPTIONS: Array<{ value: AccentPreference; zh: string; en: string; swatch: string }> = [
  { value: "teal", zh: "青", en: "Teal", swatch: "#0b7285" },
  { value: "violet", zh: "紫", en: "Violet", swatch: "#6c5ce7" },
  { value: "blue", zh: "蓝", en: "Blue", swatch: "#2563eb" },
  { value: "orange", zh: "橙", en: "Orange", swatch: "#e8590c" },
  { value: "rose", zh: "玫红", en: "Rose", swatch: "#e1235c" },
  { value: "green", zh: "绿", en: "Green", swatch: "#2f9e44" },
];

export function AppearanceSection({ preference, setPreference, accent, setAccent }: {
  preference: ThemePreference;
  setPreference(value: ThemePreference): void;
  accent: AccentPreference;
  setAccent(value: AccentPreference): void;
}): ReactElement {
  const { language, setLanguage, t } = useI18n();
  return (
    <>
      <h3>{t("语言", "Language")}</h3>
      <select value={language} aria-label={t("界面语言", "Interface language")} onChange={(event) => setLanguage(event.target.value as Language)}>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
      <p className="settings-note">{t("语言设置立即生效并保存在本机。", "The language changes immediately and is saved on this device.")}</p>
      <h3>{t("主题", "Theme")}</h3>
      <div className="settings-row" role="radiogroup" aria-label={t("主题", "Theme")}>
        {THEME_OPTIONS.map((option) => (
          <label key={option.value} className="theme-option">
            <input
              type="radio"
              name="theme"
              checked={preference === option.value}
              onChange={() => setPreference(option.value)}
            />
            {t(option.zh, option.en)}
          </label>
        ))}
      </div>
      <h3>{t("强调色", "Accent color")}</h3>
      <div className="settings-row accent-row" role="radiogroup" aria-label={t("强调色", "Accent color")}>
        {ACCENT_OPTIONS.map((option) => (
          <label key={option.value} className="accent-option">
            <input
              type="radio"
              name="accent"
              checked={accent === option.value}
              onChange={() => setAccent(option.value)}
            />
            <span className="accent-swatch" style={{ background: option.swatch }} />
            {t(option.zh, option.en)}
          </label>
        ))}
      </div>
      <p className="settings-note">{t("强调色影响按钮、链接、高亮等元素；浅色与深色模式各自适配。", "The accent color applies to buttons, links, highlights, and related elements in both light and dark themes.")}</p>
    </>
  );
}
