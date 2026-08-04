/**
 * 自定义强调色（任意 RGB）解析与派生：
 * 由单个 hex 原色按当前亮/暗主题派生 --accent 四变量组（accent/hover/on-accent/soft）。
 * 纯函数，不依赖 DOM，便于单测。
 */

export type AccentTheme = "light" | "dark";

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isValidHexColor(value: string): boolean {
  return HEX_PATTERN.test(value);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 };
}

/** HSL 明度偏移（delta ∈ [-1, 1]）：hover 态浅色主题加深、深色主题提亮 */
export function shiftLightness(rgb: Rgb, delta: number): Rgb {
  const hsl = rgbToHsl(rgb);
  return hslToRgb({ ...hsl, l: Math.min(1, Math.max(0, hsl.l + delta)) });
}

/** WCAG 相对亮度（0 黑 ~ 1 白），用于决定强调色上的文字取黑还是白 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export interface AccentVars {
  accent: string;
  accentHover: string;
  onAccent: string;
  accentSoft: string;
}

const ON_ACCENT_DARK = "#1c2126";
const ON_ACCENT_LIGHT = "#ffffff";

/** WCAG 对比度（1~21）；两个亮度无大小假设 */
function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 由任意 hex 原色派生四变量组；非法输入返回 undefined（调用方保持现状不应用） */
export function deriveAccentVars(hex: string, theme: AccentTheme): AccentVars | undefined {
  if (!isValidHexColor(hex)) return undefined;
  const rgb = hexToRgb(hex);
  const hover = shiftLightness(rgb, theme === "light" ? -0.09 : 0.09);
  // on-accent 文字色按 WCAG 对比度二选一（黑/白谁对比高用谁），而非固定亮度阈值启发式
  const luminance = relativeLuminance(rgb);
  const darkLuminance = relativeLuminance(hexToRgb(ON_ACCENT_DARK));
  const onAccent = contrastRatio(luminance, darkLuminance) >= contrastRatio(luminance, 1)
    ? ON_ACCENT_DARK
    : ON_ACCENT_LIGHT;
  const softAlpha = theme === "light" ? 0.12 : 0.24;
  return {
    accent: hex.toLowerCase(),
    accentHover: rgbToHex(hover),
    onAccent,
    accentSoft: `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${softAlpha})`,
  };
}
