import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStreamBuffers, type StreamBlock } from "../hooks/use-stream-buffers";

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

/** 会话全部块的 parts 拼接（按块类型过滤） */
function joined(blocks: StreamBlock[] | undefined, kind?: StreamBlock["kind"]): string {
  return (blocks ?? []).filter((block) => !kind || block.kind === kind).map((block) => block.parts.join("")).join("");
}

/** 标准 setup：手动 rAF + 渲染 hook（需自定义渲染的用例自行调 stubAnimationFrame） */
function setup() {
  const frames = stubAnimationFrame();
  const { result } = renderHook(() => useStreamBuffers());
  return { frames, result };
}

describe("useStreamBuffers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("同一帧内的多个 delta 只造成一次状态提交", () => {
    const frames = stubAnimationFrame();
    const committed: Array<Record<string, StreamBlock[]>> = [];
    const { result } = renderHook(() => {
      const buffers = useStreamBuffers();
      committed.push(buffers.blocks);
      return buffers;
    });

    act(() => {
      result.current.queueDelta("s1", "你");
      result.current.queueDelta("s1", "好");
      result.current.queueDelta("s1", "。");
    });
    // 帧未到来：只请求了一次 rAF，状态尚未提交
    expect(frames.request).toHaveBeenCalledTimes(1);
    expect(result.current.blocks).toEqual({});

    act(() => frames.runFrame());
    expect(joined(result.current.blocks.s1)).toBe("你好。");
    // 包含 s1 的状态对象只出现一次，即整帧 delta 合并为一次提交
    expect(committed.filter((blocks) => "s1" in blocks)).toHaveLength(1);
  });

  it("跨帧 delta 追加到已提交内容之后", () => {
    const { frames, result } = setup();

    act(() => result.current.queueDelta("s1", "第一"));
    act(() => frames.runFrame());
    act(() => result.current.queueDelta("s1", "第二"));
    act(() => frames.runFrame());
    expect(result.current.blocks.s1).toHaveLength(1);
    expect(result.current.blocks.s1?.[0]?.parts).toEqual(["第一", "第二"]);
  });

  it("text/thinking/tool 按 delta 到达顺序形成有序块，同类相邻并入同段", () => {
    const { frames, result } = setup();

    act(() => {
      result.current.queueDelta("s1", "正文一");
      result.current.queueDelta("s1", "思考", true);
      result.current.queueDelta("s1", "正文二");
      result.current.queueToolCallDelta("s1", "c1", "read_file", "{\"path\":\"a.ts\"}");
      result.current.queueDelta("s1", "正文三");
    });
    act(() => frames.runFrame());
    const blocks = result.current.blocks.s1 ?? [];
    expect(blocks.map((block) => block.kind)).toEqual(["text", "thinking", "text", "tool", "text"]);
    expect(blocks.map((block) => block.parts.join(""))).toEqual(["正文一", "思考", "正文二", "{\"path\":\"a.ts\"}", "正文三"]);
    expect(blocks[3]?.name).toBe("read_file");
  });

  it("平滑放出：短文本按基线字符预算逐帧匀速放出", () => {
    const { frames, result } = setup();

    act(() => result.current.queueDelta("s1", "abcdef"));
    act(() => frames.runFrame());
    // 首帧只放出基线预算（非全量），并自动续帧
    expect(joined(result.current.blocks.s1)).toBe("abc");
    act(() => frames.runFrame());
    expect(joined(result.current.blocks.s1)).toBe("abcdef");
    expect(result.current.blocks.s1?.[0]?.parts).toEqual(["abc", "def"]);
    // 积压放完：不再续帧
    expect(frames.pending()).toBe(0);
  });

  it("平滑放出：大积压自适应加速追平，且无需新 delta 即可放完", () => {
    const { frames, result } = setup();
    const text = "x".repeat(100);

    act(() => result.current.queueDelta("s1", text));
    act(() => frames.runFrame());
    const firstRelease = joined(result.current.blocks.s1).length;
    // 积压 100：首帧预算 = 100/8 = 13（> 基线 3，随积压加速）
    expect(firstRelease).toBe(13);
    expect(firstRelease).toBeLessThan(text.length);

    // 自动续帧：不再 queueDelta，若干帧后追平全量
    for (let i = 0; i < 20 && joined(result.current.blocks.s1).length < text.length; i += 1) {
      act(() => frames.runFrame());
    }
    expect(joined(result.current.blocks.s1)).toBe(text);
    expect(frames.pending()).toBe(0);
  });

  it("工具参数增量不平滑：长分片当帧全量实时提交", () => {
    const { frames, result } = setup();
    const args = `{"content":"${"y".repeat(500)}"}`;

    act(() => result.current.queueToolCallDelta("s1", "c1", "write_file", args));
    act(() => frames.runFrame());
    expect(joined(result.current.blocks.s1, "tool")).toBe(args);
    // 工具块无积压：不续帧
    expect(frames.pending()).toBe(0);
  });

  it("finish 取消挂起的帧并立即全量提交（卸载/断线不丢尾部 token）", () => {
    const { frames, result } = setup();
    const text = "z".repeat(100);

    act(() => result.current.queueDelta("s1", text));
    act(() => result.current.finish());
    expect(frames.cancel).toHaveBeenCalledTimes(1);
    expect(joined(result.current.blocks.s1)).toBe(text);
    // 被取消的帧不会再触发
    act(() => frames.runFrame());
    expect(joined(result.current.blocks.s1)).toBe(text);
  });

  it("flush 取消挂起的帧再同步提交（下一帧不多跑一次空回调）", () => {
    const { frames, result } = setup();

    act(() => result.current.queueDelta("s1", "abcdef"));
    act(() => result.current.flush());
    // 挂起的合批帧被取消；flush 按预算同步提交一帧
    expect(frames.cancel).toHaveBeenCalledTimes(1);
    expect(joined(result.current.blocks.s1)).toBe("abc");
    // 仍有积压：只续了一帧（被取消的旧帧不会再跑）
    expect(frames.pending()).toBe(1);
    act(() => frames.runFrame());
    expect(joined(result.current.blocks.s1)).toBe("abcdef");
    expect(frames.pending()).toBe(0);
  });

  it("clear 清空已提交状态与未放出的平滑积压（stream_reset 语义）", () => {
    const { frames, result } = setup();

    act(() => result.current.queueDelta("s1", "x".repeat(100)));
    act(() => frames.runFrame());
    expect(joined(result.current.blocks.s1).length).toBeGreaterThan(0);
    act(() => result.current.clear("s1"));
    expect(result.current.blocks).toEqual({ s1: [] });
    // 未放出的积压也已丢弃：后续帧不再补放
    act(() => frames.runFrame());
    expect(result.current.blocks).toEqual({ s1: [] });
  });

  it("discard 丢弃已提交状态与未提交缓冲", () => {
    const { frames, result } = setup();

    act(() => result.current.queueDelta("s1", "已提交"));
    act(() => frames.runFrame());
    act(() => {
      result.current.queueDelta("s1", "未提交");
      result.current.discard("s1");
    });
    expect(result.current.blocks).toEqual({});
    act(() => frames.runFrame());
    expect(result.current.blocks).toEqual({});
  });

  it("工具调用分片按 id 分组合批，name 首片保留；name-only 首片先建立卡片", () => {
    const { frames, result } = setup();

    act(() => {
      result.current.queueToolCallDelta("s1", "c1", "read_file", "");
      result.current.queueToolCallDelta("s1", "c2", "glob", "{");
      result.current.queueToolCallDelta("s1", "c1", undefined, "{\"path\"");
    });
    act(() => frames.runFrame());
    const blocks = result.current.blocks.s1 ?? [];
    expect(blocks.map((block) => block.id)).toEqual(["c1", "c2"]);
    expect(blocks[0]?.name).toBe("read_file");
    expect(blocks[0]?.parts.join("")).toBe("{\"path\"");
    expect(blocks[1]?.name).toBe("glob");
    expect(blocks[1]?.parts.join("")).toBe("{");

    // 跨帧追加合并到同一 id 之后，帧间不清空
    act(() => result.current.queueToolCallDelta("s1", "c1", undefined, ":\"a.ts\"}"));
    act(() => frames.runFrame());
    expect(result.current.blocks.s1?.[0]?.parts.join("")).toBe("{\"path\":\"a.ts\"}");

    act(() => result.current.clear("s1"));
    expect(result.current.blocks).toEqual({ s1: [] });
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
    expect(result.current.blocks).toEqual({});
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(joined(result.current.blocks.s1)).toBe("ab");
  });
});
