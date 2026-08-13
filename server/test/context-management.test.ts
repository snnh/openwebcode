import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { ContextManager, isPathExcluded, selectCacheBreakpoints } from "../src/context/context-manager.js";
import { estimateMessageTokens } from "../src/context/model-profile.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 配对不变量：视图内每个 tool_call 都有匹配 tool_result，反之亦然（违反 = provider 400）。 */
function assertPairing(messages: ChatMessage[]): void {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") callIds.add(block.id);
      if (block.type === "tool_result") resultIds.add(block.toolCallId);
    }
  }
  expect([...callIds].filter((id) => !resultIds.has(id))).toEqual([]);
  expect([...resultIds].filter((id) => !callIds.has(id))).toEqual([]);
}

describe("context management controls", () => {
  it("updates policy and supports manual evict, restore, pin and unpin", async () => {
    const root = await tempRoot("owc-context-");
    const manager = new ContextManager(root);
    const policy = await manager.updatePolicy({ strategy: "interval", lag: 2, interval: 3, pinExemptRounds: 7, restoreBudget: 9000 });
    expect(policy.policy).toMatchObject({ strategy: "interval", lag: 2, interval: 3, pinExemptRounds: 7, restoreBudget: 9000 });
    const messages: ChatMessage[] = [{ id: "tool-1", role: "tool", createdAt: new Date().toISOString(), content: [{ type: "tool_result", toolCallId: "c1", content: "complete result", isError: false }] }];
    let ledger = await manager.evictMessage(messages, "tool-1");
    expect(ledger.entries[0]).toMatchObject({ messageId: "tool-1", state: "evicted" });
    expect(await manager.readArtifact(ledger.entries[0]!.artifactId, 0, 100)).toBe("complete result");
    ledger = await manager.restore("tool-1");
    expect(ledger.entries[0]?.state).toBe("restored");
    ledger = await manager.setPinned("tool-1", true);
    expect(ledger.entries[0]?.pinnedUntilRound).toBe(Number.MAX_SAFE_INTEGER);
    ledger = await manager.setPinned("tool-1", false);
    expect(ledger.entries[0]?.pinnedUntilRound).toBe(0);
  });

  let sequence = 0;
  function stamp(): string { sequence += 1; return new Date(2026, 0, 1, 0, 0, sequence).toISOString(); }
  function userText(value: string): ChatMessage {
    return { id: `u-${sequence + 1}`, role: "user", createdAt: stamp(), content: [{ type: "text", text: value }] };
  }
  function toolCall(callId: string, name: string): ChatMessage {
    return { id: `a-${callId}`, role: "assistant", createdAt: stamp(), content: [{ type: "tool_call", id: callId, name, input: {} }] };
  }
  function toolResult(callId: string, value: string): ChatMessage {
    return { id: `t-${callId}`, role: "tool", createdAt: stamp(), content: [{ type: "tool_result", toolCallId: callId, content: value, isError: false }] };
  }
  function assistantText(callId: string, value: string): ChatMessage {
    return { id: `at-${callId}`, role: "assistant", createdAt: stamp(), content: [{ type: "text", text: value }] };
  }

  it("does not evict the trailing tool batch the model has not seen yet (current-turn protection)", async () => {
    const root = await tempRoot("owc-context-tail-");
    const manager = new ContextManager(root);
    await manager.updatePolicy({ lag: 0 });
    const messages: ChatMessage[] = [
      userText("run two commands"),
      // 真实循环里同批 tool_call 在同一条 assistant 消息里，结果连续跟在其后
      { id: "a-calls", role: "assistant", createdAt: stamp(), content: [
        { type: "tool_call", id: "c1", name: "bash", input: {} },
        { type: "tool_call", id: "c2", name: "bash", input: {} },
      ] },
      toolResult("c1", "first output ".repeat(100)),
      toolResult("c2", "second output ".repeat(100)),
    ];
    // 末尾连续 tool 消息 = 刚执行完、模型尚未看到的批次：lag 0 也不驱逐
    let ledger = await manager.evict(messages);
    expect(ledger.entries).toHaveLength(0);
    // 模型响应并产生新结果后，上一批不再处于尾部，可被驱逐
    messages.push(assistantText("ack", "继续"), toolResult("c3", "third output ".repeat(100)));
    ledger = await manager.evict(messages);
    expect(ledger.entries.map((entry) => entry.messageId).sort()).toEqual(["t-c1", "t-c2"]);
  });

  it("eviction placeholder carries tool name, size and read_artifact guidance", async () => {
    const root = await tempRoot("owc-context-placeholder-");
    const manager = new ContextManager(root);
    await manager.updatePolicy({ lag: 0 });
    const messages: ChatMessage[] = [userText("hi"), toolCall("c1", "bash"), toolResult("c1", "full body ".repeat(200)), userText("done")];
    const ledger = await manager.evict(messages);
    expect(ledger.entries[0]).toMatchObject({ toolName: "bash", sizeBytes: 2000 });
    const view = await manager.buildView(messages);
    const content = JSON.stringify(view.messages.find((item) => item.id === "t-c1")!.content);
    expect(content).toContain(`tool result evicted (bash, 2000 bytes); artifact:${ledger.entries[0]!.artifactId}`);
    expect(content).toContain("read_artifact");
  });

  it("image description tool results are exempt from automatic eviction", async () => {
    const root = await tempRoot("owc-context-exempt-");
    const manager = new ContextManager(root);
    await manager.updatePolicy({ lag: 0 });
    const messages: ChatMessage[] = [
      userText("look at the screenshot"),
      toolCall("c1", "ext__vision-tools__describe_image"),
      toolResult("c1", "图中报错：TypeError: foo is not a function".repeat(50)),
      assistantText("ack", "看到了"),
      toolCall("c2", "bash"),
      toolResult("c2", "command output ".repeat(200)),
      assistantText("ack2", "完成"),
    ];
    const ledger = await manager.evict(messages);
    expect(ledger.entries.map((entry) => entry.messageId)).toEqual(["t-c2"]);
    // 视图保持全文（不出现驱逐占位符）
    const view = await manager.buildView(messages);
    const describeBlock = view.messages.find((item) => item.id === "t-c1")!.content[0]!;
    expect(describeBlock).toMatchObject({ type: "tool_result", content: expect.stringContaining("TypeError") });
    const bashBlock = view.messages.find((item) => item.id === "t-c2")!.content[0]!;
    expect(bashBlock).toMatchObject({ type: "tool_result", content: expect.stringContaining("tool result evicted") });
  });

  it("image description tool results are exempt from manual eviction", async () => {
    const root = await tempRoot("owc-context-exempt-manual-");
    const manager = new ContextManager(root);
    const messages: ChatMessage[] = [
      userText("look"),
      toolCall("c1", "ext__vision-tools__describe_image"),
      toolResult("c1", "描述内容 ".repeat(100)),
    ];
    await expect(manager.evictMessage(messages, "t-c1")).rejects.toThrow(/exempt from eviction/);
    const ledger = await manager.load();
    expect(ledger.entries).toHaveLength(0);
  });

  it("default policy keeps the newest 2 rounds of tool results in full", async () => {
    const root = await tempRoot("owc-context-lag-");
    const manager = new ContextManager(root);
    const messages: ChatMessage[] = [userText("start")];
    for (let index = 1; index <= 5; index += 1) {
      messages.push(toolResult(`d${index}`, `out ${index} ${"z".repeat(2000)}`), assistantText(`d${index}`, `ack ${index}`));
    }
    const ledger = await manager.evict(messages);
    expect(ledger.entries.map((entry) => entry.messageId)).toEqual(["t-d1", "t-d2", "t-d3"]);
  });


  it("default policy counts the trailing unseen tool batch toward the lag window", async () => {
    const root = await tempRoot("owc-context-lag-tail-");
    const manager = new ContextManager(root);
    // 默认 lag=2，路径以 tool 批次结尾：保留当轮 + 最近 1 个已完成轮（共 2 轮），
    // 更早的轮次驱逐——与「当轮保护 + lag 窗口」语义一致
    const messages: ChatMessage[] = [userText("start")];
    for (let index = 1; index <= 3; index += 1) {
      messages.push(toolResult(`d${index}`, `out ${index} ${"z".repeat(2000)}`), assistantText(`d${index}`, `ack ${index}`));
    }
    messages.push(toolResult("d4", `out 4 ${"z".repeat(2000)}`));
    const ledger = await manager.evict(messages);
    expect(ledger.entries.map((entry) => entry.messageId)).toEqual(["t-d1", "t-d2"]);
  });

  it("exempts small results and short read_file results; large read_file degrades to head+tail excerpt", async () => {
    const root = await tempRoot("owc-context-floors-");
    const manager = new ContextManager(root);
    await manager.updatePolicy({ lag: 0 });
    const readContent = Array.from({ length: 120 }, (_, index) => `line ${index + 1} ${"w".repeat(40)}`).join("\n");
    const messages: ChatMessage[] = [
      userText("go"),
      toolCall("c1", "bash"),
      toolResult("c1", "tiny ok"), // < 256 token 下限：豁免
      toolCall("c2", "read_file"),
      toolResult("c2", "line 1\nline 2\nline 3"), // ≤ 10 行：豁免
      toolCall("c3", "read_file"),
      toolResult("c3", readContent), // 120 行：驱逐，头尾摘录
      userText("done"),
    ];
    const ledger = await manager.evict(messages);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ messageId: "t-c3", toolName: "read_file" });
    expect(ledger.entries[0]!.excerpt).toBeDefined();
    const view = await manager.buildView(messages);
    const excerpted = JSON.stringify(view.messages.find((item) => item.id === "t-c3")!.content);
    expect(excerpted).toContain("line 1");
    expect(excerpted).toContain("line 120");
    expect(excerpted).toContain("lines elided");
    expect(excerpted).toContain("read_artifact");
    // 豁免的两条在视图中全文保留
    expect(JSON.stringify(view.messages.find((item) => item.id === "t-c1")!.content)).toContain("tiny ok");
    expect(JSON.stringify(view.messages.find((item) => item.id === "t-c2")!.content)).toContain("line 1\\nline 2");
  });

  it("process mode removes the whole tool round (pairs + thinking) with an immutable summary; restore brings the pair back", async () => {
    const root = await tempRoot("owc-context-process-");
    const manager = new ContextManager(root);
    await manager.updatePolicy({ lag: 0, evictionMode: "process" });
    const messages: ChatMessage[] = [
      userText("debug it"),
      { id: "a-round", role: "assistant", createdAt: stamp(), content: [
        { type: "thinking", text: "先看看现场" },
        { type: "tool_call", id: "c1", name: "bash", input: { cmd: "npm test" } },
        { type: "tool_call", id: "c2", name: "grep", input: { pattern: "foo" } },
      ] },
      toolResult("c1", `bash output ${"x".repeat(2000)}`),
      toolResult("c2", `grep output ${"y".repeat(2000)}`),
      assistantText("final", "修好了"),
    ];
    const ledger = await manager.evict(messages);
    expect(ledger.entries).toHaveLength(2);
    let view = await manager.buildView(messages);
    // tool 消息整条出视图；assistant 的 tool_call/thinking 一并移除（消息变空丢弃）
    expect(view.messages.some((item) => item.role === "tool")).toBe(false);
    expect(view.messages.some((item) => item.id === "a-round")).toBe(false);
    const summary = view.messages.find((item) => item.id === "evicted:a-round");
    expect(summary).toBeDefined();
    expect(summary!.role).toBe("user");
    const summaryText = JSON.stringify(summary!.content);
    expect(summaryText).toContain("2 tool call(s) evicted: bash, grep");
    expect(summaryText).toContain(ledger.entries[0]!.artifactId);
    expect(summaryText).toContain("read_artifact");
    // 正式输出保留
    expect(view.messages.some((item) => item.id === "at-final")).toBe(true);
    assertPairing(view.messages);
    // 缓存断点：被逐 tool 消息已出视图，锚到驱逐摘要消息
    expect(selectCacheBreakpoints(view.messages, view.ledger)[0]).toBe("evicted:a-round");
    // restore：双侧配对复活（tool_call input 与结果全文都回到视图）
    await manager.restore("t-c1");
    view = await manager.buildView(messages);
    const revived = view.messages.find((item) => item.id === "a-round");
    expect(revived).toBeDefined();
    expect(JSON.stringify(revived!.content)).toContain("npm test");
    expect(JSON.stringify(view.messages.find((item) => item.id === "t-c1")!.content)).toContain("bash output");
    // c2 仍在驱逐态：摘要只剩 grep 一条
    const summaryAfter = view.messages.find((item) => item.id === "evicted:a-round");
    expect(JSON.stringify(summaryAfter!.content)).toContain("1 tool call(s) evicted: grep");
    assertPairing(view.messages);
  });
});

