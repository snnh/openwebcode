/**
 * jsdom 的 window.matchMedia 恒返回 matches=false，移动端分支
 *（`useMediaQuery(MOBILE_BREAKPOINT)`）无法覆盖：用例按需固定判定值。
 * change 监听为空实现——不测运行时断点切换，只测两种静态形态；
 * 直接赋值（非 spy），需要恢复桌面态的用例在 beforeEach 里调 stubMatchMedia(false)。
 */
export function stubMatchMedia(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener() { /* no-op */ },
    removeListener() { /* no-op */ },
    addEventListener() { /* no-op */ },
    removeEventListener() { /* no-op */ },
    dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
}
