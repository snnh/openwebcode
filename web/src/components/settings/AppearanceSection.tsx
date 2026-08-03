import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ThemePreference, AccentPreference } from "../../theme";
import { isValidHexColor } from "../../lib/accent-color";
import { useI18n, type Language } from "../../i18n";

const THEME_OPTIONS: Array<{ value: ThemePreference; zh: string; en: string }> = [
  { value: "light", zh: "浅色", en: "Light" },
  { value: "dark", zh: "深色", en: "Dark" },
  { value: "system", zh: "跟随系统", en: "System" },
];

const ACCENT_OPTIONS: Array<{ value: AccentPreference; zh: string; en: string; swatch: string }> = [
  { value: "graphite", zh: "石墨", en: "Graphite", swatch: "#3d444c" },
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
  const customHex = accent.startsWith("custom:") ? accent.slice("custom:".length) : undefined;
  const colorInputRef = useRef<HTMLInputElement>(null);
  // hex 文本框草稿：合法（#rrggbb）即应用，非法保留草稿不打扰
  const [hexDraft, setHexDraft] = useState(customHex ?? "");
  useEffect(() => setHexDraft(customHex ?? ""), [customHex]);
  const applyHexDraft = (value: string): void => {
    setHexDraft(value);
    const normalized = value.startsWith("#") ? value : `#${value}`;
    if (isValidHexColor(normalized)) setAccent(`custom:${normalized.toLowerCase()}`);
  };
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
        {/* 自定义任意 RGB：点色卡打开原生取色器；选中后展示 hex 文本框 */}
        <label className="accent-option accent-option-custom">
          <input
            type="radio"
            name="accent"
            checked={customHex !== undefined}
            onChange={() => colorInputRef.current?.click()}
          />
          <span
            className={`accent-swatch accent-swatch-custom${customHex ? "" : " unset"}`}
            style={customHex ? { background: customHex } : undefined}
            onClick={(event) => {
              event.preventDefault();
              colorInputRef.current?.click();
            }}
          />
          {t("自定义", "Custom")}
          <input
            ref={colorInputRef}
            type="color"
            className="accent-color-input"
            aria-label={t("自定义强调色", "Custom accent color")}
            value={customHex ?? "#3d444c"}
            onChange={(event) => setAccent(`custom:${event.target.value}`)}
          />
        </label>
        {customHex !== undefined && (
          <input
            type="text"
            className="accent-hex-input mono"
            aria-label={t("强调色 hex 值（#rrggbb）", "Accent hex value (#rrggbb)")}
            value={hexDraft}
            onChange={(event) => applyHexDraft(event.target.value)}
            spellCheck={false}
            maxLength={7}
            placeholder="#rrggbb"
          />
        )}
      </div>
      <p className="settings-note">{t("强调色影响按钮、链接、高亮等元素；浅色与深色模式各自适配。自定义色支持任意 RGB，悬停/底色/文字色自动派生。", "The accent color applies to buttons, links, highlights, and related elements in both light and dark themes. Custom colors accept any RGB value; hover, tint, and text colors are derived automatically.")}</p>
    </>
  );
}
