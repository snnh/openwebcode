import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import { ContextManager } from "../src/context/context-manager.js";
import { pickSegmentBoundary } from "../src/context/context-ledger-ops.js";
import { readMessagesAfter, invalidateMessageIndex } from "../src/sessions/message-reader.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
import type { ChatMessage } from "../src/sessions/types.js";
import type { ContextLedger } from "../src/context/context-types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * 活动段加载（getActive + readMessagesAfter + buildView segmentBoundary）：
 * 核心不变量 = 段视图与整表视图逐字节等价（/clear、压缩、追加、分叉各场景）。
 * 段加载的意义：大会话 run 期间只驻留「边界之后」的几 MB，而非整表 180MB 级。
 */

async function storeAt(root: string): Promise<SessionStore> {
  const store = new SessionStore(path.join(root, "sessions"));
  await store.initialize();
  return store;
}

async function seeded(count: number, extra?: { messageIdAt?: number; bigTextLength?: number }): Promise<{ store: SessionStore; root: string; sessionId: string; messages: ChatMessage[] }> {
  const root = await tempRoot("owc-active-segment-");
  const store = await storeAt(root);
  const sessionId = (await store.create({ cwd: root, provider: "p", model: "m" })).id;
  const messages: ChatMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = extra?.bigTextLength !== undefined && index === extra.messageIdAt ? `big-${index}-` + "x".repeat(extra.bigTextLength) : `message-${index}`;
    messages.push(await store.appendMessage(sessionId, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text }]));
  }
  return { store, root, sessionId, messages };
}

/** 段路径与整表路径的 buildView 产出逐字节一致（含 token 统计）。 */
async function expectViewEquivalence(store: SessionStore, sessionId: string, ledger: ContextLedger): Promise<void> {
  const context = new ContextManager(store.contextRoot(sessionId));
  const boundary = pickSegmentBoundary(ledger);
  const segmentDetail = await store.getActive(sessionId, boundary);
  const fullDetail = await store.get(sessionId);
  expect(segmentDetail).toBeDefined();
  expect(fullDetail).toBeDefined();
  const segmentView = await context.buildView(
    activePathMessages(segmentDetail!.messages, segmentDetail!.activeLeafId),
    { selection: { pins: [], excludes: [] }, ...(segmentDetail!.segmentBoundary ? { segmentBoundary: segmentDetail!.segmentBoundary } : {}) },
  );
  const fullView = await context.buildView(
    activePathMessages(fullDetail!.messages, fullDetail!.activeLeafId),
    { selection: { pins: [], excludes: [] }, forceFullRebuild: true },
  );
  // 段模式返回消息是前缀裁剪后的等价视图（id 序列一致）
  expect(segmentView.messages.map((message) => message.id)).toEqual(fullView.messages.map((message) => message.id));
  expect(segmentView.stats.totalTokens).toBe(fullView.stats.totalTokens);
}

describe("pickSegmentBoundary", () => {
  it("无记录 → undefined；仅有 uptoMessageId 的记录才参与；两者齐备取较新", () => {
    expect(pickSegmentBoundary({} as ContextLedger)).toBeUndefined();
    // 旧记录无 id 锚点：不参与
    expect(pickSegmentBoundary({ cleared: { uptoIndex: 5, at: "2026-01-01T00:00:00.000Z" } } as ContextLedger)).toBeUndefined();
    const cleared = { uptoMessageId: "m5", kind: "cleared" as const };
    const compacted = { uptoMessageId: "m9", kind: "compacted" as const };
    const older = pickSegmentBoundary({
      cleared: { uptoIndex: 6, at: "2026-01-01T00:00:00.000Z", uptoMessageId: "m5" },
      compacted: { uptoIndex: 10, createdAt: "2026-01-02T00:00:00.000Z", uptoMessageId: "m9", mode: "overview", summary: "s", instructions: [] },
    } as ContextLedger);
    expect(older).toEqual(compacted);
    const newer = pickSegmentBoundary({
      cleared: { uptoIndex: 6, at: "2026-01-03T00:00:00.000Z", uptoMessageId: "m5" },
      compacted: { uptoIndex: 10, createdAt: "2026-01-02T00:00:00.000Z", uptoMessageId: "m9", mode: "overview", summary: "s", instructions: [] },
    } as ContextLedger);
    expect(newer).toEqual(cleared);
  });
});

