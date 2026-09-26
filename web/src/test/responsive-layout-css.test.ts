import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MOBILE_BREAKPOINT, useMediaQuery } from "../hooks/use-media-query";
// 窄屏回归护栏：只读承载移动布局关键规则的 layout/settings 两个样式文件。
const css = ["layout.css", "settings.css"].map((file) => readFileSync(resolve(process.cwd(), `src/styles/${file}`), "utf8")).join("\n");
// 媒体块以行首 `}` 收尾（内部规则均缩进）。
const narrowCss = [...css.matchAll(/@media \(max-width: 768px\) \{[\s\S]*?\n\}/g)].map((match) => match[0]).join("\n");
function mockMatchMedia(initial: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const mql = { matches: initial, addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { listeners.add(listener); }, removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { listeners.delete(listener); } };
  vi.stubGlobal("matchMedia", () => mql);
  return { setMatches: (next: boolean) => { mql.matches = next; for (const listener of listeners) listener({ matches: next }); } };
}
afterEach(() => vi.unstubAllGlobals());
describe("窄窗口布局护栏", () => {
  it("桌面活动栏隐藏、移动导航触发钮显示（桌面基态隐藏），侧栏与设置钻取转覆盖层；useMediaQuery 初始读 matchMedia、跨越断点随 change 切换、卸载后移除监听", () => {
    expect(css).toMatch(/\.mobile-nav-trigger\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.wb-activity\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.mobile-nav-trigger\s*\{[^}]*display:\s*inline-flex;/s);
    expect(narrowCss).toMatch(/\.wb-sidebar\s*\{[^}]*position:\s*fixed;/s);
    expect(narrowCss).toMatch(/\.settings-layout\.detail-open \.settings-nav\s*\{\s*display:\s*none;/s);
    const mql = mockMatchMedia(true);
    const { result, unmount } = renderHook(() => useMediaQuery(MOBILE_BREAKPOINT));
    expect(result.current).toBe(true);
    act(() => mql.setMatches(false)); expect(result.current).toBe(false);
    unmount();
    act(() => mql.setMatches(true)); expect(result.current).toBe(false);
  });
});