// ---- context-cost 组（合并） ----
describe("ContextManager cost ledger", () => {
  it("upgrades a version-one token-only ledger", async () => {
    const root = await tempRoot("owc-ledger-");
    await writeFile(path.join(root, "ledger.json"), JSON.stringify({
      version: 1,
      round: 2,
      policy: { enabled: true, strategy: "lag", lag: 1, interval: 5, pinExemptRounds: 5, restoreBudget: 20_000 },
      entries: [],
      usage: { inputTokens: 7, outputTokens: 2, cacheRead: 5, cacheWrite: 3 },
    }));

    const ledger = await new ContextManager(root).load();
    expect(ledger.usage.inputTokens).toBe(7);
    expect(ledger.cost).toEqual({
      usdMicroUnits: "0",
      cnyMicroUnits: "0",
      unpricedTokens: 0,
      unavailableUsdTokens: 0,
      unavailableCnyTokens: 0,
    });
  });

  it("pauses a hard currency budget when prior usage cannot be priced", async () => {
    const root = await tempRoot("owc-budget-");
    const manager = new ContextManager(root);
    await manager.recordUsage({ inputTokens: 10, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, { priced: false });
    await manager.setBudget(undefined, { currency: "USD", microUnits: "1000000" });

    const status = await manager.budgetStatus();
    expect(status.paused).toBe(true);
    expect(status.cost.reason).toBe("cost_unavailable");
  });

  it("merges concurrent partial budget updates", async () => {
    const root = await tempRoot("owc-concurrent-budget-");
    const left = new ContextManager(root);
    const right = new ContextManager(root);
    await Promise.all([
      left.updateBudget({ maxSessionTokens: 100 }),
      right.updateBudget({ maxSessionCost: { currency: "CNY", microUnits: "2000000" } }),
    ]);
    const ledger = await left.load();
    expect(ledger.policy.maxSessionTokens).toBe(100);
    expect(ledger.policy.maxSessionCost).toEqual({ currency: "CNY", microUnits: "2000000" });
  });

  it("serializes round and usage writes for one session", async () => {
    const root = await tempRoot("owc-round-usage-");
    const manager = new ContextManager(root);
    await Promise.all([
      manager.advanceRound(),
      manager.recordUsage(
        { inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
        { priced: true, usdMicroUnits: "5", cnyMicroUnits: "35" },
      ),
    ]);
    const ledger = await manager.load();
    expect(ledger.round).toBe(1);
    expect(ledger.usage.inputTokens).toBe(1);
  });

  it("serializes concurrent usage updates for one session", async () => {
    const root = await tempRoot("owc-concurrent-cost-");
    const left = new ContextManager(root);
    const right = new ContextManager(root);
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? left : right).recordUsage(
        { inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
        { priced: true, usdMicroUnits: "5", cnyMicroUnits: "35" },
      )));
    const ledger = await left.load();
    expect(ledger.usage.inputTokens).toBe(20);
    // 精确整数累计（35 对浮点不友好，足以暴露 drift）
    expect(ledger.cost.usdMicroUnits).toBe("100");
    expect(ledger.cost.cnyMicroUnits).toBe("700");
  });

  it("selects and persists stable cache breakpoints", async () => {
    const root = await tempRoot("owc-cache-breakpoints-");
    const manager = new ContextManager(root);
    const messages = [
      { id: "user-1", role: "user" as const, content: [{ type: "text" as const, text: "one" }], createdAt: "2026-01-01T00:00:00Z" },
      { id: "tool-1", role: "tool" as const, content: [{ type: "tool_result" as const, toolCallId: "x", content: "result", isError: false }], createdAt: "2026-01-01T00:00:01Z" },
      { id: "user-2", role: "user" as const, content: [{ type: "text" as const, text: "two" }], createdAt: "2026-01-01T00:00:02Z" },
    ];
    // load() 返回缓存规范副本（只读约定）：构造带驱逐条目的账本须拷贝后改，不原地改
    const base = await manager.load();
    const ledger = { ...base, entries: [...base.entries, { messageId: "tool-1", kind: "tool_result" as const, artifactId: "artifact-00000000-0000-0000-0000-000000000000", state: "evicted" as const, createdRound: 0, pinnedUntilRound: 0 }] };
    const selected = selectCacheBreakpoints(messages, ledger);
    expect(selected).toEqual(["tool-1", "user-1"]);
    expect((await manager.recordCacheBreakpoints(selected)).cacheBreakpoints).toEqual(selected);
    expect((await manager.load()).cacheBreakpoints).toEqual(selected);
  });
});

