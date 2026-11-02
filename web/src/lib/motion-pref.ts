import { createStore, useStore } from "../app/store";

/**
 * 动效偏好：跟随系统 / 标准 / 精简。
 * 精简模式由各组件读取 reduced 布尔值后分级降级（关闭装饰动画，保留颜色与焦点反馈），
 * 不做全局时长归零；系统级 prefers-reduced-motion 兜底仍由 layout.css 负责。
 */

export type MotionPreference = "system" | "standard" | "reduced";

const KEY = "owc-motion";
const QUERY = "(prefers-reduced-motion: reduce)";

function read(): MotionPreference {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === "standard" || stored === "reduced" || stored === "system") return stored;
  } catch {
    // localStorage 不可用
  }
  return "system";
}

function systemReduced(): boolean {
  return window.matchMedia?.(QUERY).matches ?? false;
}

const motionStore = createStore<{ preference: MotionPreference; systemReduced: boolean }>({
  preference: read(),
  systemReduced: systemReduced(),
});

function syncAttribute(): void {
  const { preference, systemReduced } = motionStore.get();
  const reduced = preference === "reduced" || (preference === "system" && systemReduced);
  document.documentElement.dataset.motion = reduced ? "reduced" : "standard";
}

if (typeof window !== "undefined" && window.matchMedia?.(QUERY)?.addEventListener) {
  window.matchMedia(QUERY).addEventListener("change", (event) => {
    motionStore.set({ systemReduced: event.matches });
    syncAttribute();
  });
}

export function useMotionPreference(): {
  preference: MotionPreference;
  reduced: boolean;
  setPreference(value: MotionPreference): void;
} {
  const state = useStore(motionStore, (current) => current);
  const reduced = state.preference === "reduced" || (state.preference === "system" && state.systemReduced);
  return {
    preference: state.preference,
    reduced,
    setPreference: (value) => {
      try {
        window.localStorage.setItem(KEY, value);
      } catch {
        // 持久化失败不影响本次应用
      }
      motionStore.set({ preference: value });
      syncAttribute();
    },
  };
}

/** 供非 React 侧（motion 配置、一次性动画）读取 */
export function isReducedMotion(): boolean {
  const { preference, systemReduced } = motionStore.get();
  return preference === "reduced" || (preference === "system" && systemReduced);
}

/** 启动时同步 <html data-motion> */
export function installMotionPreference(): void {
  syncAttribute();
}
