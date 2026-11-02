import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
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
import { Segmented, SettingsCard, SettingsRow, Switch } from "../controls";

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
  const [notice, setNotice] = useState<{ kind: "ok" | "removed"; text: string }>();
  const [removedFamily, setRemovedFamily] = useState<string>();
  const undoTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (undoTimer.current !== undefined) window.clearTimeout(undoTimer.current); }, []);

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
    setNotice({ kind: "ok", text: t(`已添加 ${family}`, `Added ${family}`) });
  };

  const removeFont = (family: string): void => {
    appearance.removeUserFont(family);
    setRemovedFamily(family);
    setNotice({ kind: "removed", text: t(`已移除 ${family}`, `Removed ${family}`) });
    if (undoTimer.current !== undefined) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => { setNotice(undefined); setRemovedFamily(undefined); }, 6000);
  };

  return (
    <>
      <SettingsCard
        title={t("字体", "Fonts")}
        description={t("西文优先、CJK 兜底。默认只列出免费商用且本机已安装的字体；「系统默认」直接使用操作系统字体，不受筛选影响。", "Latin first with CJK fallback. Only free-for-commercial-use fonts installed locally are listed; “System default” uses the operating system fonts and is exempt from the filter.")}
      >
        <SettingsRow label={t("界面西文", "Interface Latin")}>
          <FontSelect options={latinOptions} value={appearance.latin} onChange={appearance.setLatin} label={t("界面西文字体", "Interface Latin font")} />
        </SettingsRow>
        <SettingsRow label={t("界面中文", "Interface CJK")}>
          <FontSelect options={cjkOptions} value={appearance.cjk} onChange={appearance.setCjk} label={t("界面 CJK 字体", "Interface CJK font")} />
        </SettingsRow>
        <SettingsRow label={t("代码字体", "Code font")}>
          <FontSelect options={monoOptions} value={appearance.mono} onChange={appearance.setMono} label={t("代码区字体", "Code font")} />
        </SettingsRow>
        <SettingsRow inline label={t("代码连字", "Code ligatures")} description={t("把 =>、!== 等组合渲染为连字。", "Render combinations such as => and !== as ligatures.")}>
          <Switch checked={appearance.ligatures} onChange={appearance.setLigatures} label={t("启用代码连字", "Enable code ligatures")} />
        </SettingsRow>
        <div className="font-note">
          {t("「思源等宽（内嵌）」随应用分发，只含拉丁字形；中文代码仍回退到系统等宽字体。", "Noto Sans Mono (bundled) ships with the app and covers Latin only; Chinese code falls back to the system monospace font.")}
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("本机字体", "Local fonts")}
        description={t("只扫描可免费商用的字体。手动添加仅检测本机可用性，商用授权需自行确认。", "Only free-for-commercial-use fonts are scanned. Manual additions are probed for availability; commercial licensing is your responsibility.")}
      >
        <SettingsRow label={scanning ? t("正在检测本机字体…", "Detecting local fonts…") : t(`已检测到 ${count} 个可用字体`, `${count} available fonts detected`)}>
          <button type="button" className="btn small" disabled={scanning} onClick={scan}>
            {t("重新扫描", "Rescan")}
          </button>
        </SettingsRow>
        <SettingsRow
          stack
          label={t("手动添加字体族", "Add a font family")}
          description={t("例如 OPPO Sans、HarmonyOS Sans；添加后仅检测本机可用性。", "For example OPPO Sans or HarmonyOS Sans; additions are only probed locally.")}
        >
          <div className="font-add">
            <input
              className="input"
              value={draft}
              placeholder={t("字体族名", "Font family name")}
              aria-label={t("添加系统字体", "Add a system font")}
              onChange={(event) => { setDraft(event.target.value); setError(undefined); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFont(); } }}
            />
            <button type="button" className="btn small" onClick={addFont}>{t("添加并检测", "Add & detect")}</button>
          </div>
          {error && <p className="font-add-error">{error}</p>}
          {notice && (
            <p className={`font-notice${notice.kind === "removed" ? " removed" : ""}`} role="status">
              {notice.text}
              {notice.kind === "removed" && (
                <button
                  type="button"
                  onClick={() => {
                    if (removedFamily) appearance.addUserFont(removedFamily);
                    setNotice(undefined);
                    setRemovedFamily(undefined);
                  }}
                >
                  {t("撤销", "Undo")}
                </button>
              )}
            </p>
          )}
          {appearance.userFonts.length > 0 && (
            <div className="font-chips">
              {appearance.userFonts.map((family) => (
                <span key={family} className="font-chip">
                  <span className={fontAvailable(family) ? "" : "missing"}>{family}</span>
                  <button type="button" aria-label={t(`移除 ${family}`, `Remove ${family}`)} title={t("移除", "Remove")} onClick={() => removeFont(family)}>×</button>
                </span>
              ))}
            </div>
          )}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("显示与动效", "Display & motion")}>
        <SettingsRow label={t("界面缩放", "Interface scale")} description={t("只缩放文字与行高，不缩放图标与固定控件高度。", "Scales text and line height only, not icons or fixed control heights.")}>
          <Segmented
            ariaLabel={t("界面缩放", "Interface scale")}
            value={appearance.scale}
            onChange={appearance.setScale}
            options={SCALES.map((scale) => ({ value: scale, label: `${scale}%` }))}
          />
        </SettingsRow>
        <SettingsRow label={t("动画模式", "Motion")}>
          <Segmented
            ariaLabel={t("动画模式", "Motion")}
            value={motion}
            onChange={setMotion}
            options={MOTION_OPTIONS.map((option) => ({ value: option.value, label: t(option.zh, option.en) }))}
          />
        </SettingsRow>
        <SettingsRow stack label={t("动画预览", "Motion preview")}>
          <MotionPreview />
        </SettingsRow>
      </SettingsCard>
      <MotionPreview />
    </>
  );
}