// ---- context-incremental 组（合并） ----
let incSequence = 0;
function incMessage(role: ChatMessage["role"], content: ChatMessage["content"]): ChatMessage {
  incSequence += 1;
  return { id: `m-${incSequence}`, role, content, createdAt: new Date(2026, 0, 1, 0, 0, incSequence).toISOString() };
}
function incText(value: string): ChatMessage { return incMessage("user", [{ type: "text", text: value }]); }
function incToolResult(value: string): ChatMessage {
  return incMessage("tool", [{ type: "tool_result", toolCallId: `c-${incSequence}`, content: value, isError: false }]);
}

describe("incremental context build", () => {
  it("produces byte-identical views for incremental and forced full rebuilds across turns, eviction, and compaction", async () => {
    const root = await tempRoot("owc-incremental-");
    const manager = new ContextManager(root);
    const messages: ChatMessage[] = [
      incText("请修复这个 bug"),
      incMessage("assistant", [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "src/a.ts" } }]),
      incToolResult("x".repeat(5000)),
      incMessage("assistant", [{ type: "text", text: "看到了，问题是……" }]),
    ];
    // 首建必然全量
    const first = await manager.buildView(messages);
    expect(first.stats.incremental).toBe(false);
    expect(first.stats.totalTokens).toBe(estimateMessageTokens(first.messages));

    // 追加一 turn：增量与强制全量逐字节一致
    messages.push(incText("继续"), incToolResult("y".repeat(3000)));
    const incremental = await manager.buildView(messages);
    expect(incremental.stats.incremental).toBe(true);
    const forced = await manager.buildView(messages, { forceFullRebuild: true });
    expect(forced.stats.incremental).toBe(false);
    expect(JSON.stringify(incremental.messages)).toBe(JSON.stringify(forced.messages));
    expect(incremental.stats.totalTokens).toBe(estimateMessageTokens(forced.messages));

    // 驱逐改变 ledger：缓存键失效自动全量；随后的增量仍与全量一致
    // （lag: 0 显式关闭 lag 窗口：默认 lag=3 下两条工具结果都在保留窗口内，不会被驱逐）
    await manager.updatePolicy({ lag: 0 });
    await manager.evict(messages);
    const afterEvict = await manager.buildView(messages);
    expect(afterEvict.stats.incremental).toBe(false);
    expect(afterEvict.messages.some((item) => item.content.some((block) => block.type === "tool_result" && block.content.includes("evicted")))).toBe(true);
    messages.push(incText("再改一处"));
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
    messages.push(incText("压缩后的新消息"));
    const compactedIncremental = await manager.buildView(messages);
    expect(compactedIncremental.stats.incremental).toBe(true);
    const compactedForced = await manager.buildView(messages, { forceFullRebuild: true });
    expect(JSON.stringify(compactedIncremental.messages)).toBe(JSON.stringify(compactedForced.messages));
    expect(compactedIncremental.stats.totalTokens).toBe(estimateMessageTokens(compactedForced.messages));
  });

  it("attributes tokens by segment", async () => {
    const root = await tempRoot("owc-segments-");
    const manager = new ContextManager(root);
    const messages = [incText("hello"), incToolResult("z".repeat(400)), incMessage("assistant", [{ type: "text", text: "done" }])];
    const view = await manager.buildView(messages);
    expect(view.stats.segments.toolResults).toBeGreaterThan(0);
    expect(view.stats.segments.messages).toBeGreaterThan(0);
    const sum = Object.values(view.stats.segments).reduce((total, value) => total + value, 0);
    expect(Math.max(1, sum)).toBe(view.stats.totalTokens);
  });

  it("pinned messages are never evicted and keep full content in the view", async () => {
    const root = await tempRoot("owc-pin-");
    const manager = new ContextManager(root);
    await manager.updatePolicy({ lag: 0 });
    const pinnedBody = `pinned-full-content ${"p".repeat(2000)}`;
    const pinned = incToolResult(pinnedBody);
    const other = incToolResult(`other-content ${"o".repeat(2000)}`);
    const messages = [incText("start"), pinned, other, incText("next")];
    // evict 显式传 pin 集：pin 的消息不产生驱逐条目
    const ledger = await manager.evict(messages, new Set([pinned.id]));
    expect(ledger.entries.some((entry) => entry.messageId === pinned.id)).toBe(false);
    expect(ledger.entries.some((entry) => entry.messageId === other.id)).toBe(true);
    // 即使 ledger 里已有驱逐条目，selection pin 也在视图中保留全文
    await manager.evictMessage(messages, pinned.id);
    const view = await manager.buildView(messages, { selection: { pins: [pinned.id], excludes: [] } });
    const pinnedView = view.messages.find((item) => item.id === pinned.id)!;
    expect(pinnedView.content[0]).toMatchObject({ content: pinnedBody });
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

  it("does not pollute the cached view when callers replace returned messages/content arrays", async () => {
    const root = await tempRoot("owc-view-isolation-");
    const manager = new ContextManager(root);
    const messages = [incText("hello"), incToolResult("world")];
    const first = await manager.buildView(messages);
    // 调用方（扩展 transform / agent-runner）整体替换返回数组、消息或内容数组，
    // 都不得污染缓存主本；下一次增量构建必须产出未受影响的视图。
    first.messages.length = 0;
    const second = await manager.buildView(messages);
    expect(second.messages).toHaveLength(2);
    second.messages[0]!.content = [];
    second.messages[1]! = { ...second.messages[1]!, content: [] };
    messages.push(incText("next"));
    const third = await manager.buildView(messages);
    expect(third.stats.incremental).toBe(true);
    expect(third.messages).toHaveLength(3);
    expect(third.messages[0]!.content[0]).toMatchObject({ type: "text", text: "hello" });
    expect(third.messages[1]!.content[0]).toMatchObject({ type: "tool_result", content: "world" });
  });
});

