import { useEffect, type RefObject } from "react";

/**
 * textarea 自适应高度：内容变化时先收 auto 再按 scrollHeight 撑开。
 * 传 maxHeightPx 时由 JS 封顶（chat 模式 200px）；缺省时上限交给 CSS max-height，
 * 并根据是否真实溢出切换 overflowY（workbench Composer）。
 */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightPx?: number,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    if (maxHeightPx === undefined) {
      el.style.height = `${el.scrollHeight}px`;
      el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
    } else {
      el.style.height = `${Math.min(el.scrollHeight, maxHeightPx)}px`;
    }
  }, [ref, value, maxHeightPx]);
}
