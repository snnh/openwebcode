import { fontAvailable, firstFamily } from "./font-detect";

/**
 * 常见系统字体候选表（默认只列「可免费商用」字体）：
 * - 开源许可：OFL / Apache / GPL+font exception
 * - 厂商免费商用授权：OPPO Sans、HarmonyOS Sans、MiSans、Alibaba PuHuiTi、vivo Sans、HONOR Sans
 * 不含 Windows/macOS 自带商用字体（雅黑、苹方、Segoe、SF 等）——这类字体只能由用户
 * 在设置页手动输入族名后单独探测，不进入默认扫描结果。
 */
export const LATIN_CANDIDATES = [
  "Inter", "Roboto", "Noto Sans", "Noto Sans Display", "Open Sans", "Lato", "Montserrat",
  "Poppins", "Source Sans 3", "Source Sans Pro", "IBM Plex Sans", "Fira Sans", "Geist",
  "Ubuntu", "Cantarell", "DejaVu Sans", "Liberation Sans",
];

export const CJK_CANDIDATES = [
  // 开源
  "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "Source Han Sans CN", "思源黑体",
  "Noto Serif SC", "Source Han Serif SC", "Sarasa Gothic SC", "LXGW WenKai",
  "WenQuanYi Micro Hei", "WenQuanYi Zen Hei",
  // 厂商免费商用
  "OPPO Sans", "OPPO Sans SC", "HarmonyOS Sans SC", "HarmonyOS Sans", "MiSans", "MiSans VF",
  "Alibaba PuHuiTi", "Alibaba PuHuiTi 3.0", "Alibaba PuHuiTi 2.0", "vivo Sans", "HONOR Sans",
];

export const MONO_CANDIDATES = [
  "JetBrains Mono", "Fira Code", "Cascadia Code", "Cascadia Mono", "Source Code Pro",
  "IBM Plex Mono", "Noto Sans Mono", "Sarasa Mono SC", "Iosevka", "Hack", "Inconsolata",
  "Ubuntu Mono", "Roboto Mono", "Space Mono", "Anonymous Pro", "Victor Mono", "Recursive Mono",
  "DejaVu Sans Mono", "Liberation Mono",
];

export interface DetectedFonts {
  latin: string[];
  cjk: string[];
  mono: string[];
}

const dedupe = (list: string[]): string[] => [...new Set(list)].filter(Boolean);

/** 探测候选表中真实可用的字体族（结果在 font-detect 内缓存） */
export function detectFonts(): DetectedFonts {
  return {
    latin: dedupe(LATIN_CANDIDATES).filter((family) => fontAvailable(family)),
    cjk: dedupe(CJK_CANDIDATES).filter((family) => fontAvailable(family)),
    mono: dedupe(MONO_CANDIDATES).filter((family) => fontAvailable(family)),
  };
}

export function isPresetAvailable(stack: string | null): boolean {
  if (!stack) return true;
  return fontAvailable(firstFamily(stack));
}
