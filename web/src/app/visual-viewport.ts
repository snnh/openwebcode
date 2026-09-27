/**
 * iOS Safari 软键盘适配（P0）：iOS 不支持 viewport meta 的 interactive-widget=resizes-content，
 * 键盘弹出只缩 visualViewport、不改布局视口——外壳 height:100dvh 不变，位于壳底的
 * Composer 会整体落到键盘之下，无法输入。
 *
 * 这里监听 visualViewport，把「底部被硬遮挡」时的真实可视高度写入根变量 --vvh，
 * 移动端外壳 height: var(--vvh, 100dvh) 随键盘压缩，Composer 始终贴在键盘上缘。
 *
 * 触发判定（两个干扰源必须排除）：
 * - 地址栏收起/展开：innerHeight 与 visualViewport.height 同步变化，底部遮挡量 ≈ 0；
 * - 双指捏合缩放：visualViewport.scale > 1（此时遮挡量也非零，但不应接管外壳高度）。
 * 遮挡量阈值 120px：低于它的底部缺口（地址栏动画过渡态、手势条）不接管，避免高度抖动。
 * 桌面端 visualViewport.height === innerHeight，永不触发；变量仅在键盘弹出期间存在。
 */

/** 底部遮挡超过该高度才判定为软键盘（px） */
export const KEYBOARD_OCCLUSION_THRESHOLD = 120;

let installed = false;

export function installVisualViewportHeight(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  const viewport = window.visualViewport;
  if (!viewport) return;
  installed = true;
  const root = document.documentElement;
  const apply = (): void => {
    const occluded = window.innerHeight - viewport.height - viewport.offsetTop;
    if (viewport.scale <= 1 && occluded > KEYBOARD_OCCLUSION_THRESHOLD) {
      root.style.setProperty("--vvh", `${Math.round(viewport.height)}px`);
    } else {
      root.style.removeProperty("--vvh");
    }
  };
  // resize：键盘弹出/收起、地址栏动画；scroll：键盘弹出后页面被推移（offsetTop 变化）
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  apply();
}
