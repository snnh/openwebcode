/**
 * dsh 助手流式增量（`assistant-stream`）回归。
 *
 * 两类断言：
 *  1. **形状**：每一帧都用 vendor `session/follow` result union 的 strict codec 解析（同一条 union
 *     里就含 `assistant-stream` 成员），形状不对直接失败；
 *  2. **折叠语义**：按 vendor `dsh-api-session-controller` 的 `ClientAssistantStream` 规则
 *     （revision 连续、index 密排、attempt 活跃期间 durable assistant/message 挂起、end 帧才释放）
 *     写一个测试替身，证明「start → chunks → durable → end」之后消息**确实被发布**——
 *     这正是「回复被挂住不显示」的回归点。折叠规则逐条抄自 vendor 源码（见文件内注释）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DshAssistantStreamTracker, type DshAssistantStreamFrame } from "../src/dsh/web-protocol/assistant-stream.js";
import { loadVendorEndpointDescriptors } from "./helpers/dsh-vendor-remotes.js";
import { VENDOR_READY } from "./helpers/dsh-vendor-wire.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REMOTES_BUNDLE = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins", "@deepseek-ai", "dsh-api-remotes", "client.js");
const VENDOR_SKIP = VENDOR_READY && existsSync(REMOTES_BUNDLE) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";

/** 一轮典型的流式回合：思考 → 正文 → 落盘 → 结算。 */
function runTurn(tracker: DshAssistantStreamTracker): { frames: DshAssistantStreamFrame[]; seq: number } {
  const frames: DshAssistantStreamFrame[] = [];
  const turnStep = { turn: 1, step: 1 };
  frames.push(...tracker.onDelta("reasoning", "先想", 1000, -1, turnStep));
  frames.push(...tracker.onDelta("reasoning", "一下", 1001, -1, turnStep));
  frames.push(...tracker.onDelta("text", "你好", 1002, -1, turnStep));
  frames.push(...tracker.onDelta("text", "，世界", 1003, -1, turnStep));
  const seq = 4;
  frames.push(...tracker.onSettled(seq));
  return { frames, seq };
}

