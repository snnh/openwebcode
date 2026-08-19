import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { ContextManager, isPathExcluded, selectCacheBreakpoints } from "../src/context/context-manager.js";
import { estimateMessageTokens } from "../src/context/model-profile.js";
import { evictContext, evictMessage, restoreContextEntry, setContextEntryPinned, updateEvictionPolicy } from "../src/extensions/context-saver/index.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
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
    const policy = await updateEvictionPolicy(manager, { strategy: "interval", lag: 2, interval: 3, pinExemptRounds: 7, restoreBudget: 9000 });
    expect(policy.policy).toMatchObject({ strategy: "interval", lag: 2, interval: 3, pinExemptRounds: 7, restoreBudget: 9000 });
    const messages: ChatMessage[] = [{ id: "tool-1", role: "tool", createdAt: new Date().toISOString(), content: [{ type: "tool_result", toolCallId: "c1", content: "complete result", isError: false }] }];
    let ledger = await evictMessage(manager, root, messages, "tool-1");
    expect(ledger.entries[0]).toMatchObject({ messageId: "tool-1", state: "evicted" });
    expect(await manager.readArtifact(ledger.entries[0]!.artifactId, 0, 100)).toBe("complete result");
    ledger = await restoreContextEntry(manager, root, "tool-1");
    expect(ledger.entries[0]?.state).toBe("restored");
    ledger = await setContextEntryPinned(manager, "tool-1", true);
    expect(ledger.entries[0]?.pinnedUntilRound).toBe(Number.MAX_SAFE_INTEGER);
    ledger = await setContextEntryPinned(manager, "tool-1", false);
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
    await updateEvictionPolicy(manager, { lag: 0 });
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
    let ledger = await evictContext(manager, root, messages);
    expect(ledger.entries).toHaveLength(0);
    // 模型响应并产生新结果后，上一批不再处于尾部，可被驱逐
    messages.push(assistantText("ack", "继续"), toolResult("c3", "third output ".repeat(100)));
    ledger = await evictContext(manager, root, messages);
    expect(ledger.entries.map((entry) => entry.messageId).sort()).toEqual(["t-c1", "t-c2"]);
  });

  it("eviction placeholder carries tool name, size and read_artifact guidance", async () => {
    const root = await tempRoot("owc-context-placeholder-");
    const manager = new ContextManager(root);
    await updateEvictionPolicy(manager, { lag: 0 });
    const messages: ChatMessage[] = [userText("hi"), toolCall("c1", "bash"), toolResult("c1", "full body ".repeat(200)), userText("done")];
    const ledger = await evictContext(manager, root, messages);
    expect(ledger.entries[0]).toMatchObject({ toolName: "bash", sizeBytes: 2000 });
    const view = await manager.buildView(messages);
    const content = JSON.stringify(view.messages.find((item) => item.id === "t-c1")!.content);
    expect(content).toContain(`tool result evicted (bash, 2000 bytes); artifact:${ledger.entries[0]!.artifactId}`);
    expect(content).toContain("read_artifact");
  });

  it("image description tool results are exempt from automatic eviction", async () => {
    const root = await tempRoot("owc-context-exempt-");
    const manager = new ContextManager(root);
    await updateEvictionPolicy(manager, { lag: 0 });
    const messages: ChatMessage[] = [
      userText("look at the screenshot"),
      toolCall("c1", "ext__vision-tools__describe_image"),
      toolResult("c1", "图中报错：TypeError: foo is not a function".repeat(50)),
      assistantText("ack", "看到了"),
      toolCall("c2", "bash"),
      toolResult("c2", "command output ".repeat(200)),
      assistantText("ack2", "完成"),
    ];
    const ledger = await evictContext(manager, root, messages);
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
    await expect(evictMessage(manager, root, messages, "t-c1")).rejects.toThrow(/exempt from eviction/);
    const ledger = await manager.load();
    expect(ledger.entries).toHaveLength(0);
  });

  it("default policy keeps the newest 10 rounds of tool results in full", async () => {
    const root = await tempRoot("owc-context-lag-");
    const manager = new ContextManager(root);
    const messages: ChatMessage[] = [userText("start")];
    for (let index = 1; index <= 12; index += 1) {
      messages.push(toolResult(`d${index}`, `out ${index} ${"z".repeat(2000)}`), assistantText(`d${index}`, `ack ${index}`));
    }
    const ledger = await evictContext(manager, root, messages);
    expect(ledger.entries.map((entry) => entry.messageId)).toEqual(["t-d1", "t-d2"]);
  });


  it("default policy counts the trailing unseen tool batch toward the lag window", async () => {
    const root = await tempRoot("owc-context-lag-tail-");
    const manager = new ContextManager(root);
    // 默认 lag=10，路径以 tool 批次结尾：保留当轮 + 最近 9 个已完成轮（共 10 轮），
    // 更早的轮次驱逐——与「当轮保护 + lag 窗口」语义一致
    const messages: ChatMessage[] = [userText("start")];
    for (let index = 1; index <= 10; index += 1) {
      messages.push(toolResult(`d${index}`, `out ${index} ${"z".repeat(2000)}`), assistantText(`d${index}`, `ack ${index}`));
    }
    messages.push(toolResult("d11", `out 11 ${"z".repeat(2000)}`));
    const ledger = await evictContext(manager, root, messages);
    expect(ledger.entries.map((entry) => entry.messageId)).toEqual(["t-d1"]);
  });

  it("exempts small results and short read_file results; large read_file degrades to head+tail excerpt", async () => {
    const root = await tempRoot("owc-context-floors-");
    const manager = new ContextManager(root);
    await updateEvictionPolicy(manager, { lag: 0 });
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
    const ledger = await evictContext(manager, root, messages);
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
    await updateEvictionPolicy(manager, { lag: 0, evictionMode: "process" });
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
    const ledger = await evictContext(manager, root, messages);
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
    await restoreContextEntry(manager, root, "t-c1");
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
    const manager = new ContextManager(await tempRoot("owc-budget-"));
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
    const manager = new ContextManager(await tempRoot("owc-round-usage-"));
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
    const manager = new ContextManager(await tempRoot("owc-cache-breakpoints-"));
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
    // （lag: 0 显式关闭 lag 窗口：默认 lag=10 下两条工具结果都在保留窗口内，不会被驱逐）
    await updateEvictionPolicy(manager, { lag: 0 });
    await evictContext(manager, root, messages);
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
    expect(compacted.stats.segments.other).toBeGreaterThan(0);
    messages.push(incText("压缩后的新消息"));
    const compactedIncremental = await manager.buildView(messages);
    expect(compactedIncremental.stats.incremental).toBe(true);
    const compactedForced = await manager.buildView(messages, { forceFullRebuild: true });
    expect(JSON.stringify(compactedIncremental.messages)).toBe(JSON.stringify(compactedForced.messages));
    expect(compactedIncremental.stats.totalTokens).toBe(estimateMessageTokens(compactedForced.messages));
  });

  it("attributes tokens by segment", async () => {
    const manager = new ContextManager(await tempRoot("owc-segments-"));
    const messages = [incText("hello"), incToolResult("z".repeat(400)), incMessage("assistant", [{ type: "text", text: "done" }])];
    const view = await manager.buildView(messages);
    expect(view.stats.segments.toolCalls).toBeGreaterThan(0);
    expect(view.stats.segments.input).toBeGreaterThan(0);
    expect(view.stats.segments.output).toBeGreaterThan(0);
    const sum = Object.values(view.stats.segments).reduce((total, value) => total + value, 0);
    expect(Math.max(1, sum)).toBe(view.stats.totalTokens);
  });

  it("pinned messages are never evicted and keep full content in the view", async () => {
    const root = await tempRoot("owc-pin-");
    const manager = new ContextManager(root);
    await updateEvictionPolicy(manager, { lag: 0 });
    const pinnedBody = `pinned-full-content ${"p".repeat(2000)}`;
    const pinned = incToolResult(pinnedBody);
    const other = incToolResult(`other-content ${"o".repeat(2000)}`);
    const messages = [incText("start"), pinned, other, incText("next")];
    // evict 显式传 pin 集：pin 的消息不产生驱逐条目
    const ledger = await evictContext(manager, root, messages, new Set([pinned.id]));
    expect(ledger.entries.some((entry) => entry.messageId === pinned.id)).toBe(false);
    expect(ledger.entries.some((entry) => entry.messageId === other.id)).toBe(true);
    // 即使 ledger 里已有驱逐条目，selection pin 也在视图中保留全文
    await evictMessage(manager, root, messages, pinned.id);
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
    const manager = new ContextManager(await tempRoot("owc-view-isolation-"));
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
    const ledger = await evictMessage(manager, root, messages, "t-1");
    const entry = ledger.entries[0]!;
    // 烧入值即 estimateTokens(原文)：与豁免下限同一估算（>0 且随内容长度增长）
    expect(entry.evictedTokens).toBeGreaterThan(0);

    const view = await manager.buildView(messages);
    expect(view.stats.evicted).toEqual({ tokens: entry.evictedTokens, count: 1 });

    // 恢复后不再计入
    await restoreContextEntry(manager, root, "t-1");
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
    const ledger = await evictMessage(manager, root, messages, "t-1");
    // 模拟旧账本：抹掉烧入字段后经恢复再驱逐触发补烧路径
    const sizeBytes = ledger.entries[0]!.sizeBytes!;
    delete ledger.entries[0]!.evictedTokens;
    await restoreContextEntry(manager, root, "t-1");
    const reEvicted = await evictMessage(manager, root, messages, "t-1");
    expect(reEvicted.entries[0]!.evictedTokens).toBeGreaterThan(0);

    // 纯旧条目（无 evictedTokens）直接聚合时走 sizeBytes/4 回退：
    // evictMessage 返回的正是缓存主本，抹掉烧入字段即模拟 legacy 账本再 buildView
    delete reEvicted.entries[0]!.evictedTokens;
    const view = await manager.buildView(messages);
    expect(view.stats.evicted?.count).toBe(1);
    expect(view.stats.evicted!.tokens).toBeGreaterThanOrEqual(Math.ceil(sizeBytes / 4));
  });
});

