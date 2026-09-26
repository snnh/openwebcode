/**
 * dsh 助手流式增量（`assistant-stream`）回归。
 *  1. 形状：每一帧用 vendor `session/follow` result union 的 strict codec 解析（同一 union 内含
 *     `assistant-stream` 成员）；2. 折叠语义：按 vendor `ClientAssistantStream` 规则（revision 连续、
 *     index 密排、attempt 活跃期间 durable 记录挂起、end 帧才释放）证明「回复不会被挂住」。
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

/** 一轮典型流式回合：思考 → 正文 → 落盘 → 结算。 */
function runTurn(tracker: DshAssistantStreamTracker): { frames: DshAssistantStreamFrame[]; seq: number } {
  const frames: DshAssistantStreamFrame[] = [];
  const turnStep = { turn: 1, step: 1 };
  frames.push(...tracker.onDelta("reasoning", "先想", 1000, -1, turnStep));
  frames.push(...tracker.onDelta("reasoning", "一下", 1001, -1, turnStep));
  frames.push(...tracker.onDelta("text", "你好", 1002, -1, turnStep));
  frames.push(...tracker.onDelta("text", "，世界", 1003, -1, turnStep));
  frames.push(...tracker.onSettled(4));
  return { frames, seq: 4 };
}

type FoldEvent = { kind: "frame"; frame: DshAssistantStreamFrame } | { kind: "durable"; seq: number; turn: number; step: number };

/** vendor 折叠规则替身（`dsh-api-session-controller` 的 ClientAssistantStream，只保留可观测结果）。 */
function foldClient(events: readonly FoldEvent[]): { published: number[]; pending: number[]; error?: string } {
  let revision = 0;
  let attempt: { id: string; turn: number; step: number; nextIndex: number } | undefined;
  const pending = new Map<number, number>();
  const published: number[] = [];
  for (const event of events) {
    if (event.kind === "durable") {
      // acceptDurable：activeAttempt 与记录同 turn/step 则挂起，否则直接发布
      if (attempt !== undefined && attempt.turn === event.turn && attempt.step === event.step) pending.set(event.seq, event.seq);
      else published.push(event.seq);
      continue;
    }
    const { frame } = event.frame;
    const stale = frame.revision !== revision + 1;
    revision = frame.revision;
    if (stale) return { published, pending: [...pending.values()], error: `revision ${String(frame.revision)}` };
    if (frame.type === "start") {
      attempt = { id: String(frame.attemptId), turn: frame.turn, step: frame.step, nextIndex: 0 };
      continue;
    }
    if (attempt === undefined || attempt.id !== frame.attemptId) continue;
    const expected = attempt.nextIndex++;
    if (frame.index !== expected) continue; // rebaseline
    if (frame.type === "chunk") continue;
    const outcome = frame.outcome as { kind: string; eventType?: string; seq?: number };
    attempt = undefined;
    if (outcome.kind === "abandoned") continue;
    if (outcome.eventType !== "assistant/message" || !pending.has(outcome.seq ?? -1)) continue;
    pending.delete(outcome.seq as number);
    published.push(outcome.seq as number); // end(committed) 释放挂起记录 —— 消息这才显示
  }
  return { published, pending: [...pending.values()] };
}

