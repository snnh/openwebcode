import { useState, type ReactElement } from "react";
import {
  CJK_PRESETS,
  LATIN_PRESETS,
  MONO_PRESETS,
  useAppearance,
  type FontPreset,
  type UiScale,
} from "../../lib/appearance-prefs";
import { fontAvailable, firstFamily } from "../../lib/font-detect";
import { useMotionPreference, type MotionPreference } from "../../lib/motion-pref";
import { useI18n } from "../../i18n";
import { MotionPreview } from "./MotionPreview";

const SCALES: UiScale[] = [90, 100, 110, 125];

const MOTION_OPTIONS: Array<{ value: MotionPreference; zh: string; en: string }> = [
  { value: "system", zh: "跟随系统", en: "System" },
  { value: "standard", zh: "标准", en: "Standard" },
  { value: "reduced", zh: "精简", en: "Reduced" },
];

function presetLabel(preset: FontPreset, t: (zh: string, en: string) => string): string {
  if (!preset.stack) return t(preset.zh, preset.en);
  const available = fontAvailable(firstFamily(preset.stack));
  return `${t(preset.zh, preset.en)}${available ? "" : t("（未安装）", " (not installed)")}`;
}

function FontSelect({ presets, value, onChange, label }: {
  presets: FontPreset[];
  value: string;
  onChange(value: string): void;
  label: string;
}): ReactElement {
  const { t } = useI18n();
  return (
    <select className="input typography-select" aria-label={label} value={value.startsWith("custom:") ? "custom" : value} onChange={(event) => {
      const next = event.target.value;
      if (next === "custom") onChange(value.startsWith("custom:") ? value : "custom:");
      else onChange(next);
    }}>
      {presets.map((preset) => (
        <option key={preset.id} value={preset.id}>{presetLabel(preset, t)}</option>
      ))}
      <option value="custom">{t("自定义栈…", "Custom stack…")}</option>
    </select>
  );
}

export function TypographySection(): ReactElement {
  const { t } = useI18n();
  const appearance = useAppearance();
  const { preference: motion, setPreference: setMotion } = useMotionPreference();
  const [advanced, setAdvanced] = useState(false);

  const customValue = (value: string): string => (value.startsWith("custom:") ? value.slice("custom:".length) : "");

  return (
    <>
      <h3>{t("界面字体", "Interface font")}</h3>
      <div className="typography-grid">
        <label className="typography-field">
          <span>{t("西文", "Latin")}</span>
          <FontSelect presets={LATIN_PRESETS} value={appearance.latin} onChange={appearance.setLatin} label={t("界面西文字体", "Interface Latin font")} />
        </label>
        <label className="typography-field">
          <span>{t("中文 / CJK", "Chinese / CJK")}</span>
          <FontSelect presets={CJK_PRESETS} value={appearance.cjk} onChange={appearance.setCjk} label={t("界面 CJK 字体", "Interface CJK font")} />
        </label>
      </div>
      <p className="settings-note">
        {t("西文在前、CJK 兜底：数字与英文优先命中西文字体。未安装的预设会回退到系统栈。", "Latin comes first with CJK fallback: digits and English use the Latin font. Missing presets fall back to the system stack.")}
      </p>

      <h3>{t("代码字体", "Code font")}</h3>
      <FontSelect presets={MONO_PRESETS} value={appearance.mono} onChange={appearance.setMono} label={t("代码区字体", "Code font")} />
      <label className="settings-check">
        <input type="checkbox" checked={appearance.ligatures} onChange={(event) => appearance.setLigatures(event.target.checked)} />
        {t("启用代码连字（=>、!== 等）", "Enable code ligatures (=>, !==)")}
      </label>

      <details className="typography-advanced" open={advanced} onToggle={(event) => setAdvanced((event.target as HTMLDetailsElement).open)}>
        <summary>{t("高级：自定义字体栈", "Advanced: custom font stacks")}</summary>
        {[
          { key: "latin", label: t("西文", "Latin"), value: appearance.latin, set: appearance.setLatin },
          { key: "cjk", label: t("中文 / CJK", "Chinese / CJK"), value: appearance.cjk, set: appearance.setCjk },
          { key: "mono", label: t("代码", "Code"), value: appearance.mono, set: appearance.setMono },
        ].map((row) => (
          <label key={row.key} className="typography-field">
            <span>{row.label}</span>
            <input
              className="input mono"
              placeholder={t("留空恢复系统默认", "Leave empty for system default")}
              defaultValue={customValue(row.value)}
              onBlur={(event) => {
                const next = event.target.value.trim();
                row.set(next ? `custom:${next}` : "system");
              }}
            />
          </label>
        ))}
        <p className="settings-note">{t("仅在预设不够用时使用；输入 font-family 列表，失焦即生效。", "Only when presets are not enough; enter a font-family list, applied on blur.")}</p>
      </details>

      <h3>{t("界面缩放", "Interface scale")}</h3>
      <div className="typography-scale" role="radiogroup" aria-label={t("界面缩放", "Interface scale")}>
        {SCALES.map((scale) => (
          <label key={scale} className={`scale-option${appearance.scale === scale ? " active" : ""}`}>
            <input
              type="radio"
              name="ui-scale"
              checked={appearance.scale === scale}
              onChange={() => appearance.setScale(scale)}
            />
            {scale}%
          </label>
        ))}
      </div>
      <p className="settings-note">{t("只缩放文字与行高，不缩放图标与固定控件高度。", "Scales text and line height only, not icons or fixed control heights.")}</p>

      <h3>{t("动画模式", "Motion")}</h3>
      <div className="typography-scale" role="radiogroup" aria-label={t("动画模式", "Motion")}>
        {MOTION_OPTIONS.map((option) => (
          <label key={option.value} className={`scale-option${motion === option.value ? " active" : ""}`}>
            <input
              type="radio"
              name="motion-pref"
              checked={motion === option.value}
              onChange={() => setMotion(option.value)}
            />
            {t(option.zh, option.en)}
          </label>
        ))}
      </div>
      <MotionPreview />
    </>
  );
}
