import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  CJK_PRESETS,
  FAMILY,
  LATIN_PRESETS,
  MONO_PRESETS,
  useAppearance,
  type FontPreset,
  type UiScale,
} from "../../lib/appearance-prefs";
import { detectFonts, isPresetAvailable, type DetectedFonts } from "../../lib/font-catalog";
import { fontAvailable } from "../../lib/font-detect";
import { useMotionPreference, type MotionPreference } from "../../lib/motion-pref";
import { useI18n } from "../../i18n";
import { MotionPreview } from "./MotionPreview";

const SCALES: UiScale[] = [90, 100, 110, 125];

const MOTION_OPTIONS: Array<{ value: MotionPreference; zh: string; en: string }> = [
  { value: "system", zh: "跟随系统", en: "System" },
  { value: "standard", zh: "标准", en: "Standard" },
  { value: "reduced", zh: "精简", en: "Reduced" },
];

interface FontOption {
  value: string;
  label: string;
}

const EMPTY_DETECTED: DetectedFonts = { latin: [], cjk: [], mono: [] };

function buildOptions(
  presets: FontPreset[],
  candidates: string[],
  userFonts: string[],
  t: (zh: string, en: string) => string,
): FontOption[] {
  const options: FontOption[] = [];
  const seen = new Set<string>();
  for (const preset of presets) {
    // 内嵌字体（source）不依赖本机安装，始终显示；system 始终显示
    const available = preset.id === "source" || isPresetAvailable(preset.stack);
    if (!available) continue;
    options.push({ value: preset.id, label: t(preset.zh, preset.en) });
    if (preset.stack) seen.add(preset.stack.split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase());
  }
  for (const family of candidates) {
    if (seen.has(family.toLowerCase())) continue;
    seen.add(family.toLowerCase());
    options.push({ value: `${FAMILY}${family}`, label: family });
  }
  for (const family of userFonts) {
    if (seen.has(family.toLowerCase())) continue;
    if (!fontAvailable(family)) continue;
    seen.add(family.toLowerCase());
    options.push({ value: `${FAMILY}${family}`, label: family });
  }
  return options;
}

