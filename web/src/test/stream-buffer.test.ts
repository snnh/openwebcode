import { describe, expect, it, vi } from "vitest";
import { createStreamBuffer, releaseBudget, type StreamBlock } from "../chat/stream-buffer";
/** 手动帧驱动：回调排队，由测试显式触发。 */
function manualFrames() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  const cancelFrame = vi.fn((id: number): void => { callbacks.delete(id); });
  return {
    env: { scheduleFrame: (callback: () => void): number => { const id = nextId++; callbacks.set(id, callback); return id; }, cancelFrame }, cancelFrame,
    pending: () => callbacks.size,
    runFrame(): void { const queued = [...callbacks.values()]; callbacks.clear(); for (const callback of queued) callback(); },
  };
}
const joined = (blocks: StreamBlock[], kind?: StreamBlock["kind"]): string =>
  blocks.filter((block) => !kind || block.kind === kind).map((block) => block.parts.join("")).join("");
describe("createStreamBuffer", () => {
  it("同帧内多个 delta 合并为一次提交（同类并入同段）；跨帧追加到已提交之后；无内容会话共享空数组", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "你"); buffer.queueDelta("s1", "好"); buffer.queueDelta("s1", "。");
    expect(buffer.blocksFor("s1")).toEqual([]);
    frames.runFrame(); expect(buffer.blocksFor("s1")[0]?.parts).toEqual(["你好。"]);
    buffer.queueDelta("s1", "第二"); frames.runFrame(); expect(buffer.blocksFor("s1")[0]?.parts).toEqual(["你好。", "第二"]);
  });
  it("text/thinking/tool 按到达顺序成块，同类相邻并入同段", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "正文一"); buffer.queueDelta("s1", "思考", true); buffer.queueDelta("s1", "正文二");
    buffer.queueToolCallDelta("s1", "c1", "read_file", '{"path":"a.ts"}'); buffer.queueDelta("s1", "正文三");
    frames.runFrame();
    const blocks = buffer.blocksFor("s1");
    expect(blocks.map((block) => block.kind)).toEqual(["text", "thinking", "text", "tool", "text"]);
    expect(joined(blocks)).toBe('正文一思考正文二{"path":"a.ts"}正文三');
  });
  it("releaseBudget 基线随积压自适应加速；短文本逐帧放出、大积压无新 delta 追平", () => {
    expect([releaseBudget(0), releaseBudget(2), releaseBudget(10), releaseBudget(100)]).toEqual([0, 2, 3, 13]);
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "abcdef");
    frames.runFrame(); expect(joined(buffer.blocksFor("s1"))).toBe("abc");
    frames.runFrame(); expect(joined(buffer.blocksFor("s1"))).toBe("abcdef"); expect(frames.pending()).toBe(0);
    const burst = manualFrames();
    const burstBuffer = createStreamBuffer(burst.env);
    const text = "x".repeat(100);
    burstBuffer.queueDelta("s1", text); burst.runFrame();
    expect(joined(burstBuffer.blocksFor("s1"))).toHaveLength(13);
    for (let index = 0; index < 20 && joined(burstBuffer.blocksFor("s1")).length < text.length; index += 1) burst.runFrame();
    expect(joined(burstBuffer.blocksFor("s1"))).toBe(text);
  });
  it("工具参数增量不平滑：长分片当帧全量提交；name-only 首片先建卡片", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueToolCallDelta("s1", "c1", "read_file", ""); buffer.queueToolCallDelta("s1", "c2", "glob", "{"); buffer.queueToolCallDelta("s1", "c1", undefined, '{"path"');
    frames.runFrame();
    expect(buffer.blocksFor("s1").map((block) => block.id)).toEqual(["c1", "c2"]);
    buffer.queueToolCallDelta("s1", "c1", undefined, ':"a.ts"}');
    frames.runFrame();
    expect(buffer.blocksFor("s1")[0]?.parts.join("")).toBe('{"path":"a.ts"}'); expect(frames.pending()).toBe(0);
  });
  it("finish 取消挂起帧并全量提交；flush 按预算提交一帧；clear 清空、discard 连提交区丢弃；无 rAF 时退化为 80ms 定时器合批", () => {
    const frames = manualFrames();
    const buffer = createStreamBuffer(frames.env);
    buffer.queueDelta("s1", "z".repeat(100)); buffer.finish();
    expect(joined(buffer.blocksFor("s1"))).toHaveLength(100);
    buffer.clear("s1"); expect(buffer.blocksFor("s1")).toEqual([]);
    buffer.queueDelta("s1", "abcdef"); buffer.flush(); expect(joined(buffer.blocksFor("s1"))).toBe("abc");
    buffer.discard("s1"); frames.runFrame(); expect(buffer.blocksFor("s1")).toEqual([]);
    // 无 rAF 时退化为 80ms 定时器合批
    vi.useFakeTimers(); vi.stubGlobal("requestAnimationFrame", undefined); vi.stubGlobal("cancelAnimationFrame", undefined);
    try {
      const timerBuffer = createStreamBuffer();
      timerBuffer.queueDelta("s1", "a"); timerBuffer.queueDelta("s1", "b");
      expect(timerBuffer.blocksFor("s1")).toEqual([]);
      vi.advanceTimersByTime(80); expect(joined(timerBuffer.blocksFor("s1"))).toBe("ab");
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
});
