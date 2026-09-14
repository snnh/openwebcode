import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

function userMessage(id: string, text: string): ChatMessage {
  return { id, role: "user", content: [{ type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z" };
}

function toolMessage(id: string, text: string): ChatMessage {
  return { id, role: "tool", content: [{ type: "tool_result", toolCallId: `call-${id}`, content: text }], createdAt: "2026-01-01T00:00:01.000Z" };
}

describe("buildView 片段级失效（驱逐条目变化不触发全量重建）", () => {
  it("新增驱逐条目后增量命中，且产出与全量重建逐字节一致", async () => {
    const root = await tempRoot("owc-partial-refresh-");
    const context = new ContextManager(root);
    const messages: ChatMessage[] = [
      userMessage("u1", "问题一"),
      toolMessage("t1", "x".repeat(2000)),
      userMessage("u2", "问题二"),
      toolMessage("t2", "y".repeat(2000)),
    ];

    const first = await context.buildView(messages);
    expect(first.stats.incremental).toBe(false);

    // 纯缓存命中
    const pureHit = await context.buildView(messages);
    expect(pureHit.stats.incremental).toBe(true);

    // 滚动驱逐：t1 的结果被逐出为 artifact（模拟 context-saver 每轮新增条目）
    await context.updateLedger((ledger) => {
      ledger.entries.push({
        messageId: "t1",
        kind: "tool_result",
        artifactId: "artifact-00000000-0000-0000-0000-000000000001",
        state: "evicted",
        createdRound: 1,
        pinnedUntilRound: 0,
        toolName: "bash",
        sizeBytes: 2000,
      });
    });

    const appended = [...messages, userMessage("u3", "问题三")];
    const partial = await context.buildView(appended);
    // 关键断言：条目变化不再令整表全量重建
    expect(partial.stats.incremental).toBe(true);
    // 驱逐占位已生效
    const evicted = partial.messages.find((message) => message.id === "t1")!;
    const block = evicted.content[0]!;
    expect(block.type).toBe("tool_result");
    expect(JSON.stringify(block)).toContain("artifact-00000000-0000-0000-0000-000000000001");
    // 追加消息在位
    expect(partial.messages.some((message) => message.id === "u3")).toBe(true);

    // 与全量重建逐字节一致（视图 + token 统计）
    const full = await context.buildView(appended, { forceFullRebuild: true });
    expect(full.stats.incremental).toBe(false);
    expect(JSON.stringify(partial.messages)).toBe(JSON.stringify(full.messages));
    expect(partial.stats.totalTokens).toBe(full.stats.totalTokens);
    expect(partial.stats.segments).toEqual(full.stats.segments);
    expect(partial.stats.pinnedTokens).toBe(full.stats.pinnedTokens);
  });

  it("驱逐条目恢复（restored）后片段还原，仍走增量路径", async () => {
    const root = await tempRoot("owc-partial-restore-");
    const context = new ContextManager(root);
    const messages: ChatMessage[] = [userMessage("u1", "q"), toolMessage("t1", "z".repeat(500))];
    await context.updateLedger((ledger) => {
      ledger.entries.push({
        messageId: "t1",
        kind: "tool_result",
        artifactId: "artifact-00000000-0000-0000-0000-000000000002",
        state: "evicted",
        createdRound: 1,
        pinnedUntilRound: 0,
      });
    });
    const evicted = await context.buildView(messages);
    expect(JSON.stringify(evicted.messages[1])).toContain("artifact-");

    await context.updateLedger((ledger) => {
      ledger.entries[0]!.state = "restored";
      ledger.entries[0]!.restoredAt = "2026-01-01T00:00:02.000Z";
    });
    const restored = await context.buildView(messages);
    expect(restored.stats.incremental).toBe(true);
    expect(JSON.stringify(restored.messages[1])).toContain("z".repeat(500));
    const full = await context.buildView(messages, { forceFullRebuild: true });
    expect(JSON.stringify(restored.messages)).toBe(JSON.stringify(full.messages));
  });
});