describe("dsh 助手流式增量（帧语义）", () => {
  it("revision 每帧连续 +1（客户端逐帧校验，不连续即抛 carrier error）", () => {
    const { frames } = runTurn(new DshAssistantStreamTracker(() => "attempt-1"));
    expect(frames.map((frame) => frame.frame.revision)).toEqual(frames.map((_, index) => index + 1));
  });

  it("attempt 生命周期：首个增量发 start、块切换补 block-start、落盘发 committed end（index = 帧内密排序号）", () => {
    const { frames, seq } = runTurn(new DshAssistantStreamTracker(() => "attempt-1"));
    const kinds = frames.map((frame) => frame.frame.type);
    expect(kinds).toEqual(["start", "chunk", "chunk", "chunk", "chunk", "chunk", "chunk", "end"]);
    expect(frames[0]?.frame).toMatchObject({ attemptId: "attempt-1", startedAfterSeq: -1, turn: 1, step: 1 });
    // chunk.index 在 attempt 内密排 0..n
    const chunks = frames.filter((frame) => frame.frame.type === "chunk");
    expect(chunks.map((frame) => frame.frame.index)).toEqual(chunks.map((_, index) => index));
    // 思考在前、正文在后：各一块，块内 delta 指向同一块下标
    expect(chunks[0]?.frame.chunk).toEqual({ type: "block-start", index: 0, blockType: "reasoning" });
    expect(chunks[1]?.frame.chunk).toEqual({ type: "reasoning-delta", index: 0, text: "先想" });
    expect(chunks[2]?.frame.chunk).toEqual({ type: "reasoning-delta", index: 0, text: "一下" });
    expect(chunks[3]?.frame.chunk).toEqual({ type: "block-start", index: 1, blockType: "text" });
    expect(chunks[4]?.frame.chunk).toEqual({ type: "text-delta", index: 1, text: "你好" });
    expect(chunks[5]?.frame.chunk).toEqual({ type: "text-delta", index: 1, text: "，世界" });
    expect(frames.at(-1)?.frame).toMatchObject({
      attemptId: "attempt-1",
      index: 6,
      outcome: { kind: "committed", eventType: "assistant/message", seq },
    });
  });

  it("无 delta 的回合不发任何帧；中断回合以 abandoned 收尾；空文本增量被忽略", () => {
    const idle = new DshAssistantStreamTracker(() => "a");
    expect(idle.onSettled(3)).toEqual([]);
    expect(idle.onAbandoned()).toEqual([]);
    const tracker = new DshAssistantStreamTracker(() => "b");
    expect(tracker.onDelta("text", "", 1, -1, { turn: 1, step: 1 })).toEqual([]);
    // 首个增量：start + block-start + text-delta 三帧
    const frames = tracker.onDelta("text", "半句", 2, -1, { turn: 1, step: 1 });
    expect(frames.map((frame) => frame.frame.type)).toEqual(["start", "chunk", "chunk"]);
    const end = tracker.onAbandoned();
    expect(end.map((frame) => frame.frame)).toEqual([
      { type: "end", attemptId: "b", revision: 4, index: 2, outcome: { kind: "abandoned" } },
    ]);
    // 结算后再发增量会开启新的 attempt（attemptId 不同），revision 继续递增
    const next = tracker.onDelta("text", "下一轮", 3, 9, { turn: 2, step: 1 });
    expect(next[0]?.frame).toMatchObject({ type: "start", turn: 2, step: 1, startedAfterSeq: 9, revision: 5 });
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("dsh 助手流式增量（vendor strict codec）", () => {
  it("每一帧都通过 vendor session/follow 的 strict codec", async () => {
    const descriptors = await loadVendorEndpointDescriptors();
    const follow = descriptors.get("session/follow");
    expect(follow, "vendor 缺少 session/follow").toBeDefined();
    const parse = follow!.result.create().parse;
    const { frames } = runTurn(new DshAssistantStreamTracker(() => "attempt-codec"));
    for (const frame of frames) {
      expect(() => parse(frame), `帧未通过 codec：${JSON.stringify(frame.frame).slice(0, 120)}`).not.toThrow();
    }
    // 快照基线（v1 不带 activeAttempt）也要能通过同一 codec
    expect(() => parse({ type: "snapshot", header: { version: 1, id: "s1", createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })).not.toThrow();
  });

  /**
   * vendor 折叠规则测试替身（逐条对照 `dsh-api-session-controller` 的 `ClientAssistantStream`）：
   *   - 每帧 revision 必须 = 上一帧 + 1（否则 carrier error）；
   *   - chunk.index 必须 = attempt.nextIndex，否则 rebaseline；
   *   - attempt 活跃期间的 durable assistant/message 进 pending（**不发布**）；
   *   - end(committed) 要求 outcome.seq 命中 pending，命中即发布该记录（消息这才显示）；
   *   - attempt 未活跃时 durable 直接发布。
   */
  type FoldEvent =
    | { kind: "frame"; frame: DshAssistantStreamFrame }
    | { kind: "durable"; seq: number; turn: number; step: number };

  function foldClient(events: readonly FoldEvent[]): { published: number[]; rebaseline: number; pending: number[]; error?: string } {
    let revision = 0;
    let attempt: { id: string; turn: number; step: number; nextIndex: number } | undefined;
    const pending = new Map<number, { seq: number; turn: number; step: number }>();
    const published: number[] = [];
    let rebaseline = 0;
    for (const event of events) {
      if (event.kind === "durable") {
        // acceptDurable：activeAttempt 匹配（turn/step 相同且 seq > startedAfterSeq）则挂起
        const held = attempt !== undefined && attempt.turn === event.turn && attempt.step === event.step;
        if (held) pending.set(event.seq, { seq: event.seq, turn: event.turn, step: event.step });
        else published.push(event.seq);
        continue;
      }
      const { frame } = event.frame;
      const expected = revision + 1;
      if (frame.revision !== expected) return { published, rebaseline, pending: [...pending.keys()], error: `revision ${String(frame.revision)} != ${String(expected)}` };
      revision = frame.revision;
      if (frame.type === "start") {
        if (attempt !== undefined || pending.size > 0) { rebaseline += 1; continue; }
        attempt = { id: String(frame.attemptId), turn: Number(frame.turn), step: Number(frame.step), nextIndex: 0 };
        continue;
      }
      if (frame.type === "chunk") {
        if (attempt === undefined || attempt.id !== frame.attemptId) continue;
        if (frame.index !== attempt.nextIndex) { rebaseline += 1; continue; }
        attempt.nextIndex += 1;
        continue;
      }
      // end
      if (attempt === undefined || attempt.id !== frame.attemptId) continue;
      if (frame.index !== attempt.nextIndex) { rebaseline += 1; attempt = undefined; continue; }
      const outcome = frame.outcome as { kind: string; eventType?: string; seq?: number };
      attempt = undefined;
      if (outcome.kind === "abandoned") continue;
      const entry = pending.get(outcome.seq ?? -1);
      if (entry === undefined || outcome.eventType !== "assistant/message") { rebaseline += 1; continue; }
      pending.delete(entry.seq);
      published.push(entry.seq);
    }
    return { published, rebaseline, pending: [...pending.keys()] };
  }

  it("折叠语义：落盘记录在 attempt 活跃期间挂起、被 end 帧释放（不挂死、不重复发布）", () => {
    const { frames, seq } = runTurn(new DshAssistantStreamTracker(() => "attempt-fold"));
    const end = frames.at(-1)!;
    const head = frames.slice(0, -1);
    // 真实顺序：start/chunks → durable 记录 → end 帧（见 streams.ts 的增量循环）
    const folded = foldClient([
      ...head.map((frame) => ({ kind: "frame" as const, frame })),
      { kind: "durable" as const, seq, turn: 1, step: 1 },
      { kind: "frame" as const, frame: end },
    ]);
    expect(folded.error).toBeUndefined();
    expect(folded.rebaseline).toBe(0);
    expect(folded.pending).toEqual([]);   // 不挂死
    expect(folded.published).toEqual([seq]); // 恰好发布一次
  });

  it("折叠语义对照：缺 end 帧时消息被挂住（这正是必须联动发 end 的原因）", () => {
    const { frames, seq } = runTurn(new DshAssistantStreamTracker(() => "attempt-stuck"));
    const folded = foldClient([
      ...frames.slice(0, -1).map((frame) => ({ kind: "frame" as const, frame })),
      { kind: "durable" as const, seq, turn: 1, step: 1 },
    ]);
    expect(folded.published).toEqual([]);
    expect(folded.pending).toEqual([seq]);
  });

  it("折叠语义：未流式（无 attempt）时 durable 直接发布；turn/step 不匹配时不挂起", () => {
    const { seq } = runTurn(new DshAssistantStreamTracker(() => "attempt-none"));
    expect(foldClient([{ kind: "durable", seq, turn: 1, step: 1 }])).toEqual({ published: [seq], rebaseline: 0, pending: [] });
    // attempt 的 turn 与记录不同（例：会话被分叉/切换）→ 不挂起，直接发布（不会挂死）
    const frames = new DshAssistantStreamTracker(() => "attempt-other").onDelta("text", "x", 1, -1, { turn: 7, step: 1 });
    expect(foldClient([
      ...frames.map((frame) => ({ kind: "frame" as const, frame })),
      { kind: "durable" as const, seq: 9, turn: 1, step: 1 },
    ]).published).toEqual([9]);
  });
});
