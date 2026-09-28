import { afterEach, describe, expect, it } from "vitest";
import { resetSessionCacheIdleMinutes, setSessionCacheIdleMinutes } from "../src/cache-policy.js";
import { ContextManager } from "../src/context/context-manager.js";
import { normalizeLedger } from "../src/context/context-ledger-ops.js";
import type { LedgerCacheEntry, LedgerEntry, ViewBuildCache } from "../src/context/context-types.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * 静态缓存与逐出纪律是 private（不对外暴露 API）：这里按运行时引用读写，
 * 只在「种植权重 / 断言记账」处使用，行为断言仍走真实调用路径。
 */
interface CacheInternals {
  viewCaches: Map<string, ViewBuildCache>;
  ledgerCaches: Map<string, LedgerCacheEntry>;
  viewCacheBytes: number;
  ledgerCacheBytes: number;
  touchViewCache(sessionRoot: string, cache: ViewBuildCache): void;
  touchLedgerCache(sessionRoot: string, entry: LedgerCacheEntry): void;
}

const internals = ContextManager as unknown as CacheInternals;

// 静态缓存在进程内共享：每个用例后清空并复位字节计数与空闲 TTL，避免用例间互相串味。
afterEach(() => {
  internals.viewCaches.clear();
  internals.ledgerCaches.clear();
  internals.viewCacheBytes = 0;
  internals.ledgerCacheBytes = 0;
  resetSessionCacheIdleMinutes();
});

