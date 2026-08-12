import { afterEach, describe, expect, it } from "vitest";
import type { AppEvent, ChatMessage } from "../lib/contracts";
import type { ContextView } from "../lib/contracts";
import { deriveRestoredCompactions, mergeCompactionMarkers, compactionModeText, type CompactionMarker } from "../lib/compaction";
import { live, liveStore } from "../app/live-store";
import { buildRenderItems, insertCompactionMarkers, type RenderItem } from "../chat/message-groups";

function message(id: string, role: ChatMessage["role"], text = id): ChatMessage {
  return { id, role, createdAt: "2026-08-01T00:00:00.000Z", content: [{ type: "text", text }] } as ChatMessage;
}

function marker(overrides: Partial<CompactionMarker>): CompactionMarker {
  return {
    id: "compaction:2026-08-01T00:00:00.000Z",
    uptoIndex: 2,
    mode: "overview",
    forced: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "settled",
    ...overrides,
  };
}

function contextView(ledger: Partial<ContextView["ledger"]>): ContextView {
  return { ledger: { usage: {}, cost: {}, entries: [], ...ledger } } as unknown as ContextView;
}

afterEach(() => {
  liveStore.set({ subagents: {}, activities: {}, compactions: {} });
});

describe("deriveRestoredCompactions", () => {
  it("优先 compactionHistory 逐条还原，带摘要可展开", () => {
    const records = [
      { uptoIndex: 3, mode: "overview" as const, summary: "第一次", instructions: [], createdAt: "2026-08-01T00:00:00.000Z", replacedTokens: 1200 },
      { uptoIndex: 8, mode: "toolcalls" as const, summary: "第二次", instructions: ["用中文"], createdAt: "2026-08-02T00:00:00.000Z" },
    ];
    const markers = deriveRestoredCompactions(contextView({ compacted: records[1], compactionHistory: records }));
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ id: "compaction:2026-08-01T00:00:00.000Z", uptoIndex: 3, summary: "第一次", replacedTokens: 1200, status: "settled" });
    expect(markers[1]).toMatchObject({ uptoIndex: 8, mode: "toolcalls", instructions: ["用中文"] });
  });

  it("旧账本回退与空态：仅 compacted 单条回退还原；无账本数据返回空", () => {
    const record = { uptoIndex: 5, mode: "vault" as const, summary: "档案库", instructions: [], createdAt: "2026-08-01T00:00:00.000Z" };
    const markers = deriveRestoredCompactions(contextView({ compacted: record }));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ uptoIndex: 5, mode: "vault" });
    expect(deriveRestoredCompactions(undefined)).toEqual([]);
    expect(deriveRestoredCompactions(contextView({}))).toEqual([]);
  });

  it("clear 边界覆盖的过期记录不还原", () => {
    const records = [
      { uptoIndex: 3, mode: "overview" as const, summary: "旧", instructions: [], createdAt: "2026-08-01T00:00:00.000Z" },
      { uptoIndex: 9, mode: "overview" as const, summary: "新", instructions: [], createdAt: "2026-08-02T00:00:00.000Z" },
    ];
    const markers = deriveRestoredCompactions(contextView({ compactionHistory: records, cleared: { uptoIndex: 4, at: "2026-08-02T01:00:00.000Z" } }));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.summary).toBe("新");
  });

});

describe("mergeCompactionMarkers", () => {
  it("还原记录取代同 id 的实时沉降标记（还原版带摘要）；运行中沉底", () => {
    const restored = [marker({ summary: "摘要" })];
    const liveMarkers = [
      marker({ id: "compaction:2026-08-01T00:00:00.000Z" }),
      marker({ id: "compaction:live", uptoIndex: -1, status: "running", createdAt: "2026-08-03T00:00:00.000Z" }),
    ];
    const merged = mergeCompactionMarkers(liveMarkers, restored);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.summary).toBe("摘要");
    expect(merged[1]!.status).toBe("running");
  });

  it("保留未命中的实时标记并按时间升序", () => {
    const restored = [marker({ id: "compaction:a", createdAt: "2026-08-02T00:00:00.000Z" })];
    const liveMarkers = [marker({ id: "compaction:b", createdAt: "2026-08-01T00:00:00.000Z" })];
    const merged = mergeCompactionMarkers(liveMarkers, restored);
    expect(merged.map((item) => item.id)).toEqual(["compaction:b", "compaction:a"]);
  });
});

