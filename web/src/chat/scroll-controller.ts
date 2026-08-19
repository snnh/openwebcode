/**
 * 聊天滚动跟随控制器（框架无关，纯逻辑可单测，注入假 DOM 度量）。
 *
 * 根治旧实现的两个滚动 bug：
 * ① 上滚查看历史被拉回底部——内容变化只在 following 时吸底，不跟随时绝不拽动滚动；
 * ② 前插历史消息跳动——preparePrepend/applyPrepend 以 scrollHeight 差值补偿，
 *    补偿期间关闭浏览器 overflow-anchor 防止二次补偿。
 *
 * following 语义：距底 < BOTTOM_THRESHOLD 视为贴底；用户 wheel 向上 / touchmove /
 * PageUp/ArrowUp/Home 或任意使滚动离开阈值区的滚动 → following=false；
 * 滚动回到阈值区内 → following=true。状态变化才触发 onFollowingChange 回调。
 */

/** 距底小于该像素值视为「贴底」 */
export const BOTTOM_THRESHOLD = 40;

/** restore 的返回值：数值为记忆的 scrollTop；"bottom" 表示此前贴底或无记忆 */
type ScrollRestoreTarget = number | "bottom";

/** 结构兼容 HTMLElement 的最小滚动容器（测试用假 DOM 实现同形接口） */
export interface ScrollFollowerTarget {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly style: { overflowAnchor: string };
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  scrollTo?(options: { top: number; behavior?: "smooth" | "auto" }): void;
}

export interface ScrollFollower {
  attach(el: ScrollFollowerTarget): void;
  detach(): void;
  readonly following: boolean;
  /** 订阅 following 变化（仅变化时触发）；返回退订函数 */
  onFollowingChange(callback: (following: boolean) => void): () => void;
  /** 内容变化通知：仅 following 时即时吸底；不跟随时不动滚动 */
  notifyContentChanged(): void;
  /** 前插渲染前调用：记录当前 scrollHeight/scrollTop，并关闭 overflow-anchor */
  preparePrepend(): void;
  /** 前插渲染后调用（layout effect 内）：按高度差补偿 scrollTop，恢复 overflow-anchor */
  applyPrepend(): void;
  /** 回到底部（可选平滑）；进入跟随态 */
  scrollToBottom(smooth?: boolean): void;
  /** 记忆该会话的滚动位置与跟随态（卸载/切换会话前调用） */
  remember(sessionId: string): void;
  /** 取回该会话的记忆：数值 scrollTop，或 "bottom"（此前贴底/无记忆） */
  restore(sessionId: string): ScrollRestoreTarget;
}

interface MemoryEntry {
  scrollTop: number;
  following: boolean;
}

interface PrependSnapshot {
  scrollHeight: number;
  scrollTop: number;
  overflowAnchor: string;
}

export function createScrollFollower(): ScrollFollower {
  let el: ScrollFollowerTarget | undefined;
  let following = true;
  /** 平滑回底进行中：途中的 scroll 事件不视为用户脱离跟随 */
  let smoothing = false;
  let prepend: PrependSnapshot | undefined;
  const listeners = new Set<(value: boolean) => void>();
  const memory = new Map<string, MemoryEntry>();

  const distanceToBottom = (): number => (el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0);

  const setFollowing = (value: boolean): void => {
    if (following === value) return;
    following = value;
    for (const listener of listeners) listener(value);
  };

  const onScroll = (): void => {
    if (distanceToBottom() < BOTTOM_THRESHOLD) {
      smoothing = false;
      setFollowing(true);
    } else if (!smoothing) {
      setFollowing(false);
    }
  };

  const onWheel = (event: Event): void => {
    if ((event as WheelEvent).deltaY < 0) {
      smoothing = false;
      setFollowing(false);
    }
  };

  const onTouchMove = (): void => {
    smoothing = false;
    setFollowing(false);
  };

  const onKeyDown = (event: Event): void => {
    const key = (event as KeyboardEvent).key;
    if (key === "PageUp" || key === "ArrowUp" || key === "Home") {
      smoothing = false;
      setFollowing(false);
    }
  };

  return {
    attach(target) {
      el = target;
      el.addEventListener("scroll", onScroll);
      el.addEventListener("wheel", onWheel);
      el.addEventListener("touchmove", onTouchMove);
      el.addEventListener("keydown", onKeyDown);
      following = distanceToBottom() < BOTTOM_THRESHOLD;
    },
    detach() {
      if (!el) return;
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el = undefined;
      prepend = undefined;
    },
    get following() {
      return following;
    },
    onFollowingChange(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    notifyContentChanged() {
      if (!el || !following) return;
      // 即时（非平滑）吸底：流式增量不动画
      el.scrollTop = el.scrollHeight;
    },
    preparePrepend() {
      if (!el) return;
      prepend = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        overflowAnchor: el.style.overflowAnchor,
      };
      // 补偿期间关闭浏览器原生滚动锚定，防止与手动补偿叠加
      el.style.overflowAnchor = "none";
    },
    applyPrepend() {
      if (!el || !prepend) return;
      const snapshot = prepend;
      prepend = undefined;
      el.scrollTop = el.scrollHeight - (snapshot.scrollHeight - snapshot.scrollTop);
      el.style.overflowAnchor = snapshot.overflowAnchor;
    },
    scrollToBottom(smooth = false) {
      if (!el) return;
      setFollowing(true);
      if (smooth && typeof el.scrollTo === "function") {
        smoothing = true;
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        smoothing = false;
        el.scrollTop = el.scrollHeight;
      }
    },
    remember(sessionId) {
      memory.set(sessionId, { scrollTop: el?.scrollTop ?? 0, following });
    },
    restore(sessionId) {
      const entry = memory.get(sessionId);
      if (!entry || entry.following) return "bottom";
      return entry.scrollTop;
    },
  };
}
