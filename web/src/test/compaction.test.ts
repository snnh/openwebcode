import { afterEach, describe, expect, it } from "vitest";
import type { AppEvent, ChatMessage, ContextView } from "../lib/contracts";
import { deriveRestoredCompactions, mergeCompactionMarkers, compactionModeText, type CompactionMarker } from "../lib/compaction";
import { live, liveStore } from "../app/live-store";
import { buildRenderItems, insertCompactionMarkers, type RenderItem } from "../chat/message-groups";
const message = (id: string, role: ChatMessage["role"], text = id): ChatMessage =>
  ({ id, role, createdAt: "2026-08-01T00:00:00.000Z", content: [{ type: "text", text }] });
const marker = (overrides: Partial<CompactionMarker>): CompactionMarker =>
  ({ id: "compaction:2026-08-01T00:00:00.000Z", uptoIndex: 2, mode: "overview", forced: false, createdAt: "2026-08-01T00:00:00.000Z", status: "settled", ...overrides });
const record = (uptoIndex: number, extra: Record<string, unknown> = {}) => ({ uptoIndex, mode: "overview" as const, summary: "", instructions: [], createdAt: "2026-08-01T00:00:00.000Z", ...extra });
const contextView = (ledger: Partial<ContextView["ledger"]>): ContextView => ({ ledger: { usage: {}, cost: {}, entries: [], ...ledger } }) as unknown as ContextView;
afterEach(() => { liveStore.set({ subagents: {}, activities: {}, compactions: {} }); });
describe("deriveRestoredCompactions", () => {
  it("优先 compactionHistory 逐条还原（带摘要/指令/替换量）；无账本或空账本返回空；clear 边界覆盖的过期记录不还原", () => {
    const records = [record(3, { summary: "第一次", replacedTokens: 1200 }), record(8, { mode: "toolcalls", summary: "第二次", instructions: ["用中文"] })];
    const markers = deriveRestoredCompactions(contextView({ compacted: records[1], compactionHistory: records }));
    expect(markers[0]).toMatchObject({ id: "compaction:2026-08-01T00:00:00.000Z", uptoIndex: 3, summary: "第一次", replacedTokens: 1200, status: "settled" });
    expect(markers[1]).toMatchObject({ uptoIndex: 8, mode: "toolcalls", instructions: ["用中文"] });
    expect(deriveRestoredCompactions(undefined)).toEqual([]); expect(deriveRestoredCompactions(contextView({}))).toEqual([]);
    const cleared = deriveRestoredCompactions(contextView({
      compactionHistory: [record(3, { summary: "旧" }), record(9, { summary: "新", createdAt: "2026-08-02T00:00:00.000Z" })],
      cleared: { uptoIndex: 4, at: "2026-08-02T01:00:00.000Z" },
    }));
    expect(cleared.map((item) => item.summary)).toEqual(["新"]);
  });
});
describe("mergeCompactionMarkers / insertCompactionMarkers", () => {
  it("还原记录取代同 id 的实时标记并保留未命中项，按时间升序（运行中沉底）；插入位在消息之前、折叠段外置、尾部追加，多个同位标记保持传入次序，空标记原样返回", () => {
    const merged = mergeCompactionMarkers([
      marker({ id: "compaction:2026-08-01T00:00:00.000Z" }),
      marker({ id: "compaction:live", uptoIndex: -1, status: "running", createdAt: "2026-08-03T00:00:00.000Z" }),
      marker({ id: "compaction:b", createdAt: "2026-07-01T00:00:00.000Z" }),
    ], [marker({ summary: "摘要" })]);
    expect(merged.map((item) => item.id)).toEqual(["compaction:b", "compaction:2026-08-01T00:00:00.000Z", "compaction:live"]);
    expect(merged[1]!.summary).toBe("摘要"); expect(merged[2]!.status).toBe("running");
    const messages = [message("u1", "user"), message("a1", "assistant", ""), message("t1", "tool"), message("u2", "user"), message("a2", "assistant")];
    const base = buildRenderItems(messages, { foldProcess: true });
    expect(base.map((item) => item.kind)).toEqual(["message", "fold", "message", "message"]);
    const items = insertCompactionMarkers(base, [
      { position: 0, marker: marker({ id: "c0" }) }, { position: 2, marker: marker({ id: "c2" }) }, { position: 5, marker: marker({ id: "c5" }) },
    ], messages.length);
    expect(items.map((item) => item.kind)).toEqual(["compaction", "message", "compaction", "fold", "message", "message", "compaction"]);
    const sameSpot = insertCompactionMarkers(base, [{ position: 1, marker: marker({ id: "first" }) }, { position: 1, marker: marker({ id: "second" }) }], messages.length);
    const ids = sameSpot.filter((item): item is RenderItem & { kind: "compaction" } => item.kind === "compaction").map((item) => item.marker.id);
    expect(ids).toEqual(["first", "second"]); expect(insertCompactionMarkers(base, [], messages.length)).toBe(base);
  });
});
describe("live-store 压缩标记", () => {
  const event = (type: string, payload: Record<string, unknown>): AppEvent => ({ source: "agent", type, sessionId: "s1", payload }) as AppEvent;
  it("compacting → 运行中占位；compacted → 原位沉降（id 与账本一致）；无 running 时也落沉降标记（POST 先于 WS 的竞态兜底）", () => {
    live.applyCompactionEvent(event("context.compacting", { mode: "overview", forced: true }));
    expect(liveStore.get().compactions.s1).toMatchObject([{ id: "compaction:live", status: "running", forced: true, uptoIndex: -1 }]);
    live.applyCompactionEvent(event("context.compacted", { mode: "overview", uptoIndex: 7, forced: true, createdAt: "2026-08-12T01:00:00.000Z" }));
    expect(liveStore.get().compactions.s1).toMatchObject([{ id: "compaction:2026-08-12T01:00:00.000Z", status: "settled", uptoIndex: 7, forced: true }]);
    liveStore.set({ compactions: {} });
    live.applyCompactionEvent(event("context.compacted", { mode: "toolcalls", uptoIndex: 4, createdAt: "2026-08-12T02:00:00.000Z" }));
    expect(liveStore.get().compactions.s1![0]).toMatchObject({ status: "settled", uptoIndex: 4 });
  });
  it("compact_failed 转失败行并可 dismiss；clearRunningCompaction 只清运行中占位；模式文案双语且未知回落概览", () => {
    live.applyCompactionEvent(event("context.compacting", { mode: "vault" }));
    live.applyCompactionEvent(event("context.compact_failed", { message: "快速模型超时" }));
    const failed = liveStore.get().compactions.s1!;
    expect(failed[0]).toMatchObject({ status: "failed", error: "快速模型超时", mode: "vault" });
    live.dismissCompaction("s1", failed[0]!.id); expect(liveStore.get().compactions.s1).toEqual([]);
    live.applyCompactionEvent(event("context.compacted", { mode: "overview", uptoIndex: 3, createdAt: "2026-08-12T01:00:00.000Z" }));
    live.applyCompactionEvent(event("context.compacting", { mode: "overview" })); live.clearRunningCompaction("s1");
    expect(liveStore.get().compactions.s1).toMatchObject([{ status: "settled" }]);
    expect(compactionModeText("overview")).toEqual(["概览", "overview"]); expect(compactionModeText("vault")).toEqual(["档案库", "vault"]);
    expect(compactionModeText("unknown")).toEqual(["概览", "overview"]);
  });
});
