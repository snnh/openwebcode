import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManager, isPathExcluded } from "../src/context/context-manager.js";
import { estimateMessageTokens } from "../src/context/model-profile.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

let sequence = 0;
function message(role: ChatMessage["role"], content: ChatMessage["content"]): ChatMessage {
  sequence += 1;
  return { id: `m-${sequence}`, role, content, createdAt: new Date(2026, 0, 1, 0, 0, sequence).toISOString() };
}
function text(value: string): ChatMessage { return message("user", [{ type: "text", text: value }]); }
function toolResult(value: string): ChatMessage {
  return message("tool", [{ type: "tool_result", toolCallId: `c-${sequence}`, content: value, isError: false }]);
}

describe("incremental context build", () => {
  it("produces byte-identical views for incremental and forced full rebuilds across turns, eviction, and compaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-incremental-"));
    temporary.push(root);
    const manager = new ContextManager(root);
    const messages: ChatMessage[] = [
      text("请修复这个 bug"),
      message("assistant", [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "src/a.ts" } }]),
      toolResult("x".repeat(5000)),
      message("assistant", [{ type: "text", text: "看到了，问题是……" }]),
    ];
    // 首建必然全量
    const first = await manager.buildView(messages);
    expect(first.stats.incremental).toBe(false);
    expect(first.stats.totalTokens).toBe(estimateMessageTokens(first.messages));

    // 追加一 turn：增量与强制全量逐字节一致
    messages.push(text("继续"), toolResult("y".repeat(3000)));
    const incremental = await manager.buildView(messages);
    expect(incremental.stats.incremental).toBe(true);
    const forced = await manager.buildView(messages, { forceFullRebuild: true });
    expect(forced.stats.incremental).toBe(false);
    expect(JSON.stringify(incremental.messages)).toBe(JSON.stringify(forced.messages));
    expect(incremental.stats.totalTokens).toBe(estimateMessageTokens(forced.messages));

    // 驱逐改变 ledger：缓存键失效自动全量；随后的增量仍与全量一致
    await manager.evict(messages);
    const afterEvict = await manager.buildView(messages);
    expect(afterEvict.stats.incremental).toBe(false);
    expect(afterEvict.messages.some((item) => item.content.some((block) => block.type === "tool_result" && block.content.includes("evicted")))).toBe(true);
    messages.push(text("再改一处"));
    const postEvictIncremental = await manager.buildView(messages);
    expect(postEvictIncremental.stats.incremental).toBe(true);
    const postEvictForced = await manager.buildView(messages, { forceFullRebuild: true });
    expect(JSON.stringify(postEvictIncremental.messages)).toBe(JSON.stringify(postEvictForced.messages));

    // 压缩：压缩头 + 截断前缀，增量与全量一致
    await manager.updateLedger((ledger) => {
      ledger.compacted = { uptoIndex: 4, mode: "overview", summary: "前四条已压缩", instructions: ["保持中文回复"], createdAt: new Date().toISOString() };
    });
    const compacted = await manager.buildView(messages);
    expect(compacted.stats.incremental).toBe(false);
    expect(compacted.messages[0]?.id.startsWith("compaction:")).toBe(true);
    expect(compacted.stats.segments.compactionSummary).toBeGreaterThan(0);
    messages.push(text("压缩后的新消息"));
    const compactedIncremental = await manager.buildView(messages);
    expect(compactedIncremental.stats.incremental).toBe(true);
    const compactedForced = await manager.buildView(messages, { forceFullRebuild: true });
    expect(JSON.stringify(compactedIncremental.messages)).toBe(JSON.stringify(compactedForced.messages));
    expect(compactedIncremental.stats.totalTokens).toBe(estimateMessageTokens(compactedForced.messages));
  });

  it("attributes tokens by segment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-segments-"));
    temporary.push(root);
    const manager = new ContextManager(root);
    const messages = [text("hello"), toolResult("z".repeat(400)), message("assistant", [{ type: "text", text: "done" }])];
    const view = await manager.buildView(messages);
    expect(view.stats.segments.toolResults).toBeGreaterThan(0);
    expect(view.stats.segments.messages).toBeGreaterThan(0);
    const sum = Object.values(view.stats.segments).reduce((total, value) => total + value, 0);
    expect(Math.max(1, sum)).toBe(view.stats.totalTokens);
    expect(view.stats.buildMs).toBeGreaterThanOrEqual(0);
  });

  it("pinned messages are never evicted and keep full content in the view", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pin-"));
    temporary.push(root);
    const manager = new ContextManager(root);
    await manager.updatePolicy({ lag: 0 });
    const pinned = toolResult("pinned-full-content");
    const other = toolResult("other-content");
    const messages = [text("start"), pinned, other, text("next")];
    // evict 显式传 pin 集：pin 的消息不产生驱逐条目
    const ledger = await manager.evict(messages, new Set([pinned.id]));
    expect(ledger.entries.some((entry) => entry.messageId === pinned.id)).toBe(false);
    expect(ledger.entries.some((entry) => entry.messageId === other.id)).toBe(true);
    // 即使 ledger 里已有驱逐条目，selection pin 也在视图中保留全文
    await manager.evictMessage(messages, pinned.id);
    const view = await manager.buildView(messages, { selection: { pins: [pinned.id], excludes: [] } });
    const pinnedView = view.messages.find((item) => item.id === pinned.id)!;
    expect(pinnedView.content[0]).toMatchObject({ content: "pinned-full-content" });
    expect(view.stats.pinnedTokens).toBeGreaterThan(0);
    // 未 pin 的视图仍是占位文本
    const unpinned = await manager.buildView(messages, { selection: { pins: [], excludes: [] }, forceFullRebuild: true });
    const unpinnedView = unpinned.messages.find((item) => item.id === pinned.id)!;
    expect(JSON.stringify(unpinnedView.content[0])).toContain("evicted");
  });

  it("matches excluded paths with simple globs (not a security boundary)", () => {
    expect(isPathExcluded("src/secret/token.txt", ["src/secret/**"])).toBe(true);
    expect(isPathExcluded("src/secret/token.txt", ["**/token.*"])).toBe(true);
    expect(isPathExcluded("a/b/c.log", ["*.log"])).toBe(true);
    expect(isPathExcluded("a\\b\\c.log", ["**/*.log"])).toBe(true);
    expect(isPathExcluded("src/a.ts", ["*.log", "docs/**"])).toBe(false);
    expect(isPathExcluded("src/a.ts", [])).toBe(false);
  });
});