describe("insertCompactionMarkers", () => {
  const messages = [
    message("u1", "user"),
    message("a1", "assistant", ""), // 无正文 → 过程消息
    message("t1", "tool"),
    message("u2", "user"),
    message("a2", "assistant"),
  ];

  it("插入位在消息之前、折叠段外置、尾部追加", () => {
    const base = buildRenderItems(messages, { foldProcess: true });
    // a1/t1 是连续过程段 → 一个 fold [1,3)
    expect(base.map((item) => item.kind)).toEqual(["message", "fold", "message", "message"]);
    const items = insertCompactionMarkers(base, [
      { position: 0, marker: marker({ id: "c0" }) },
      { position: 2, marker: marker({ id: "c2" }) },
      { position: 5, marker: marker({ id: "c5" }) },
    ], messages.length);
    expect(items.map((item) => item.kind)).toEqual(["compaction", "message", "compaction", "fold", "message", "message", "compaction"]);
    expect((items[0] as { marker: CompactionMarker }).marker.id).toBe("c0");
    expect((items[2] as { marker: CompactionMarker }).marker.id).toBe("c2");
  });

  it("多个同位标记保持传入次序；空标记原样返回", () => {
    const base = buildRenderItems(messages, { foldProcess: true });
    const items = insertCompactionMarkers(base, [
      { position: 1, marker: marker({ id: "first" }) },
      { position: 1, marker: marker({ id: "second" }) },
    ], messages.length);
    const ids = items.filter((item): item is RenderItem & { kind: "compaction" } => item.kind === "compaction").map((item) => item.marker.id);
    expect(ids).toEqual(["first", "second"]);
    expect(insertCompactionMarkers(base, [], messages.length)).toBe(base);
  });
});

describe("live-store 压缩标记", () => {
  function event(type: string, payload: Record<string, unknown>): AppEvent {
    return { source: "agent", type, sessionId: "s1", payload } as AppEvent;
  }

  it("compacting → 运行中占位；compacted → 原位沉降（id 与账本一致）", () => {
    live.applyCompactionEvent(event("context.compacting", { mode: "overview", forced: true }));
    let list = liveStore.get().compactions["s1"]!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "compaction:live", status: "running", forced: true, uptoIndex: -1 });

    live.applyCompactionEvent(event("context.compacted", { mode: "overview", uptoIndex: 7, forced: true, createdAt: "2026-08-12T01:00:00.000Z" }));
    list = liveStore.get().compactions["s1"]!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "compaction:2026-08-12T01:00:00.000Z", status: "settled", uptoIndex: 7, forced: true });
  });

  it("compact_failed → 运行中占位转失败行；dismissCompaction 关闭", () => {
    live.applyCompactionEvent(event("context.compacting", { mode: "vault" }));
    live.applyCompactionEvent(event("context.compact_failed", { message: "快速模型超时" }));
    const list = liveStore.get().compactions["s1"]!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "failed", error: "快速模型超时", mode: "vault" });
    live.dismissCompaction("s1", list[0]!.id);
    expect(liveStore.get().compactions["s1"]).toEqual([]);
  });

  it("clearRunningCompaction 只清运行中占位，已沉降标记保留", () => {
    live.applyCompactionEvent(event("context.compacted", { mode: "overview", uptoIndex: 3, createdAt: "2026-08-12T01:00:00.000Z" }));
    live.applyCompactionEvent(event("context.compacting", { mode: "overview" }));
    live.clearRunningCompaction("s1");
    const list = liveStore.get().compactions["s1"]!;
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("settled");
  });

  it("无 running 时 compacted 也落沉降标记（POST 先于 WS 到达的竞态兜底）", () => {
    live.applyCompactionEvent(event("context.compacted", { mode: "toolcalls", uptoIndex: 4, createdAt: "2026-08-12T02:00:00.000Z" }));
    expect(liveStore.get().compactions["s1"]![0]).toMatchObject({ status: "settled", uptoIndex: 4 });
  });
});

describe("compactionModeText", () => {
  it("四种模式都有双语标签，未知值回落概览", () => {
    expect(compactionModeText("overview")).toEqual(["概览", "overview"]);
    expect(compactionModeText("toolcalls")).toEqual(["工具调用", "tool calls"]);
    expect(compactionModeText("vault")).toEqual(["档案库", "vault"]);
    expect(compactionModeText("truncated")).toEqual(["规则截断", "rule-based truncation"]);
    expect(compactionModeText("unknown")).toEqual(["概览", "overview"]);
  });
});