// ---- context-saver 扩展 REST 门控 ----
describe("context-saver REST gating", () => {
  it("扩展被禁用时五个 saver 端点一律 409；宿主缺省 extensions 时不门控", async () => {
    const root = await tempRoot("owc-saver-gating-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const provider: Provider = { name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const extensions = new ExtensionManager(path.join(root, "data"), events, { sessions });
    await extensions.initialize();
    await extensions.configure("context-saver", { enabled: false });
    expect(extensions.isEnabled("context-saver")).toBe(false);
    const agent = { isRunning: () => false } as unknown as AgentRunner;
    const app = await buildServer({ core: {} as CoreClient, sessions, agent, events, providers, pricing, extensions });
    try {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "test" });
      const cases = [
        { method: "PUT", url: `/api/sessions/${session.id}/context/policy`, payload: { lag: 2 } },
        { method: "PUT", url: `/api/sessions/${session.id}/context/selection`, payload: { pins: ["m-1"], excludes: [] } },
        { method: "POST", url: `/api/sessions/${session.id}/context/restore`, payload: { messageId: "m-1" } },
        { method: "POST", url: `/api/sessions/${session.id}/context/entries/m-1`, payload: { action: "pin" } },
        { method: "GET", url: `/api/sessions/${session.id}/context/artifacts/artifact-1` },
      ] as const;
      for (const gated of cases) {
        const response = await app.inject(gated);
        expect(response.statusCode, `${gated.method} ${gated.url}`).toBe(409);
        expect(response.json().error).toContain("context-saver extension is disabled");
      }
      // 扩展重新开启后门控解除（policy 更新恢复可用）
      await extensions.configure("context-saver", { enabled: true });
      const policy = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/context/policy`, payload: { lag: 2 } });
      expect(policy.statusCode).toBe(200);
    } finally {
      await app.close();
      await extensions.close();
    }
  });
});

// ---- clear 组（合并） ----
const clearApps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => Promise.all(clearApps.splice(0).map((app) => app.close())));

async function clearManager(): Promise<ContextManager> {
  return new ContextManager(await tempRoot("owc-clear-"));
}

async function clearApp(rootPrefix = "owc-clear-http-") {
  const root = await tempRoot(rootPrefix);
  const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus(); const observed: AppEvent[] = [];
  events.on("event", (event: AppEvent) => observed.push(event));
  const core = { on() { return core; } } as unknown as CoreClient;
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  clearApps.push(app);
  return { root, sessions, agent, app, observed };
}

function clearMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    createdAt: new Date(index * 1000).toISOString(),
    content: [{ type: "text", text: `message ${index}` }],
  }));
}

describe("ContextManager clear boundary", () => {
  it("keeps history but excludes the cleared prefix from the model view", async () => {
    const context = await clearManager();
    const history = clearMessages(4);
    const ledger = await context.markCleared(3);
    expect(ledger.cleared).toMatchObject({ uptoIndex: 3 });
    expect((await context.buildView(history)).messages.map((message) => message.id)).toEqual(["m3"]);
    expect(history).toHaveLength(4);
  });

  it("uses the later compact or clear boundary without leaking an older summary", async () => {
    const context = await clearManager();
    const base = await context.load();
    await context.replaceLedger({ ...base, compacted: { uptoIndex: 2, mode: "overview", summary: "old secret", instructions: [], createdAt: new Date().toISOString() }, cleared: { uptoIndex: 4, at: new Date().toISOString() } });
    const clearedView = await context.buildView(clearMessages(6));
    expect(clearedView.messages.map((message) => message.id)).toEqual(["m4", "m5"]);
    expect(JSON.stringify(clearedView.messages)).not.toContain("old secret");

    await context.replaceLedger({ ...base, compacted: { uptoIndex: 5, mode: "overview", summary: "new summary", instructions: [], createdAt: new Date().toISOString() }, cleared: { uptoIndex: 3, at: new Date().toISOString() } });
    const compactedView = await context.buildView(clearMessages(6));
    expect(compactedView.messages[0]?.id).toMatch(/^compaction:/);
    expect(compactedView.messages.at(-1)?.id).toBe("m5");
  });

  it("normalizes malformed clear records and replaceLedger restores an earlier boundary", async () => {
    const context = await clearManager();
    const original = await context.load();
    await context.replaceLedger({ ...original, cleared: { uptoIndex: -1, at: 3 } });
    expect((await context.load()).cleared).toBeUndefined();
    await context.markCleared(3);
    expect((await context.load()).cleared?.uptoIndex).toBe(3);
    await context.replaceLedger(original);
    expect((await context.load()).cleared).toBeUndefined();
    expect((await context.buildView(clearMessages(3))).messages).toHaveLength(3);
  });
});

describe("/clear checkpoint restore", () => {
  it("restoring a checkpoint taken before /clear rewinds the clear boundary", async () => {
    const { sessions, app, observed } = await clearApp("owc-clear-restore-");
    const workspace = await tempRoot("owc-clear-ws-");
    const session = await sessions.create({ cwd: workspace, title: "Clear restore" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "old question" }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "old answer" }]);
    const checkpoint = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "pre-clear" } });
    expect(checkpoint.statusCode).toBe(201);
    const checkpointId = checkpoint.json<{ id: string }>().id;

    const cleared = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(cleared.statusCode).toBe(200);
    const history = (await sessions.get(session.id))!.messages;
    expect((await new ContextManager(sessions.contextRoot(session.id)).buildView(history)).messages).toEqual([]);

    const restored = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints/${checkpointId}/restore`, payload: { confirm: true } });
    expect(restored.statusCode, restored.body).toBe(200);
    const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
    expect(ledger.cleared).toBeUndefined();
    const view = await new ContextManager(sessions.contextRoot(session.id)).buildView(history);
    expect(view.messages.map((message) => message.id)).toEqual(history.map((message) => message.id));
    expect(observed.some((event) => event.type === "checkpoint.restored")).toBe(true);
  }, 30_000);
});

