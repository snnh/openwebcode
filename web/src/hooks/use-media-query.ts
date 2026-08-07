/**
 * matchMedia 响应式 Hook（0.4.0 Phase 5b §6.8）：
 * 移动端正判定用 CSS 媒体查询；JS 侧仅在需要状态联动（如抽屉选中后收起）
 * 时读取同一断点，不做 UA 嗅探。
 */
import { useEffect, useState } from "react";

/** 窄窗口断点：与 styles/layout.css 保持一致；桌面三栏在此宽度以下会产生明显挤压。 */
export const MOBILE_BREAKPOINT = "(max-width: 1024px)";

/** 紧凑断点：与 styles/composer.css 的 ≤768px 密度优化块一致（芯片行零计数整行隐藏等 JS 联动）。 */
export const COMPACT_BREAKPOINT = "(max-width: 768px)";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
