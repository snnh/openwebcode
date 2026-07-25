import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStreamBuffers } from "../hooks/use-stream-buffers";

/** 手动驱动的 rAF：回调排队，由测试显式触发帧 */
function stubAnimationFrame() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const request = vi.fn((callback: FrameRequestCallback): number => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number): void => {
    callbacks.delete(id);
  });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return {
    request,
    cancel,
    pending: () => callbacks.size,
    runFrame(time = 16): void {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(time);
    },
  };
}

describe("useStreamBuffers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("同一帧内的多个 delta 只造成一次状态提交", () => {
    const frames = stubAnimationFrame();
    const committed: Array<Record<string, string>> = [];
    const { result } = renderHook(() => {
      const buffers = useStreamBuffers();
      committed.push(buffers.stream);
      return buffers;
    });

    act(() => {
      result.current.queueDelta("s1", "你");
      result.current.queueDelta("s1", "好");
      result.current.queueDelta("s1", "。");
    });
    // 帧未到来：只请求了一次 rAF，状态尚未提交
    expect(frames.request).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toEqual({});

    act(() => frames.runFrame());
    expect(result.current.stream).toEqual({ s1: "你好。" });
    // 包含 s1 的状态对象只出现一次，即整帧 delta 合并为一次提交
    expect(committed.filter((stream) => "s1" in stream)).toHaveLength(1);
  });

  it("跨帧 delta 追加到已提交内容之后", () => {
    const frames = stubAnimationFrame();
    const { result } = renderHook(() => useStreamBuffers());

    act(() => result.current.queueDelta("s1", "第一"));
    act(() => frames.runFrame());
    act(() => result.current.queueDelta("s1", "第二"));
    act(() => frames.runFrame());
    expect(result.current.stream).toEqual({ s1: "第一第二" });
  });

  it("思考流与正文流分键合批", () => {
    const frames = stubAnimationFrame();
    const { result } = renderHook(() => useStreamBuffers());

    act(() => {
      result.current.queueDelta("s1", "正文");
      result.current.queueDelta("s1", "思考", true);
    });
    act(() => frames.runFrame());
    expect(result.current.stream).toEqual({ s1: "正文" });
    expect(result.current.thinkingStream).toEqual({ s1: "思考" });
  });

  it("finish 取消挂起的帧并立即提交（卸载/断线不丢尾部 token）", () => {
    const frames = stubAnimationFrame();
    const { result } = renderHook(() => useStreamBuffers());

    act(() => result.current.queueDelta("s1", "尾部"));
    act(() => result.current.finish());
    expect(frames.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toEqual({ s1: "尾部" });
    // 被取消的帧不会再触发
    act(() => frames.runFrame());
    expect(result.current.stream).toEqual({ s1: "尾部" });
  });

  it("discard 丢弃已提交状态与未提交缓冲", () => {
    const frames = stubAnimationFrame();
    const { result } = renderHook(() => useStreamBuffers());

    act(() => result.current.queueDelta("s1", "已提交"));
    act(() => frames.runFrame());
    act(() => {
      result.current.queueDelta("s1", "未提交");
      result.current.discard("s1");
    });
    expect(result.current.stream).toEqual({});
    act(() => frames.runFrame());
    expect(result.current.stream).toEqual({});
  });

  it("clear 清空指定会话的临时流", () => {
    const frames = stubAnimationFrame();
    const { result } = renderHook(() => useStreamBuffers());

    act(() => result.current.queueDelta("s1", "内容"));
    act(() => frames.runFrame());
    act(() => result.current.clear("s1"));
    expect(result.current.stream).toEqual({ s1: "" });
  });

  it("无 rAF 的环境退化为 80ms 定时器合批", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const { result } = renderHook(() => useStreamBuffers());

    act(() => {
      result.current.queueDelta("s1", "a");
      result.current.queueDelta("s1", "b");
    });
    expect(result.current.stream).toEqual({});
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(result.current.stream).toEqual({ s1: "ab" });
  });
});