const userMessage = (id: string, text: string): ChatMessage => ({ id, role: "user", content: [{ type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z" });
const toolMessage = (id: string, text: string): ChatMessage => ({ id, role: "tool", content: [{ type: "tool_result", toolCallId: `call-${id}`, content: text, isError: false }], createdAt: "2026-01-01T00:00:01.000Z" });

/** 构造 fake 视图缓存条目（逐出只关心 weight/lastAccess，其余字段取最小合法形态）。 */
const fakeViewCache = (weight: number): ViewBuildCache => ({
  sourceIds: [], ledgerKey: "k", selectionKey: "s", fragments: [], entrySignatures: [],
  totalTokens: 0, segments: { system: 0, input: 0, toolCalls: 0, output: 0, other: 0 },
  pinnedTokens: 0, view: [], lastAccess: Date.now(), weight,
});

/**
 * 构造「重账本」条目：账本 weight = size*3 + entries.length*256，稀疏数组造 30 万条目
 * 即 76.8MB > 64MB 上限，无需真的分配 30 万个对象。
 */
const fakeLedgerEntry = (): LedgerCacheEntry => ({
  ledger: { ...normalizeLedger({}), entries: new Array<LedgerEntry>(300_000) },
  size: 0, mtimeMs: 0, ctimeMs: 0, ledgerKey: "k", lastAccess: Date.now(),
});

const ledgerEntry = (index: number, excerpt?: string): LedgerEntry => ({
  messageId: `m${String(index).padStart(5, "0")}`,
  kind: "tool_result",
  artifactId: `artifact-00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
  state: "evicted",
  createdRound: 1,
  pinnedUntilRound: 0,
  toolName: "read_file",
  sizeBytes: 100,
  ...(excerpt === undefined ? {} : { excerpt }),
});

describe("视图缓存字节预算", () => {
  it("写入时按 totalTokens*8 + sourceIds*512 记账，命中刷新 lastAccess", async () => {
    const root = await tempRoot("owc-context-weight-");
    const context = new ContextManager(root);
    const messages = [userMessage("u1", "问题"), toolMessage("t1", "x".repeat(4000))];
    const view = await context.buildView(messages);
    const cached = internals.viewCaches.get(root);
    expect(cached).toBeDefined();
    expect(cached!.weight).toBe(view.stats.totalTokens * 8 + messages.length * 512);
    expect(internals.viewCacheBytes).toBe(cached!.weight);

    // 命中即活跃：lastAccess 被刷新，权重不重复累加
    const stale = Date.now() - 60_000;
    cached!.lastAccess = stale;
    expect((await context.buildView(messages)).stats.incremental).toBe(true);
    expect(internals.viewCaches.get(root)!.lastAccess).toBeGreaterThan(stale);
    expect(internals.viewCacheBytes).toBe(cached!.weight);
  });

  it("累计字节超上限时逐出最旧，且至少保留最新一条", async () => {
    // 4 × 40MB = 160MB > 128MB：逐出最旧 1 条后剩 120MB，停在 3 条
    const roots = ["/cache/old", "/cache/mid", "/cache/new", "/cache/newest"];
    for (const root of roots) internals.touchViewCache(root, fakeViewCache(40 * 1024 * 1024));
    expect(internals.viewCaches.size).toBe(3);
    expect(internals.viewCaches.has("/cache/old")).toBe(false);
    expect(internals.viewCaches.has("/cache/newest")).toBe(true);
    expect(internals.viewCacheBytes).toBe(120 * 1024 * 1024);

    // 单条就超上限时不逐出自己：否则该会话每轮都要全量重建
    internals.viewCaches.clear();
    internals.viewCacheBytes = 0;
    internals.touchViewCache("/cache/huge", fakeViewCache(200 * 1024 * 1024));
    expect(internals.viewCaches.has("/cache/huge")).toBe(true);
    expect(internals.viewCacheBytes).toBe(200 * 1024 * 1024);
  });
});

describe("账本缓存字节预算", () => {
  it("累计字节超上限时逐出最旧账本缓存并同步扣减记账", () => {
    internals.touchLedgerCache("/cache/a", fakeLedgerEntry());
    // 76.8MB > 64MB 但只有一条：保留（最新一条优先生效）
    expect(internals.ledgerCaches.size).toBe(1);
    expect(internals.ledgerCacheBytes).toBe(300_000 * 256);

    internals.touchLedgerCache("/cache/b", fakeLedgerEntry());
    // 两条累计 153.6MB：逐出最旧的 a，保留最新 b
    expect(internals.ledgerCaches.has("/cache/a")).toBe(false);
    expect(internals.ledgerCaches.has("/cache/b")).toBe(true);
    expect(internals.ledgerCacheBytes).toBe(300_000 * 256);

    // 同 key 重触（loadLedger 命中/落盘提交）：先扣旧条目再记新条目，不重复累加
    internals.touchLedgerCache("/cache/b", fakeLedgerEntry());
    expect(internals.ledgerCaches.size).toBe(1);
    expect(internals.ledgerCacheBytes).toBe(300_000 * 256);
  });

  it("账本缓存命中刷新 lastAccess（命中即活跃，权重按文件指纹口径）", async () => {
    const root = await tempRoot("owc-context-ledger-hit-");
    const context = new ContextManager(root);
    await context.save(await context.load());
    const entry = internals.ledgerCaches.get(root)!;
    expect(internals.ledgerCacheBytes).toBe(entry.size * 3);

    const stale = Date.now() - 120_000;
    entry.lastAccess = stale;
    await context.load(); // 指纹命中 → 走缓存
    expect(internals.ledgerCaches.get(root)!.lastAccess).toBeGreaterThan(stale);
    expect(internals.ledgerCacheBytes).toBe(entry.size * 3);
  });
});

describe("空闲清扫（cache-policy 统一 TTL）", () => {
  it("按 sessionCacheIdleMinutes 释放视图与账本缓存，TTL 内与 TTL=0 均不逐出", async () => {
    setSessionCacheIdleMinutes(1);
    const root = await tempRoot("owc-context-idle-");
    const context = new ContextManager(root);
    const messages = [userMessage("u1", "问题"), toolMessage("t1", "y".repeat(100))];
    await context.buildView(messages);
    await context.save(await context.load());
    expect(internals.viewCaches.has(root)).toBe(true);
    expect(internals.ledgerCaches.has(root)).toBe(true);

    // TTL 内：活跃缓存不动
    expect(ContextManager.sweepIdleCaches(Date.now())).toBe(0);
    expect(internals.viewCaches.has(root)).toBe(true);
    expect(internals.ledgerCaches.has(root)).toBe(true);

    // 超过 TTL：视图 + 账本两条都释放，字节记账归零
    expect(ContextManager.sweepIdleCaches(Date.now() + 61_000)).toBe(2);
    expect(internals.viewCaches.has(root)).toBe(false);
    expect(internals.ledgerCaches.has(root)).toBe(false);
    expect(internals.viewCacheBytes).toBe(0);
    expect(internals.ledgerCacheBytes).toBe(0);
    // 缓存已释放：下一次构建必然全量重建（正确性不受影响）
    expect((await context.buildView(messages)).stats.incremental).toBe(false);

    // 0 = 不逐出：长跑场景保持常驻
    setSessionCacheIdleMinutes(0);
    expect(ContextManager.sweepIdleCaches(Date.now() + 24 * 60 * 60_000)).toBe(0);
    expect(internals.viewCaches.has(root)).toBe(true);
  });
});

describe("会话删除时释放静态缓存", () => {
  it("discardSession 只清掉目标 root 的视图与账本缓存，且记账精确归零", async () => {
    const rootA = await tempRoot("owc-context-discard-a-");
    const rootB = await tempRoot("owc-context-discard-b-");
    const a = new ContextManager(rootA);
    const b = new ContextManager(rootB);
    const messages = [userMessage("u1", "问题"), toolMessage("t1", "z".repeat(1000))];
    await a.buildView(messages);
    await b.buildView(messages);
    await a.save(await a.load());
    await b.save(await b.load());
    expect(internals.viewCaches.size).toBe(2);
    expect(internals.ledgerCaches.size).toBe(2);
    expect(internals.viewCacheBytes).toBeGreaterThan(0);
    expect(internals.ledgerCacheBytes).toBeGreaterThan(0);

    ContextManager.discardSession(rootA);
    expect(internals.viewCaches.has(rootA)).toBe(false);
    expect(internals.ledgerCaches.has(rootA)).toBe(false);
    // 另一个会话不受影响
    expect(internals.viewCaches.has(rootB)).toBe(true);
    expect(internals.ledgerCaches.has(rootB)).toBe(true);

    // 记账与 Map 同步：清完两个会话后计数必须精确归零（不会残留、不会变负）
    ContextManager.discardSession(rootB);
    expect(internals.viewCaches.size).toBe(0);
    expect(internals.ledgerCaches.size).toBe(0);
    expect(internals.viewCacheBytes).toBe(0);
    expect(internals.ledgerCacheBytes).toBe(0);

    // 未缓存的 root：no-op
    expect(() => ContextManager.discardSession("/cache/never-cached")).not.toThrow();
  });
});

describe("normalizeLedger 裁剪旧条目摘录", () => {
  it("带摘录条目 ≤2000 时返回原数组（热路径零分配）", () => {
    const entries = Array.from({ length: 2000 }, (_, index) => ledgerEntry(index, `excerpt-${index}`));
    // 夹杂无摘录条目不计入配额
    entries.push(...Array.from({ length: 50 }, (_, index) => ledgerEntry(9000 + index)));
    const normalized = normalizeLedger({ entries });
    expect(normalized.entries).toBe(entries); // 同一引用：未做任何拷贝/替换
    expect(normalized.entries.every((entry) => entry.excerpt === undefined || entry.excerpt.startsWith("excerpt-"))).toBe(true);
    expect(normalized.entries.filter((entry) => entry.excerpt !== undefined)).toHaveLength(2000);
  });

  it("带摘录条目 >2000 时只删更旧的摘录，条目本体与顺序保留", () => {
    const entries = Array.from({ length: 2500 }, (_, index) => ledgerEntry(index, `excerpt-${index}`));
    const ids = entries.map((entry) => entry.messageId);
    const normalized = normalizeLedger({ entries });

    expect(normalized.entries).toHaveLength(2500);
    expect(normalized.entries.map((entry) => entry.messageId)).toEqual(ids);
    // 最旧 500 条降级为占位符，最近 2000 条摘录原样
    expect(normalized.entries.slice(0, 500).every((entry) => entry.excerpt === undefined)).toBe(true);
    expect(normalized.entries[500]!.excerpt).toBe("excerpt-500");
    expect(normalized.entries[2499]!.excerpt).toBe("excerpt-2499");
    // 本体与统计字段（restore/UI 依赖）一个不少
    expect(normalized.entries[0]).toMatchObject({
      messageId: ids[0], kind: "tool_result", state: "evicted", createdRound: 1,
      pinnedUntilRound: 0, toolName: "read_file", sizeBytes: 100,
    });
    expect(normalized.entries[0]!.artifactId).toBe(entries[0]!.artifactId);
  });

  it("无摘录条目穿插不影响「最近 2000 条带摘录条目」的界定", () => {
    const entries: LedgerEntry[] = [];
    const plainEntries: Array<{ messageId: string; sizeBytes: number | undefined }> = [];
    for (let index = 0; index < 2100; index += 1) {
      entries.push(ledgerEntry(index, `excerpt-${index}`));
      if (index % 7 === 0) {
        const plain = ledgerEntry(50_000 + index);
        entries.push(plain);
        plainEntries.push({ messageId: plain.messageId, sizeBytes: plain.sizeBytes });
      }
    }
    expect(entries.filter((entry) => entry.excerpt !== undefined)).toHaveLength(2100);
    const normalized = normalizeLedger({ entries });

    expect(normalized.entries).toHaveLength(entries.length);
    // 100 条更旧的摘录被释放，其余 2000 条保留
    expect(normalized.entries.filter((entry) => entry.excerpt !== undefined)).toHaveLength(2000);
    expect(normalized.entries[0]!.excerpt).toBeUndefined();
    expect(normalized.entries.at(-1)!.excerpt).toBe("excerpt-2099");
    // 无摘录条目始终无摘录、本体字段原样
    const byId = new Map(normalized.entries.map((entry) => [entry.messageId, entry]));
    for (const plain of plainEntries) {
      expect(byId.get(plain.messageId)!.excerpt).toBeUndefined();
      expect(byId.get(plain.messageId)!.sizeBytes).toBe(plain.sizeBytes);
    }
  });
});