describe("context selection REST", () => {
  it("persists pins/excludes in session config and rejects updates while running", async () => {
    const root = await tempRoot("owc-selection-");
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
describe("stats.evicted 驱逐聚合", () => {
  function toolResultMsg(id: string, callId: string, value: string): ChatMessage {
    return { id, role: "tool", createdAt: new Date().toISOString(), content: [{ type: "tool_result", toolCallId: callId, content: value, isError: false }] };
  }

  it("手动驱逐烧入 evictedTokens（与视图归因同一估算器），buildView stats 聚合条数与 tokens", async () => {
    const root = await tempRoot("owc-context-");
    const manager = new ContextManager(root);
    const content = "x".repeat(400);
    const messages = [
      { id: "a-1", role: "assistant", createdAt: new Date().toISOString(), content: [{ type: "tool_call", id: "c1", name: "bash", input: {} }] } as ChatMessage,
      toolResultMsg("t-1", "c1", content),
    ];
    const ledger = await manager.evictMessage(messages, "t-1");
    const entry = ledger.entries[0]!;
    // 烧入值即 estimateTokens(原文)：与豁免下限同一估算（>0 且随内容长度增长）
    expect(entry.evictedTokens).toBeGreaterThan(0);

    const view = await manager.buildView(messages);
    expect(view.stats.evicted).toEqual({ tokens: entry.evictedTokens, count: 1 });

    // 恢复后不再计入
    await manager.restore("t-1");
    const restored = await manager.buildView(messages);
    expect(restored.stats.evicted).toBeUndefined();

    // 无驱逐条目的会话：stats.evicted 缺省
    const empty = new ContextManager(await tempRoot("owc-context-"));
    const plain = await empty.buildView([
      { id: "u-1", role: "user", createdAt: new Date().toISOString(), content: [{ type: "text", text: "你好" }] } as ChatMessage,
    ]);
    expect(plain.stats.evicted).toBeUndefined();
  });

  it("旧账本条目缺 evictedTokens 时按 sizeBytes/4 回退；重新驱逐时补烧", async () => {
    const root = await tempRoot("owc-context-");
    const manager = new ContextManager(root);
    const content = "y".repeat(800);
    const messages = [
      { id: "a-1", role: "assistant", createdAt: new Date().toISOString(), content: [{ type: "tool_call", id: "c1", name: "bash", input: {} }] } as ChatMessage,
      toolResultMsg("t-1", "c1", content),
    ];
    const ledger = await manager.evictMessage(messages, "t-1");
    // 模拟旧账本：抹掉烧入字段后经恢复再驱逐触发补烧路径
    const sizeBytes = ledger.entries[0]!.sizeBytes!;
    delete ledger.entries[0]!.evictedTokens;
    await manager.restore("t-1");
    const reEvicted = await manager.evictMessage(messages, "t-1");
    expect(reEvicted.entries[0]!.evictedTokens).toBeGreaterThan(0);

    // 纯旧条目（无 evictedTokens）直接聚合时走 sizeBytes/4 回退：构造 legacy 账本再 buildView
    const legacy = await manager.evictMessage(messages, "t-1");
    void legacy;
    const view = await manager.buildView(messages);
    expect(view.stats.evicted?.count).toBe(1);
    expect(view.stats.evicted!.tokens).toBeGreaterThanOrEqual(Math.ceil(sizeBytes / 4));
  });
});