describe("/clear composer command", () => {
  it("marks the current message boundary without changing history or starting the agent", async () => {
    const { root, sessions, agent, app, observed } = await clearApp();
    const session = await sessions.create({ cwd: root, title: "Clear route" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "keep me" }]);
    const before = (await sessions.get(session.id))!.messages;
    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, cleared: true, uptoIndex: 1 });
    expect((await sessions.get(session.id))!.messages).toEqual(before);
    expect(agent.isRunning(session.id)).toBe(false);
    expect(observed.find((event) => event.type === "context.cleared")?.payload).toMatchObject({ uptoIndex: 1 });
    expect((await new ContextManager(sessions.contextRoot(session.id)).buildView(before)).messages).toEqual([]);
    vi.spyOn(agent, "isRunning").mockReturnValue(true);
    const running = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(running.statusCode).toBe(409);
  });

  it("uptoIndex 用活动路径长度：存在离路径分支消息时 /clear 后新消息仍进视图", async () => {
    const { root, sessions, app, observed } = await clearApp();
    const session = await sessions.create({ cwd: root, title: "Clear with branches" });
    const m1 = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "q1" }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "a1" }]);
    // 制造分支：checkout 回 m1 再追加，旧 a1 成为离路径消息（全量 3 条，活动路径 2 条）
    await sessions.setActiveLeaf(session.id, m1.id);
    const retry = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "a1-retry" }]);
    const before = (await sessions.get(session.id))!;
    expect(before.messages).toHaveLength(3);
    expect(activePathMessages(before.messages, before.activeLeafId)).toHaveLength(2);

    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/clear" } });
    expect(response.statusCode).toBe(200);
    // uptoIndex 仍为活动路径长度（agent 视图/compactor 同口径）；uptoMessageId 锚定最后一条活动路径消息
    expect(response.json()).toMatchObject({ cleared: true, uptoIndex: 2, uptoMessageId: retry.id });
    expect(observed.find((event) => event.type === "context.cleared")?.payload).toMatchObject({ uptoIndex: 2, uptoMessageId: retry.id });

    // REST context 视图（buildView 输入为全量 JSONL，含离路径消息）也必须全清：
    // 仅靠活动路径长度换算全量下标会残留尾部消息（分隔线提早插入的根因）
    const restView = await new ContextManager(sessions.contextRoot(session.id)).buildView(before.messages);
    expect(restView.messages).toEqual([]);

    // 回归断言：/clear 后追加的新消息必须出现在视图中
    // （修复前 uptoIndex=3 > 活动路径长度，会把之后所有消息一并清出视图，模型看不到任何用户消息）
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "q2" }]);
    const after = (await sessions.get(session.id))!;
    const path = activePathMessages(after.messages, after.activeLeafId);
    const view = await new ContextManager(sessions.contextRoot(session.id)).buildView(path);
    expect(view.messages.map((message) => message.content[0])).toEqual([{ type: "text", text: "q2" }]);
    // 全量空间的 REST 视图同样只含新消息：分隔线对应边界 = 最后一条活动路径消息之后
    const restAfter = await new ContextManager(sessions.contextRoot(session.id)).buildView(after.messages);
    expect(restAfter.messages.map((message) => message.content[0])).toEqual([{ type: "text", text: "q2" }]);
  });
});