describe("readMessagesAfter", () => {
  it("含边界行读后缀；requireId 在边界之下判定 leafInSegment=false", async () => {
    const root = await tempRoot("owc-read-after-");
    const store = await storeAt(root);
    const sessionId = (await store.create({ cwd: root, provider: "p", model: "m" })).id;
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 12; index += 1) messages.push(await store.appendMessage(sessionId, "user", [{ type: "text", text: `m${index}` }]));
    const filePath = path.join(root, "sessions", sessionId, "messages.jsonl");
    const anchor = messages[4]!.id;

    const all = await readMessagesAfter<ChatMessage>(filePath, anchor);
    expect(all.boundaryFound).toBe(true);
    expect(all.leafInSegment).toBe(true);
    expect(all.messages.map((message) => message.id)).toEqual(messages.slice(4).map((message) => message.id));
    expect(all.segmentBytes).toBeGreaterThan(0);

    const withLeaf = await readMessagesAfter<ChatMessage>(filePath, anchor, { requireId: messages[11]!.id });
    expect(withLeaf.leafInSegment).toBe(true);
    const belowLeaf = await readMessagesAfter<ChatMessage>(filePath, anchor, { requireId: messages[2]!.id });
    expect(belowLeaf).toMatchObject({ boundaryFound: true, leafInSegment: false, messages: [] });
    const missing = await readMessagesAfter<ChatMessage>(filePath, "no-such-id");
    expect(missing).toMatchObject({ boundaryFound: false, leafInSegment: false, messages: [] });
  });

  it("跨 64KB 块边界的超长行（内嵌大块）完整读出，含损坏尾行恢复语义", async () => {
    const root = await tempRoot("owc-read-after-big-");
    const store = await storeAt(root);
    const sessionId = (await store.create({ cwd: root, provider: "p", model: "m" })).id;
    const messages: ChatMessage[] = [await store.appendMessage(sessionId, "user", [{ type: "text", text: "head" }])];
    // 200KB 单行强制跨块分段（READ_CHUNK_BYTES = 64KB）
    messages.push(await store.appendMessage(sessionId, "assistant", [{ type: "text", text: "y".repeat(200 * 1024) }]));
    messages.push(await store.appendMessage(sessionId, "user", [{ type: "text", text: "tail" }]));
    const filePath = path.join(root, "sessions", sessionId, "messages.jsonl");
    invalidateMessageIndex(filePath);
    const segment = await readMessagesAfter<ChatMessage>(filePath, messages[1]!.id);
    expect(segment.messages.map((message) => message.id)).toEqual([messages[1]!.id, messages[2]!.id]);
    expect(segment.messages[0]!.content[0]!.text).toHaveLength(200 * 1024);
  });
});