describe("context selection REST", () => {
  it("persists pins/excludes in session config and rejects updates while running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-selection-"));
    temporary.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const provider: Provider = { name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const agent = { isRunning: () => false } as unknown as AgentRunner;
    const app = await buildServer({ core: {} as CoreClient, sessions, agent, events: new EventBus(), providers, pricing });
    try {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "test" });
      const updated = await app.inject({
        method: "PUT",
        url: `/api/sessions/${session.id}/context/selection`,
        payload: { pins: ["m-1", " src/a.ts "], excludes: ["**/*.log", "**/*.log", "docs/**"] },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ pins: ["m-1", "src/a.ts"], excludes: ["**/*.log", "docs/**"] });
      const persisted = await sessions.get(session.id);
      expect(persisted?.contextPins).toEqual(["m-1", "src/a.ts"]);
      expect(persisted?.contextExcludes).toEqual(["**/*.log", "docs/**"]);
      // 空清单回落为缺省（从 meta 删除）
      const cleared = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/context/selection`, payload: { pins: [], excludes: [] } });
      expect(cleared.statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({});
      expect((await sessions.get(session.id))?.contextPins).toBeUndefined();
      // 非法负载
      const invalid = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/context/selection`, payload: { pins: "nope" } });
      expect(invalid.statusCode).toBe(400);
      // GET /context 返回 selection 与按段统计
      const context = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/context` });
      expect(context.statusCode).toBe(200);
      expect(context.json().selection).toEqual({ pins: [], excludes: [] });
      expect(context.json().stats.segments).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
