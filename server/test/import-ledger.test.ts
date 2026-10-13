/**
 * `sessions.import` 的账本入参净化（{@link sanitizeImportLedger}）单测。
 *
 * 三条口径：超长 summary 截断（末尾带标注）、畸形 entries 逐条清洗 / 整体非法不落账本、
 * 正常账本原样透传（含 compactionHistory 封顶与核心字段不被改写）。
 */
import { describe, expect, it } from "vitest";
import {
  IMPORT_COMPACTION_HISTORY_LIMIT,
  IMPORT_ENTRIES_LIMIT,
  IMPORT_SUMMARY_MAX_LENGTH,
  sanitizeImportLedger,
} from "../src/extensions/import-ledger.js";

/** 一条合法的账本条目（核心 LedgerEntry 的必需字段）。 */
function entry(messageId: string): Record<string, unknown> {
  return {
    messageId,
    kind: "tool_result",
    artifactId: `artifact-${messageId}`,
    state: "evicted",
    createdRound: 1,
    pinnedUntilRound: 0,
    toolName: "read_file",
    sizeBytes: 1500,
    excerpt: "头几行",
  };
}

/** 压缩记录（核心 CompactionRecord 的必需字段）。 */
function compacted(summary: string): Record<string, unknown> {
  return {
    uptoIndex: 3,
    uptoMessageId: "m3",
    mode: "overview",
    summary,
    instructions: ["保留接口签名"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("sanitizeImportLedger：summary 截断", () => {
  it("超长 summary 截断到 100_000 并加 …(truncated)；未超长原样", () => {
    const long = "字".repeat(IMPORT_SUMMARY_MAX_LENGTH + 50);
    const ledger = sanitizeImportLedger({ compacted: compacted(long) });
    const summary = (ledger?.compacted as { summary: string }).summary;
    expect(summary.length).toBe(IMPORT_SUMMARY_MAX_LENGTH + "…(truncated)".length);
    expect(summary.endsWith("…(truncated)")).toBe(true);
    expect(summary.slice(0, IMPORT_SUMMARY_MAX_LENGTH)).toBe("字".repeat(IMPORT_SUMMARY_MAX_LENGTH));

    const short = sanitizeImportLedger({ compacted: compacted("摘要") });
    expect((short?.compacted as { summary: string }).summary).toBe("摘要");
    // instructions 只留字符串
    expect((short?.compacted as { instructions: unknown[] }).instructions).toEqual(["保留接口签名"]);
  });

  it("compacted 形状不成立（缺 mode/createdAt、summary 非字符串、uptoIndex 非法）→ 不写该字段", () => {
    expect(sanitizeImportLedger({ compacted: { uptoIndex: 1, summary: "摘要" } })?.compacted).toBeUndefined();
    expect(sanitizeImportLedger({ compacted: { uptoIndex: 1, mode: "overview", createdAt: "x", summary: 42 } })?.compacted).toBeUndefined();
    expect(sanitizeImportLedger({ compacted: { uptoIndex: -1, mode: "overview", createdAt: "x", summary: "s" } })?.compacted).toBeUndefined();
  });
});

describe("sanitizeImportLedger：entries 清洗", () => {
  it("逐条只保留白名单字段（其余键丢弃），畸形条目整条丢弃", () => {
    const ledger = sanitizeImportLedger({
      entries: [
        entry("m1"),
        { messageId: "no-state" },
        { state: "evicted" },
        { messageId: "bad-created", state: "evicted", createdRound: 1.5 },
        null,
        "字符串条目",
        { messageId: "m2", state: "restored", artifactId: 42 },
      ],
    });
    expect(ledger?.entries).toEqual([
      {
        messageId: "m1",
        state: "evicted",
        artifactId: "artifact-m1",
        createdRound: 1,
        pinnedUntilRound: 0,
      },
      // 只有一个字段非法时丢该字段，条目本身保留
      { messageId: "bad-created", state: "evicted" },
    ]);
  });

  it("createdRound/pinnedUntilRound 非法时丢该字段而不是整条；超上限取最近 2000 条", () => {
    const many = Array.from({ length: IMPORT_ENTRIES_LIMIT + 10 }, (_item, index) => entry(`m${index}`));
    const ledger = sanitizeImportLedger({ entries: many });
    expect(ledger?.entries).toHaveLength(IMPORT_ENTRIES_LIMIT);
    // 取最近的：最后一条是 m2009，第一条是 m10
    expect((ledger?.entries as Array<{ messageId: string }>)[0]!.messageId).toBe("m10");
    expect((ledger?.entries as Array<{ messageId: string }>).at(-1)!.messageId).toBe(`m${IMPORT_ENTRIES_LIMIT + 9}`);

    const dropped = sanitizeImportLedger({ entries: [{ messageId: "m1", state: "full", createdRound: -3, pinnedUntilRound: "x" }] });
    expect(dropped?.entries).toEqual([{ messageId: "m1", state: "full" }]);
  });

  it("entries 存在但非数组 → 整体非法（undefined，不落账本）；缺省 entries 视为不带条目", () => {
    expect(sanitizeImportLedger({ entries: "nope" })).toBeUndefined();
    expect(sanitizeImportLedger(null)).toBeUndefined();
    expect(sanitizeImportLedger("ledger")).toBeUndefined();
    // 缺 entries（导入路径只送 compacted）→ 仍返回账本：不能因为少 entries 把压缩记录丢掉
    const compactOnly = sanitizeImportLedger({ compacted: compacted("摘要") });
    expect(compactOnly?.compacted).toBeDefined();
    expect(compactOnly?.entries).toEqual([]);
  });
});

describe("sanitizeImportLedger：正常账本与其它字段", () => {
  it("正常账本原样（entries/round/policy/usage/cost/cacheBreakpoints/cleared 透传），未知顶层键丢弃", () => {
    const value = {
      version: 1,
      round: 7,
      policy: { enabled: true, lag: 10 },
      entries: [entry("m1")],
      usage: { inputTokens: 1, outputTokens: 2, cacheRead: 0, cacheWrite: 0 },
      cost: { usdMicroUnits: "0" },
      cacheBreakpoints: ["m1"],
      cleared: { uptoIndex: 2, at: "2026-01-01T00:00:00.000Z" },
      compacted: compacted("摘要"),
      compactionHistory: [compacted("旧摘要")],
      evil: { huge: "x".repeat(10) },
      __proto__: { polluted: true },
    };
    const ledger = sanitizeImportLedger(value);
    expect(ledger).toEqual({
      round: 7,
      policy: { enabled: true, lag: 10 },
      entries: [{ messageId: "m1", state: "evicted", artifactId: "artifact-m1", createdRound: 1, pinnedUntilRound: 0 }],
      usage: { inputTokens: 1, outputTokens: 2, cacheRead: 0, cacheWrite: 0 },
      cost: { usdMicroUnits: "0" },
      cacheBreakpoints: ["m1"],
      cleared: { uptoIndex: 2, at: "2026-01-01T00:00:00.000Z" },
      compacted: compacted("摘要"),
      compactionHistory: [compacted("旧摘要")],
    });
    expect("evil" in (ledger ?? {})).toBe(false);
    expect("version" in (ledger ?? {})).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("malformed compacted/compactionHistory 被丢弃，但仍保留同层的合法字段", () => {
    const ledger = sanitizeImportLedger({
      entries: [entry("m1")],
      compacted: { summary: "缺 mode" },
      compactionHistory: [compacted("合法"), { nonsense: true }],
      round: "7",
    });
    expect(ledger?.compacted).toBeUndefined();
    expect(ledger?.compactionHistory).toEqual([compacted("合法")]);
    expect(ledger?.round).toBeUndefined();
    expect(ledger?.entries).toHaveLength(1);
  });

  it("compactionHistory 超上限只留最近 20 条", () => {
    const history = Array.from({ length: IMPORT_COMPACTION_HISTORY_LIMIT + 5 }, (_item, index) => compacted(`摘要${index}`));
    const ledger = sanitizeImportLedger({ entries: [], compactionHistory: history });
    const kept = ledger?.compactionHistory as Array<{ summary: string }>;
    expect(kept).toHaveLength(IMPORT_COMPACTION_HISTORY_LIMIT);
    expect(kept[0]!.summary).toBe("摘要5");
    expect(kept.at(-1)!.summary).toBe(`摘要${IMPORT_COMPACTION_HISTORY_LIMIT + 4}`);
  });
});