describe("dsh 助手流式增量（帧语义）", () => {
  it("revision 每帧连续 +1；首个增量发 start、块切换补 block-start、落盘发 committed end（index 密排）", () => {
    const { frames, seq } = runTurn(new DshAssistantStreamTracker(() => "attempt-1"));
    expect(frames.map((frame) => frame.frame.revision)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.map((frame) => frame.frame.type)).toEqual(["start", "chunk", "chunk", "chunk", "chunk", "chunk", "chunk", "end"]);
    expect(frames[0]?.frame).toMatchObject({ attemptId: "attempt-1", startedAfterSeq: -1, turn: 1, step: 1 });
    const chunks = frames.filter((frame) => frame.frame.type === "chunk").map((frame) => frame.frame);
    expect(chunks.map((frame) => frame.index)).toEqual(chunks.map((_, index) => index)); // 块内密排 0..n
    expect(chunks.map((frame) => frame.chunk)).toEqual([
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "先想" },
      { type: "reasoning-delta", index: 0, text: "一下" },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "你好" },
      { type: "text-delta", index: 1, text: "，世界" },
    ]);
    expect(frames.at(-1)?.frame).toMatchObject({ attemptId: "attempt-1", index: 6, outcome: { kind: "committed", eventType: "assistant/message", seq } });
  });

  it("无 delta 的回合不发帧、中断回合 abandoned 收尾、空文本忽略、结算后新 attempt revision 继续递增", () => {
    const idle = new DshAssistantStreamTracker(() => "a");
    expect([idle.onSettled(3), idle.onAbandoned()]).toEqual([[], []]);
    const tracker = new DshAssistantStreamTracker(() => "b");
    expect(tracker.onDelta("text", "", 1, -1, { turn: 1, step: 1 })).toEqual([]); // 空文本增量被忽略
    expect(tracker.onDelta("text", "半句", 2, -1, { turn: 1, step: 1 }).map((frame) => frame.frame.type)).toEqual(["start", "chunk", "chunk"]);
    expect(tracker.onAbandoned().map((frame) => frame.frame)).toEqual([{ type: "end", attemptId: "b", revision: 4, index: 2, outcome: { kind: "abandoned" } }]);
    expect(tracker.onDelta("text", "下一轮", 3, 9, { turn: 2, step: 1 })[0]?.frame).toMatchObject({ type: "start", turn: 2, step: 1, startedAfterSeq: 9, revision: 5 });
  });

  it("折叠语义：落盘记录在 attempt 活跃期间挂起、被 end 帧释放；缺 end 帧则挂死；不匹配时直接发布", () => {
    const { frames, seq } = runTurn(new DshAssistantStreamTracker(() => "attempt-fold"));
    const head = frames.slice(0, -1).map((frame) => ({ kind: "frame" as const, frame }));
    const end = { kind: "frame" as const, frame: frames.at(-1) as DshAssistantStreamFrame };
    const durable = { kind: "durable" as const, seq, turn: 1, step: 1 };
    expect(foldClient([...head, durable, end])).toEqual({ published: [seq], pending: [] }); // 不挂死、不重复发布
    expect(foldClient([...head, durable])).toEqual({ published: [], pending: [seq] }); // 缺 end 帧 → 消息被挂住
    // 未流式（无 attempt）与 turn/step 不匹配（会话分叉/切换）时 durable 直接发布
    expect(foldClient([{ kind: "durable", seq, turn: 1, step: 1 }])).toEqual({ published: [seq], pending: [] });
    const other = new DshAssistantStreamTracker(() => "attempt-other").onDelta("text", "x", 1, -1, { turn: 7, step: 1 });
    expect(foldClient([...other.map((frame) => ({ kind: "frame" as const, frame })), { kind: "durable", seq: 9, turn: 1, step: 1 }]).published).toEqual([9]);
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("dsh 助手流式增量（vendor strict codec）", () => {
  it("每一帧都通过 vendor session/follow 的 strict codec，快照基线（不带 activeAttempt）同样通过", async () => {
    const follow = (await loadVendorEndpointDescriptors()).get("session/follow");
    expect(follow, "vendor 缺少 session/follow").toBeDefined();
    const parse = follow!.result.create().parse;
    const { frames } = runTurn(new DshAssistantStreamTracker(() => "attempt-codec"));
    for (const frame of frames) expect(() => parse(frame), `帧未通过 codec：${JSON.stringify(frame.frame).slice(0, 120)}`).not.toThrow();
    expect(() => parse({ type: "snapshot", header: { version: 1, id: "s1", createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })).not.toThrow();
  });
});
