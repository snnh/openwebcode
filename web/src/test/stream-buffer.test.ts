import { describe, expect, it, vi } from "vitest";
import { createStreamBuffer, releaseBudget, type StreamBlock } from "../chat/stream-buffer";

/** 手动帧驱动：回调排队，由测试显式触发 */
function manualFrames() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  const scheduleFrame = vi.fn((callback: () => void): number => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number): void => {
    callbacks.delete(id);
  });
  return {
    env: { scheduleFrame, cancelFrame },
    scheduleFrame,
    cancelFrame,
    pending: () => callbacks.size,
    runFrame(): void {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
}

function joined(blocks: StreamBlock[], kind?: StreamBlock["kind"]): string {
  return blocks.filter((block) => !kind || block.kind === kind).map((block) => block.parts.join("")).join("");
}

describe("createStreamBuffer", () => {
  it("releaseBudget：基线 3，积压自适应加速", () => {
    expect(releaseBudget(0)).toBe(0);
    expect(releaseBudget(2)).toBe(2);
    expect(releaseBudget(10)).toBe(3);
    expect(releaseBudget(100)).toBe(13);
  });

  it("同一帧内的多个 delta 只提交一次（订阅者通知一次）", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    const notify = vi.fn();
    buffer.subscribe(notify);

    buffer.queueDelta("s1", "你");
    buffer.queueDelta("s1", "好");
    buffer.queueDelta("s1", "。");
    expect(frames.scheduleFrame).toHaveBeenCalledTimes(1);
    expect(buffer.blocksFor("s1")).toEqual([]);

    frames.runFrame();
    expect(joined(buffer.blocksFor("s1"))).toBe("你好。");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("跨帧 delta 追加到已提交内容之后；无内容会话返回共享空数组", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "第一");
    frames.runFrame();
    buffer.queueDelta("s1", "第二");
    frames.runFrame();
    expect(buffer.blocksFor("s1")).toHaveLength(1);
    expect(buffer.blocksFor("s1")[0]?.parts).toEqual(["第一", "第二"]);
    expect(buffer.blocksFor("s2")).toBe(buffer.blocksFor("s3"));
  });

  it("text/thinking/tool 按到达顺序成块，同类相邻并入同段", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "正文一");
    buffer.queueDelta("s1", "思考", true);
    buffer.queueDelta("s1", "正文二");
    buffer.queueToolCallDelta("s1", "c1", "read_file", "{\"path\":\"a.ts\"}");
    buffer.queueDelta("s1", "正文三");
    frames.runFrame();
    const blocks = buffer.blocksFor("s1");
    expect(blocks.map((block) => block.kind)).toEqual(["text", "thinking", "text", "tool", "text"]);
    expect(blocks.map((block) => block.parts.join(""))).toEqual(["正文一", "思考", "正文二", "{\"path\":\"a.ts\"}", "正文三"]);
    expect(blocks[3]?.name).toBe("read_file");
  });

  it("预算放出：基线逐帧放出、大积压自适应加速追平", () => {
    // 短文本按基线预算逐帧放出，放完不续帧
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "abcdef");
    frames.runFrame();
    expect(joined(buffer.blocksFor("s1"))).toBe("abc");
    frames.runFrame();
    expect(joined(buffer.blocksFor("s1"))).toBe("abcdef");
    expect(buffer.blocksFor("s1")[0]?.parts).toEqual(["abc", "def"]);
    expect(frames.pending()).toBe(0);

    // 大积压自适应加速追平，无需新 delta 即可放完
    const burstFrames = manualFrames();
    const burstBuffer = createStreamBuffer(burstFrames.env);
    const text = "x".repeat(100);
    burstBuffer.queueDelta("s1", text);
    burstFrames.runFrame();
    expect(joined(burstBuffer.blocksFor("s1"))).toHaveLength(13);
    for (let i = 0; i < 20 && joined(burstBuffer.blocksFor("s1")).length < text.length; i += 1) burstFrames.runFrame();
    expect(joined(burstBuffer.blocksFor("s1"))).toBe(text);
    expect(burstFrames.pending()).toBe(0);
  });

  it("工具参数增量不平滑：长分片当帧全量提交；name-only 首片先建卡片", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueToolCallDelta("s1", "c1", "read_file", "");
    buffer.queueToolCallDelta("s1", "c2", "glob", "{");
    buffer.queueToolCallDelta("s1", "c1", undefined, "{\"path\"");
    frames.runFrame();
    const blocks = buffer.blocksFor("s1");
    expect(blocks.map((block) => block.id)).toEqual(["c1", "c2"]);
    expect(blocks[0]?.name).toBe("read_file");
    expect(blocks[1]?.parts.join("")).toBe("{");
    buffer.queueToolCallDelta("s1", "c1", undefined, ":\"a.ts\"}");
    frames.runFrame();
    expect(buffer.blocksFor("s1")[0]?.parts.join("")).toBe("{\"path\":\"a.ts\"}");
    expect(frames.pending()).toBe(0);
  });

  it("finish 取消挂起帧并全量提交；flush 取消挂起帧按预算提交一帧", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "z".repeat(100));
    buffer.finish();
    expect(frames.cancelFrame).toHaveBeenCalledTimes(1);
    expect(joined(buffer.blocksFor("s1"))).toHaveLength(100);

    buffer.clear("s1");
    buffer.queueDelta("s1", "abcdef");
    buffer.flush();
    expect(joined(buffer.blocksFor("s1"))).toBe("abc");
    expect(frames.pending()).toBe(1);
    frames.runFrame();
    expect(joined(buffer.blocksFor("s1"))).toBe("abcdef");
    expect(frames.pending()).toBe(0);
  });

  it("clear 清空已提交与未放出积压（stream_reset 语义）；discard 连提交区一起丢弃", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "x".repeat(100));
    frames.runFrame();
    buffer.clear("s1");
    expect(buffer.blocksFor("s1")).toEqual([]);
    frames.runFrame();
    expect(buffer.blocksFor("s1")).toEqual([]);

    buffer.queueDelta("s1", "已提交");
    frames.runFrame();
    buffer.queueDelta("s1", "未提交");
    buffer.discard("s1");
    expect(buffer.blocksFor("s1")).toEqual([]);
    frames.runFrame();
    expect(buffer.blocksFor("s1")).toEqual([]);
  });

  it("默认环境：无 rAF 时退化为 80ms 定时器合批", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    try {
      const buffer = createStreamBuffer();
      const notify = vi.fn();
      buffer.subscribe(notify);
      buffer.queueDelta("s1", "a");
      buffer.queueDelta("s1", "b");
      expect(buffer.blocksFor("s1")).toEqual([]);
      vi.advanceTimersByTime(80);
      expect(joined(buffer.blocksFor("s1"))).toBe("ab");
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
