import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MOBILE_BREAKPOINT, useMediaQuery } from "../hooks/use-media-query";

interface MockMQL {
  matches: boolean;
  media: string;
  addEventListener: (type: string, listener: (event: { matches: boolean }) => void) => void;
  removeEventListener: (type: string, listener: (event: { matches: boolean }) => void) => void;
}

function mockMatchMedia(initial: boolean): { setMatches(next: boolean): void; calls: string[] } {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const calls: string[] = [];
  const mql: MockMQL = {
    matches: initial,
    media: "",
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    calls.push(query);
    mql.media = query;
    return mql;
  });
  return {
    calls,
    setMatches(next: boolean): void {
      mql.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQuery（移动端断点 state 层，§6.8）", () => {
  it("在桌面三栏开始拥挤前切换窄窗口布局", () => {
    expect(MOBILE_BREAKPOINT).toBe("(max-width: 1024px)");
  });

  it("初始读取 matchMedia 结果", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery(MOBILE_BREAKPOINT));
    expect(result.current).toBe(true);
  });

  it("断点跨越时随 change 事件切换（窄↔宽）", () => {
    const mql = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery(MOBILE_BREAKPOINT));
    expect(result.current).toBe(false);
    act(() => mql.setMatches(true));
    expect(result.current).toBe(true);
    act(() => mql.setMatches(false));
    expect(result.current).toBe(false);
  });

  it("卸载后移除监听", () => {
    const mql = mockMatchMedia(false);
    const { result, unmount } = renderHook(() => useMediaQuery(MOBILE_BREAKPOINT));
    unmount();
    act(() => mql.setMatches(true));
    expect(result.current).toBe(false);
  });
});
