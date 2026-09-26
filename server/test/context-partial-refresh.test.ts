import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

const userMessage = (id: string, text: string): ChatMessage => ({ id, role: "user", content: [{ type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z" });
const toolMessage = (id: string, text: string): ChatMessage => ({ id, role: "tool", content: [{ type: "tool_result", toolCallId: `call-${id}`, content: text, isError: false }], createdAt: "2026-01-01T00:00:01.000Z" });
const ARTIFACT = "artifact-00000000-0000-0000-0000-000000000001";

/** 追加一条驱逐条目（模拟 context-saver 每轮新增）。 */
const evict = (context: ContextManager, messageId: string, artifactId = ARTIFACT): Promise<unknown> =>
  context.updateLedger((ledger) => {
    ledger.entries.push({ messageId, kind: "tool_result", artifactId, state: "evicted", createdRound: 1, pinnedUntilRound: 0, toolName: "bash", sizeBytes: 2000 });
  });

const json = (value: unknown): string => JSON.stringify(value);
const fragmentOf = (view: { messages: ChatMessage[] }, id: string): string => json(view.messages.find((message) => message.id === id));

describe("buildView 片段级失效（驱逐条目变化不触发全量重建）", () => {
  it("新增驱逐条目后走增量路径，且产出与全量重建一致", async () => {
    const context = new ContextManager(await tempRoot("owc-partial-refresh-"));
    const messages: ChatMessage[] = [
      userMessage("u1", "问题一"),
      toolMessage("t1", "x".repeat(2000)),
      userMessage("u2", "问题二"),
      toolMessage("t2", "y".repeat(2000)),
    ];
    expect((await context.buildView(messages)).stats.incremental).toBe(false); // 首次全量
    expect((await context.buildView(messages)).stats.incremental).toBe(true); // 纯缓存命中

    await evict(context, "t1");
    const appended = [...messages, userMessage("u3", "问题三")];
    const partial = await context.buildView(appended);
    // 关键断言：条目变化不再令整表全量重建；驱逐占位已生效、追加消息在位
    expect(partial.stats.incremental).toBe(true);
    expect(fragmentOf(partial, "t1")).toContain(ARTIFACT);
    expect(partial.messages.some((message) => message.id === "u3")).toBe(true);

    // 与全量重建逐字节一致（视图 + token 统计）
    const full = await context.buildView(appended, { forceFullRebuild: true });
    expect(full.stats.incremental).toBe(false);
    expect(json(partial.messages)).toBe(json(full.messages));
    expect(partial.stats).toMatchObject({ totalTokens: full.stats.totalTokens, pinnedTokens: full.stats.pinnedTokens, segments: full.stats.segments });
  });

  it("驱逐条目恢复（restored）后片段还原，仍走增量路径", async () => {
    const context = new ContextManager(await tempRoot("owc-partial-restore-"));
    const messages = [userMessage("u1", "q"), toolMessage("t1", "z".repeat(500))];
    await evict(context, "t1", "artifact-00000000-0000-0000-0000-000000000002");
    expect(json((await context.buildView(messages)).messages[1])).toContain("artifact-");

    await context.updateLedger((ledger) => {
      ledger.entries[0]!.state = "restored";
      ledger.entries[0]!.restoredAt = "2026-01-01T00:00:02.000Z";
    });
    const restored = await context.buildView(messages);
    expect(restored.stats.incremental).toBe(true);
    expect(json(restored.messages[1])).toContain("z".repeat(500));
    expect(json(restored.messages)).toBe(json((await context.buildView(messages, { forceFullRebuild: true })).messages));
  });
});
