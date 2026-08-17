/**
 * matchMedia 响应式 Hook（0.4.0 Phase 5b §6.8）：
 * 移动端正判定用 CSS 媒体查询；JS 侧仅在需要状态联动（如抽屉选中后收起）
 * 时读取同一断点，不做 UA 嗅探。
 */
import { useEffect, useState } from "react";

/**
 * 手机断点：与 styles/layout.css 保持一致。仅 ≤768px 走移动布局（抽屉/两行顶栏）；
 * 平板竖屏（768-1024px，3:2/16:10）直接用桌面布局，桌面三栏在该宽度下可正常排布。
 */
export const MOBILE_BREAKPOINT = "(max-width: 768px)";

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
