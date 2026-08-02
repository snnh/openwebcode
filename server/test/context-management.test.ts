import { describe, expect, it } from "vitest";
import { ContextManager, selectCacheBreakpoints } from "../src/context/context-manager.js";
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
