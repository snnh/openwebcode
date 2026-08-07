import { describe, expect, it, vi } from "vitest";
import { BOTTOM_THRESHOLD, createScrollFollower, type ScrollFollowerTarget } from "../chat/scroll-controller";

type Listener = (event: Record<string, unknown>) => void;

/** 假滚动容器：度量字段直接可变，emit 触发已注册监听器 */
function makeFakeEl(metrics: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}): ScrollFollowerTarget & { scrollTop: number; scrollHeight: number; clientHeight: number; style: { overflowAnchor: string }; emit(type: string, event?: Record<string, unknown>): void } {
  const listeners = new Map<string, Set<Listener>>();
  const el = {
    scrollTop: metrics.scrollTop ?? 0,
    scrollHeight: metrics.scrollHeight ?? 0,
    clientHeight: metrics.clientHeight ?? 0,
    style: { overflowAnchor: "" },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener as unknown as Listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      listeners.get(type)?.delete(listener as unknown as Listener);
    },
    scrollTo: vi.fn((options: { top: number }) => {
      el.scrollTop = options.top;
    }),
    emit(type: string, event: Record<string, unknown> = {}): void {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return el as unknown as ReturnType<typeof makeFakeEl>;
}

describe("createScrollFollower", () => {
  it("按阈值判定贴底：距底 < 40 为跟随，超过则脱离", () => {
    const el = makeFakeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    const follower = createScrollFollower();
    follower.attach(el);
    expect(follower.following).toBe(true);

    el.scrollTop = 800 - BOTTOM_THRESHOLD; // 距底恰 40：不算贴底
    el.emit("scroll");
    expect(follower.following).toBe(false);

    el.scrollTop = 800 - BOTTOM_THRESHOLD + 1; // 距底 39：回到跟随
    el.emit("scroll");
    expect(follower.following).toBe(true);
  });

  it("用户上滚意图（wheel 向上 / PageUp / ArrowUp / Home / touchmove）脱离跟随", () => {
    const el = makeFakeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    const follower = createScrollFollower();
    follower.attach(el);
    expect(follower.following).toBe(true);

    el.emit("wheel", { deltaY: -100 });
    expect(follower.following).toBe(false);

    follower.scrollToBottom();
    expect(follower.following).toBe(true);
    el.emit("keydown", { key: "PageUp" });
    expect(follower.following).toBe(false);

    follower.scrollToBottom();
    el.emit("touchmove");
    expect(follower.following).toBe(false);

    // wheel 向下不构成上滚意图
    follower.scrollToBottom();
    el.emit("wheel", { deltaY: 100 });
    expect(follower.following).toBe(true);
  });

  it("following 变化才触发 onFollowingChange 回调", () => {
    const el = makeFakeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    const follower = createScrollFollower();
    follower.attach(el);
    const callback = vi.fn();
    follower.onFollowingChange(callback);

    el.scrollTop = 100;
    el.emit("scroll");
    el.scrollTop = 50;
    el.emit("scroll"); // 仍为 false：不重复触发
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenLastCalledWith(false);

    el.scrollTop = 800;
    el.emit("scroll");
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(true);
  });

  it("notifyContentChanged：跟随时吸底，不跟随时绝不拽动滚动", () => {
    const el = makeFakeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    const follower = createScrollFollower();
    follower.attach(el);

    el.scrollHeight = 1200; // 内容增长
    follower.notifyContentChanged();
    expect(el.scrollTop).toBe(1200);

    // 用户上滚脱离跟随后，内容增长不拽动
    el.emit("wheel", { deltaY: -50 });
    el.scrollTop = 400;
    el.scrollHeight = 1500;
    follower.notifyContentChanged();
    expect(el.scrollTop).toBe(400);
  });

  it("前插补偿：applyPrepend 按 scrollHeight 差值还原视口，overflowAnchor 先关后恢复", () => {
    const el = makeFakeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 300 });
    el.style.overflowAnchor = "auto";
    const follower = createScrollFollower();
    follower.attach(el);
    el.emit("wheel", { deltaY: -10 });

    follower.preparePrepend();
    expect(el.style.overflowAnchor).toBe("none");

    el.scrollHeight = 1600; // 前插 600px 内容
    follower.applyPrepend();
    expect(el.scrollTop).toBe(1600 - (1000 - 300)); // 900
    expect(el.style.overflowAnchor).toBe("auto");

    // 未 prepare 的 apply 是安全空操作
    const top = el.scrollTop;
    follower.applyPrepend();
    expect(el.scrollTop).toBe(top);
  });

  it("remember/restore：贴底记为 bottom，脱离跟随记住 scrollTop，无记忆返回 bottom", () => {
    const el = makeFakeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    const follower = createScrollFollower();
    follower.attach(el);

    follower.remember("pinned-session");
    expect(follower.restore("pinned-session")).toBe("bottom");

    el.emit("wheel", { deltaY: -10 });
    el.scrollTop = 333;
    follower.remember("reading-session");
    expect(follower.restore("reading-session")).toBe(333);

    expect(follower.restore("unknown-session")).toBe("bottom");
  });

  it("平滑回底途中不因中间 scroll 事件脱离跟随，用户 wheel 上滚可打断", () => {
    const el = makeFakeEl({ scrollHeight: 2000, clientHeight: 200, scrollTop: 100 });
    const follower = createScrollFollower();
    follower.attach(el);
    el.emit("scroll"); // 距底 1700 → 不跟随
    expect(follower.following).toBe(false);

    follower.scrollToBottom(true);
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    expect(follower.following).toBe(true);
    el.scrollTop = 1200; // 平滑途中：距底仍超阈值
    el.emit("scroll");
    expect(follower.following).toBe(true);

    // 用户在平滑途中上滚：立即脱离
    el.emit("wheel", { deltaY: -30 });
    expect(follower.following).toBe(false);
  });
});