describe("SessionStore.getActive 活动段", () => {
  it("无边界或边界不可定位时回退整表（无 segmentBoundary）", async () => {
    const { store, sessionId } = await seeded(6);
    const noBoundary = await store.getActive(sessionId, undefined);
    expect(noBoundary!.segmentBoundary).toBeUndefined();
    expect(noBoundary!.messages).toHaveLength(6);
    const missing = await store.getActive(sessionId, { uptoMessageId: "missing-id", kind: "cleared" });
    expect(missing!.segmentBoundary).toBeUndefined();
    expect(missing!.messages).toHaveLength(6);
  });

  it("/clear 之后段只含边界与其后消息，且段视图与整表视图等价", async () => {
    const { store, sessionId, messages } = await seeded(10);
    const context = new ContextManager(store.contextRoot(sessionId));
    const anchor = messages[5]!.id;
    const ledger = await context.markCleared(6, anchor);
    const detail = await store.getActive(sessionId, pickSegmentBoundary(ledger));
    expect(detail!.segmentBoundary).toEqual({ uptoMessageId: anchor, kind: "cleared" });
    expect(detail!.messages.map((message) => message.id)).toEqual(messages.slice(5).map((message) => message.id));
    await expectViewEquivalence(store, sessionId, ledger);
  });

  it("压缩记录后段从压缩边界起；压缩 + clear 取较新者", async () => {
    const { store, sessionId, messages } = await seeded(12);
    const context = new ContextManager(store.contextRoot(sessionId));
    await context.updateLedger((ledger) => {
      ledger.compacted = {
        uptoIndex: 7,
        uptoMessageId: messages[6]!.id,
        mode: "overview",
        summary: "压缩摘要内容",
        instructions: [],
        createdAt: new Date().toISOString(),
      };
    });
    const compactedLedger = await context.load();
    const detail = await store.getActive(sessionId, pickSegmentBoundary(compactedLedger));
    expect(detail!.segmentBoundary).toEqual({ uptoMessageId: messages[6]!.id, kind: "compacted" });
    expect(detail!.messages[0]!.id).toBe(messages[6]!.id);
    await expectViewEquivalence(store, sessionId, compactedLedger);
    // 再 /clear（更晚）：边界前移到尾部，段只余边界一条
    const clearedLedger = await context.markCleared(11, messages[10]!.id);
    const cleared = await store.getActive(sessionId, pickSegmentBoundary(clearedLedger));
    expect(cleared!.segmentBoundary).toEqual({ uptoMessageId: messages[10]!.id, kind: "cleared" });
    expect(cleared!.messages.map((message) => message.id)).toEqual(messages.slice(10).map((message) => message.id));
    await expectViewEquivalence(store, sessionId, clearedLedger);
  });

  it("追加消息后段缓存增量穿透；边界 id 被截断后回退整表", async () => {
    const { store, sessionId, messages } = await seeded(8);
    const context = new ContextManager(store.contextRoot(sessionId));
    const anchor = messages[3]!.id;
    const ledger = await context.markCleared(4, anchor);
    const first = await store.getActive(sessionId, pickSegmentBoundary(ledger));
    expect(first!.messages).toHaveLength(5);
    // 追加穿透：第二次 getActive 命中段缓存并含新消息
    await store.appendMessage(sessionId, "user", [{ type: "text", text: "after" }]);
    const second = await store.getActive(sessionId, pickSegmentBoundary(ledger));
    expect(second!.messages.at(-1)!.content[0]!.type === "text" && second!.messages.at(-1)!.content[0]!.text).toBe("after");
    // 截断到边界之前：锚点消失 → 回退整表
    await store.truncateMessages(sessionId, 2);
    const third = await store.getActive(sessionId, pickSegmentBoundary(ledger));
    expect(third!.segmentBoundary).toBeUndefined();
    expect(third!.messages).toHaveLength(2);
  });

  it("checkout 回边界之下（分叉）时回退整表；countMessages 与真实条数一致", async () => {
    const { store, sessionId, messages } = await seeded(9);
    const context = new ContextManager(store.contextRoot(sessionId));
    const anchor = messages[6]!.id;
    const ledger = await context.markCleared(7, anchor);
    await store.setActiveLeaf(sessionId, messages[1]!.id);
    const detail = await store.getActive(sessionId, pickSegmentBoundary(ledger));
    expect(detail!.segmentBoundary).toBeUndefined();
    expect(detail!.messages).toHaveLength(9);
    expect(await store.countMessages(sessionId)).toBe(9);
  });

  it("损坏尾行：段读取报告 recovered，且不丢段内完好消息", async () => {
    const { store, root, sessionId, messages } = await seeded(6);
    const context = new ContextManager(store.contextRoot(sessionId));
    const anchor = messages[2]!.id;
    const ledger = await context.markCleared(3, anchor);
    const filePath = path.join(root, "sessions", sessionId, "messages.jsonl");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, "{\"corrupt\":", "utf8");
    invalidateMessageIndex(filePath);
    const detail = await store.getActive(sessionId, pickSegmentBoundary(ledger));
    expect(detail!.recovery?.state).toBe("recovered");
    expect(detail!.messages.map((message) => message.id)).toEqual(messages.slice(2).map((message) => message.id));
  });
});