function FontSelect({ options, value, onChange, label }: {
  options: FontOption[];
  value: string;
  onChange(value: string): void;
  label: string;
}): ReactElement {
  const known = options.some((option) => option.value === value);
  return (
    <select className="input typography-select" aria-label={label} value={known ? value : "system"} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function TypographySection(): ReactElement {
  const { t } = useI18n();
  const appearance = useAppearance();
  const { preference: motion, setPreference: setMotion } = useMotionPreference();
  const [detected, setDetected] = useState<DetectedFonts>(EMPTY_DETECTED);
  const [scanning, setScanning] = useState(true);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();

  const scan = useCallback((): void => {
    setScanning(true);
    // 让出一帧再扫描（150+ 字体 canvas 测量），避免打开设置时卡顿
    window.setTimeout(() => {
      setDetected(detectFonts());
      setScanning(false);
    }, 0);
  }, []);

  useEffect(() => {
    scan();
  }, [scan]);

  const latinOptions = useMemo(() => buildOptions(LATIN_PRESETS, detected.latin, appearance.userFonts, t), [detected.latin, appearance.userFonts, t]);
  const cjkOptions = useMemo(() => buildOptions(CJK_PRESETS, detected.cjk, appearance.userFonts, t), [detected.cjk, appearance.userFonts, t]);
  const monoOptions = useMemo(() => buildOptions(MONO_PRESETS, detected.mono, appearance.userFonts, t), [detected.mono, appearance.userFonts, t]);

  const count = detected.latin.length + detected.cjk.length + detected.mono.length;

  const addFont = (): void => {
    const family = draft.trim();
    if (!family) return;
    if (appearance.userFonts.includes(family)) {
      setError(t("该字体已在列表中", "This font is already in the list"));
      return;
    }
    if (!fontAvailable(family)) {
      setError(t("本机未检测到该字体", "Font not found on this device"));
      return;
    }
    appearance.addUserFont(family);
    setDraft("");
    setError(undefined);
  };

  return (
    <>
      <h3>{t("界面字体", "Interface font")}</h3>
      <div className="typography-grid">
        <label className="typography-field">
          <span>{t("西文", "Latin")}</span>
          <FontSelect options={latinOptions} value={appearance.latin} onChange={appearance.setLatin} label={t("界面西文字体", "Interface Latin font")} />
        </label>
        <label className="typography-field">
          <span>{t("中文 / CJK", "Chinese / CJK")}</span>
          <FontSelect options={cjkOptions} value={appearance.cjk} onChange={appearance.setCjk} label={t("界面 CJK 字体", "Interface CJK font")} />
        </label>
      </div>
      <p className="settings-note">
        {t("西文在前、CJK 兜底：数字与英文优先命中西文字体。「系统默认」使用操作系统自带字体（不受免费商用筛选影响）；其余列表只显示可免费商用且本机已安装的字体。", "Latin comes first with CJK fallback. “System default” uses the operating system fonts and is exempt from the free-for-commercial-use filter; every other entry is free for commercial use and installed locally.")}
      </p>

      <h3>{t("代码字体", "Code font")}</h3>
      <FontSelect options={monoOptions} value={appearance.mono} onChange={appearance.setMono} label={t("代码区字体", "Code font")} />
      <label className="settings-check">
        <input type="checkbox" checked={appearance.ligatures} onChange={(event) => appearance.setLigatures(event.target.checked)} />
        {t("启用代码连字（=>、!== 等）", "Enable code ligatures (=>, !==)")}
      </label>
      <p className="settings-note">
        {t("「思源等宽（内嵌）」随应用分发，只含拉丁字形；中文代码仍回退到系统等宽字体。", "Noto Sans Mono (bundled) ships with the app and covers Latin only; Chinese code falls back to the system monospace font.")}
      </p>

      <div className="font-scan">
        <span className="font-scan-count">
          {scanning ? t("正在检测本机字体…", "Detecting local fonts…") : t(`已检测到 ${count} 个可用字体`, `${count} available fonts detected`)}
        </span>
        <button type="button" className="btn small" disabled={scanning} onClick={scan}>
          {t("重新扫描", "Rescan")}
        </button>
      </div>

      <div className="font-add">
        <input
          className="input"
          value={draft}
          placeholder={t("输入字体族名，如 HarmonyOS Sans SC", "Font family name, e.g. HarmonyOS Sans SC")}
          aria-label={t("添加系统字体", "Add a system font")}
          onChange={(event) => { setDraft(event.target.value); setError(undefined); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFont(); } }}
        />
        <button type="button" className="btn small" onClick={addFont}>{t("添加并检测", "Add & detect")}</button>
      </div>
      <p className="settings-note">
        {t("手动添加的字体仅做本机可用性探测，商用授权需自行确认。", "Manually added fonts are only probed for availability; commercial licensing is your responsibility.")}
      </p>
      {error && <p className="font-add-error">{error}</p>}
      {appearance.userFonts.length > 0 && (
        <div className="font-chips">
          {appearance.userFonts.map((family) => (
            <span key={family} className="font-chip">
              <span className={fontAvailable(family) ? "" : "missing"}>{family}</span>
              <button type="button" aria-label={t(`移除 ${family}`, `Remove ${family}`)} title={t("移除", "Remove")} onClick={() => appearance.removeUserFont(family)}>×</button>
            </span>
          ))}
        </div>
      )}

      <h3>{t("界面缩放", "Interface scale")}</h3>
      <div className="typography-scale" role="radiogroup" aria-label={t("界面缩放", "Interface scale")}>
        {SCALES.map((scale) => (
          <label key={scale} className={`scale-option${appearance.scale === scale ? " active" : ""}`}>
            <input type="radio" name="ui-scale" checked={appearance.scale === scale} onChange={() => appearance.setScale(scale)} />
            {scale}%
          </label>
        ))}
      </div>
      <p className="settings-note">{t("只缩放文字与行高，不缩放图标与固定控件高度。", "Scales text and line height only, not icons or fixed control heights.")}</p>

      <h3>{t("动画模式", "Motion")}</h3>
      <div className="typography-scale" role="radiogroup" aria-label={t("动画模式", "Motion")}>
        {MOTION_OPTIONS.map((option) => (
          <label key={option.value} className={`scale-option${motion === option.value ? " active" : ""}`}>
            <input type="radio" name="motion-pref" checked={motion === option.value} onChange={() => setMotion(option.value)} />
            {t(option.zh, option.en)}
          </label>
        ))}
      </div>
      <MotionPreview />
    </>
  );
}
