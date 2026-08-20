import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { BackgroundTaskRegistry } from "../src/agent/background-tasks.js";
import { MessageQueue } from "../src/agent/message-queue.js";
import type { CoreClientLike } from "../src/core-client.js";
import { ContextManager } from "../src/context/context-manager.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeControllableCore, makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("AgentRunner live streaming", () => {
  it("publishes deltas during the stream with tool_call_delta and a reset on retry", async () => {
    const root = await tempRoot("owc-agent-live-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "live", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const core = makeFakeCore({
      async readFile() { return { content: "file", totalLines: 1, encoding: "utf-8" as const, truncated: false }; },
    });

    let attempt = 0;
    const provider: Provider = {
      name: "live",
      async *streamChat() {
        attempt += 1;
        if (attempt === 1) {
          // 第一次 attempt 流出部分文本后失败：前端应收到 stream_reset 而不是重复文本
          yield { type: "text_delta", text: " partial" };
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        if (attempt === 2) {
          yield { type: "text_delta", text: "hello " };
          yield { type: "text_delta", text: "world" };
          yield { type: "tool_call_delta", id: "c1", name: "read_file", argumentsDelta: "" };
          yield { type: "tool_call_delta", id: "c1", argumentsDelta: "{\"path\":\"a.ts\"}" };
          yield { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.ts" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const seen: Array<{ type: string; payload: unknown }> = [];
    events.on("event", (event: { type: string; payload: unknown }) => seen.push({ type: event.type, payload: event.payload }));
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    await runner.run(session.id, "stream it");
    expect(attempt).toBe(3);

    const types = seen.map((event) => event.type);
    const firstDelta = types.indexOf("message.delta");
    const resetAt = types.indexOf("message.stream_reset");
    // 流式发布：delta 先于 run 结束事件；失败 attempt 的 partial 先于 reset，重试文本在其后
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(resetAt).toBeGreaterThan(firstDelta);
    const streamEnd = types.lastIndexOf("agent.state");
    expect(firstDelta).toBeLessThan(streamEnd);
    const deltaText = seen.filter((event) => event.type === "message.delta")
      .map((event) => (event.payload as { text: string }).text).join("");
    expect(deltaText).toBe(" partialhello worlddone");
    expect(deltaText.match(/hello /g)).toHaveLength(1);

    const toolDeltas = seen.filter((event) => event.type === "message.tool_call_delta")
      .map((event) => event.payload as { id: string; name?: string; text: string });
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    expect(toolDeltas[0]).toMatchObject({ id: "c1", name: "read_file" });
    expect(toolDeltas.map((delta) => delta.text).join("")).toBe("{\"path\":\"a.ts\"}");

    // 完整 tool_call 仍落盘（流式分片不产生重复内容）
    const detail = await sessions.get(session.id);
    const toolCalls = detail?.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_call") ?? [];
    expect(toolCalls).toEqual([expect.objectContaining({ id: "c1", name: "read_file" })]);
  });

  it("一轮内多个 usage chunk：WS 逐条实时转发，ledger 只记最后一条", async () => {
    const root = await tempRoot("owc-agent-usage-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "live", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const core = makeFakeCore();
    const provider: Provider = {
      name: "live",
      async *streamChat() {
        yield { type: "text_delta", text: "answer" };
        // stream_options.include_usage 的端点可能逐 chunk 重复上报 usage
        yield { type: "usage", inputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: 0 };
        yield { type: "usage", inputTokens: 42, outputTokens: 7, cacheRead: 4, cacheWrite: 0 };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const seen: Array<{ type: string; payload: unknown }> = [];
    events.on("event", (event: { type: string; payload: unknown }) => seen.push({ type: event.type, payload: event.payload }));
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    await runner.run(session.id, "hi");

    // WS 实时转发不变：两条 usage 都广播（UI 实时成本）
    const usageEvents = seen.filter((event) => event.type === "context.usage");
    expect(usageEvents).toHaveLength(2);
    // ledger 只记最后一条，不逐 chunk 累加
    const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
    expect(ledger.usage).toMatchObject({ inputTokens: 42, outputTokens: 7, cacheRead: 4 });
  });

});

describe("MessageQueue", () => {
  it("persists queue state across instances and records the applied chat message", async () => {
    const root = await tempRoot("owc-message-queue-");
    const sessionRoot = path.join(root, "session-a");
    await mkdir(sessionRoot, { recursive: true });
    const first = new MessageQueue(() => sessionRoot);

    const queued = await first.enqueue("session-a", "steer", "use a streaming parser");
    const restored = new MessageQueue(() => sessionRoot);
    expect(await restored.list("session-a", "steer")).toMatchObject([{ id: queued.item.id, status: "queued" }]);

    const consuming = await restored.take("session-a", "steer");
    expect(consuming).toMatchObject({ id: queued.item.id, status: "consuming" });
    await restored.apply("session-a", queued.item.id, "message-42");
    expect(await first.list("session-a", "steer")).toMatchObject([{ id: queued.item.id, status: "applied", appliedMessageId: "message-42" }]);
  });

  it("serializes concurrent writes and can return a failed claim to queued", async () => {
    const root = await tempRoot("owc-message-queue-");
    const sessionRoot = path.join(root, "session-b");
    await mkdir(sessionRoot, { recursive: true });
    const queue = new MessageQueue(() => sessionRoot);

    const [first, second] = await Promise.all([
      queue.enqueue("session-b", "steer", "first"),
      queue.enqueue("session-b", "follow_up", "second"),
    ]);
    expect((await queue.list("session-b")).map((item) => item.content)).toEqual(["first", "second"]);
    const claim = await queue.take("session-b", "steer");
    await queue.requeue("session-b", claim!.id);
    expect(await queue.list("session-b", "steer")).toMatchObject([{ id: first.item.id, status: "queued" }]);
    expect(await queue.list("session-b", "follow_up")).toMatchObject([{ id: second.item.id, status: "queued" }]);
  });
});

/** 每轮都发起工具调用的 provider：主循环无法自然收尾，只能撞轮次上限。 */
function loopingProvider(name: string): Provider {
  let counter = 0;
  return {
    name,
    async *streamChat() {
      counter += 1;
      yield { type: "tool_call", id: `loop-${counter}`, name: "todo_write", input: { items: [{ content: `轮次 ${counter}`, status: "pending" }] } };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "tool_use" };
    },
  };
}

async function setupMaxTurns(maxTurns?: number): Promise<{ runner: AgentRunner; sessionId: string }> {
  const root = await tempRoot("owc-agent-max-turns-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "loop", model: "test-model" });
  // yolo 跳过权限确认；manual 排除快照后端干扰
  await sessions.updateConfig(session.id, { provider: "loop", model: "test-model", snapshotMode: "manual", permissionMode: "yolo" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(loopingProvider("loop"));
  const runner = new AgentRunner(
    sessions,
    providers,
    makeFakeCore(),
    new EventBus(),
    pricing,
    undefined,
    "zh-CN",
    ...(maxTurns !== undefined ? [maxTurns] as const : []),
  );
  return { runner, sessionId: session.id };
}

describe("AgentRunner 轮次上限（设置页 agentMaxTurns 热生效）", () => {
  it("默认 50 轮：循环 provider 以 Agent exceeded 50 turns 收尾", async () => {
    const { runner, sessionId } = await setupMaxTurns();
    await expect(runner.run(sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 50 turns");
  }, 30_000);

  it("构造参数可压低上限：maxTurns=2 → Agent exceeded 2 turns", async () => {
    const { runner, sessionId } = await setupMaxTurns(2);
    await expect(runner.run(sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 2 turns");
  }, 30_000);

  it("setMaxTurns 注入的取值函数覆盖构造参数（设置热生效路径）", async () => {
    const { runner, sessionId } = await setupMaxTurns(50);
    let current = 3;
    runner.setMaxTurns(() => current);
    await expect(runner.run(sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 3 turns");
    // 取值函数实时生效：调大后下一次运行按新上限收尾
    current = 5;
    await expect(runner.run(sessionId, "继续跑")).rejects.toThrow("Agent exceeded 5 turns");
  }, 30_000);
});

const thinkingCore = {
  on() { return thinkingCore; },
  async configureSession() { return { sandboxCapability: "advisory" }; },
} as unknown as CoreClientLike;

/** 快照用例标准 rig：test provider 固定回一条 text_delta；observed 收集全部事件。 */
async function makeRunner(options: {
  text: string;
  tempPrefix: string;
  cwd?: (root: string) => string;
  snapshotMode?: "manual";
  backgroundTasks?: BackgroundTaskRegistry;
}) {
  const root = await tempRoot(options.tempPrefix);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: options.cwd ? options.cwd(root) : root, provider: "test", model: "test-model" });
  if (options.snapshotMode) {
    await sessions.updateConfig(session.id, { provider: "test", model: "test-model", snapshotMode: options.snapshotMode });
  }
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register({
    name: "test",
    async *streamChat() {
      yield { type: "text_delta", text: options.text };
      yield { type: "done", stopReason: "end_turn" };
    },
  });
  const events = new EventBus();
  const observed: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event) => observed.push(event));
  const runner = new AgentRunner(
    sessions, providers, thinkingCore, events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, options.backgroundTasks,
  );
  return { sessions, session, runner, observed };
}

describe("thinking persistence", () => {
  it("persists providers that emit thinking deltas without thinking_end", async () => {
    const root = await tempRoot("owc-thinking-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "openai-compatible", model: "reasoning-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const provider: Provider = {
      name: "openai-compatible",
      async *streamChat() {
        yield { type: "thinking_delta", text: "先分析" };
        yield { type: "thinking_delta", text: "问题。" };
        yield { type: "text_delta", text: "最终答案" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, thinkingCore, new EventBus(), pricing);

    await runner.run(session.id, "请回答");

    const detail = await sessions.get(session.id);
    const assistant = detail?.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", text: "先分析问题。", provider: "openai-compatible" },
      { type: "text", text: "最终答案" },
    ]);
  });

  it("text_end 以权威文本替换 delta 累积块并固化 v1 textSignature 落盘", async () => {
    const root = await tempRoot("owc-text-end-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "openai-responses", model: "gpt-test" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const provider: Provider = {
      name: "openai-responses",
      async *streamChat() {
        yield { type: "text_delta", text: "你好" };
        // output_item.done 权威文本兜底 + v1 textSignature（{v:1,id,phase?}）
        yield { type: "text_end", text: "你好世界", signature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }) };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, thinkingCore, new EventBus(), pricing);

    await runner.run(session.id, "请回答");

    const detail = await sessions.get(session.id);
    const assistant = detail?.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "text", text: "你好世界", textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }) },
    ]);
  });

  it("text_delta 分片 + text_end 合并为单个 text 块（不产生碎片块）", async () => {
    const root = await tempRoot("owc-text-merge-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "openai-responses", model: "gpt-test" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const provider: Provider = {
      name: "openai-responses",
      async *streamChat() {
        yield { type: "text_delta", text: "foo " };
        yield { type: "text_delta", text: "bar" };
        yield { type: "text_end", text: "foo bar", signature: JSON.stringify({ v: 1, id: "msg_2" }) };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, thinkingCore, new EventBus(), pricing);

    await runner.run(session.id, "请回答");

    const detail = await sessions.get(session.id);
    const assistant = detail?.messages.find((message) => message.role === "assistant");
    const textBlocks = assistant?.content.filter((block) => block.type === "text") ?? [];
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toEqual({
      type: "text",
      text: "foo bar",
      textSignature: JSON.stringify({ v: 1, id: "msg_2" }),
    });
  });

  it("B3：同一 reasoning item 的第二次 thinking_end 以 enriched signature 替换早期块而非追加", async () => {
    const root = await tempRoot("owc-thinking-b3-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "openai-responses", model: "gpt-test" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const signature = (encrypted: boolean): string => JSON.stringify({
      type: "reasoning",
      id: "rs_abc123",
      content: [{ type: "reasoning_text", text: "思考" }],
      ...(encrypted ? { encrypted_content: "加密回填" } : {}),
    });
    const provider: Provider = {
      name: "openai-responses",
      async *streamChat() {
        // 首次收尾（无 encrypted_content）与 B3 回填（enriched signature，同 rs_ id）
        yield { type: "thinking_end", text: "初版", signature: signature(false) };
        yield { type: "thinking_end", text: "回填版", signature: signature(true) };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, thinkingCore, new EventBus(), pricing);

    await runner.run(session.id, "请回答");

    const detail = await sessions.get(session.id);
    const assistant = detail?.messages.find((message) => message.role === "assistant");
    const thinkingBlocks = assistant?.content.filter((block) => block.type === "thinking") ?? [];
    // 第二次 thinking_end 原位替换：仍只有一个 thinking 块，内容/签名为回填版
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toEqual({
      type: "thinking",
      text: "回填版",
      signature: signature(true),
      provider: "openai-responses",
    });
  });

  it("skips automatic checkpoints in manual snapshot mode", async () => {
    const { sessions, session, runner } = await makeRunner({
      text: "完成",
      tempPrefix: "owc-manual-snapshot-",
      snapshotMode: "manual",
    });

    await runner.run(session.id, "不要自动快照");

    expect(existsSync(path.join(sessions.contextRoot(session.id), "shadow.git"))).toBe(false);
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("skips automatic checkpoint while a background task still uses the workspace", async () => {
    const backgroundTasks = { hasRunningForSession: () => true, drainNotices: () => [] } as unknown as BackgroundTaskRegistry;
    const { sessions, session, runner, observed } = await makeRunner({
      text: "继续执行",
      tempPrefix: "owc-background-snapshot-",
      backgroundTasks,
    });

    await runner.run(session.id, "后台任务还在运行");

    expect(existsSync(path.join(sessions.contextRoot(session.id), "shadow.git"))).toBe(false);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "checkpoint.failed", payload: expect.objectContaining({ message: expect.stringContaining("后台任务") }) }),
    ]));
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("skips automatic checkpoint when app's managed workspace gate only has a shared lease", async () => {
    const { sessions, session, runner, observed } = await makeRunner({
      text: "继续执行",
      tempPrefix: "owc-workspace-lease-snapshot-",
    });

    await runner.run(session.id, "工作区正在读取", {
      managedWorkspace: { automaticSnapshotAllowed: false },
    });

    expect(existsSync(path.join(sessions.contextRoot(session.id), "shadow.git"))).toBe(false);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "checkpoint.failed", payload: expect.objectContaining({ message: expect.stringContaining("文件或命令") }) }),
    ]));
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("continues the user turn when an automatic checkpoint cannot be created", async () => {
    const { sessions, session, runner, observed } = await makeRunner({
      text: "仍然继续",
      tempPrefix: "owc-checkpoint-failure-",
      cwd: (root) => path.join(root, "workspace-was-removed"),
    });
    let downgraded = 0;

    await runner.run(session.id, "不要因为快照失败而丢失这条消息", {
      managedWorkspace: {
        automaticSnapshotAllowed: true,
        downgradeAfterAutomaticSnapshot: () => { downgraded += 1; },
      },
    });

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "checkpoint.failed", payload: expect.objectContaining({ message: expect.any(String) }) }),
    ]));
    expect(downgraded).toBe(1);
    expect(observed.some((event) => event.type === "agent.error")).toBe(false);
    expect((await sessions.get(session.id))?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});

/** 首轮发起一次 bash 工具调用，次轮结束 turn。 */
function makeBashProvider(): Provider {
  let turn = 0;
  return {
    name: "tool-summary-stub",
    async *streamChat() {
      if (turn++ === 0) {
        yield { type: "tool_call", id: "bash-1", name: "bash", input: { cmd: "echo hi" } };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

async function setupToolSummary() {
  const root = await tempRoot("owc-tool-summary-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "tool-summary-stub", model: "claude-opus-4-8" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const published: AppEvent[] = [];
  events.on("event", (event: AppEvent) => published.push(event));
  const providers = new ProviderRegistry();
  providers.register(makeBashProvider());
  // jobControl: false → 走非 jobControl 的 core.run 路径（本文件要覆盖的路径）
  const core = makeControllableCore();
  const runner = new AgentRunner(sessions, providers, core.client, events, pricing);
  return { root, sessions, session, events, published, core, runner };
}

describe("工具结果事件只发摘要 + artifact 引用（enforcement）", () => {
  it("大工具结果：WS 事件载荷只有 ≤1KB preview + artifactId，全文落 artifact", async () => {
    const { sessions, session, published, core, runner } = await setupToolSummary();
    // ~200KB 输出（约 5 万 tokens，远超 bash 8000 token 预算）
    const marker = "FULL-OUTPUT-MARKER-";
    const bigOutput = marker + "x".repeat(200_000);

    const runPromise = runner.run(session.id, "run it");
    await vi.waitFor(() => expect(core.runCalls.length).toBe(1), { timeout: 10_000 });
    core.emitExecOutput(bigOutput);
    core.release({ exitCode: 0, durationMs: 1, truncated: false });
    await runPromise;

    const toolEnd = published.find((event) => event.type === "tool.end");
    expect(toolEnd).toBeDefined();
    const payload = toolEnd!.payload as { toolCallId: string; result: Record<string, unknown> };
    expect(payload.toolCallId).toBe("bash-1");
    // 事件载荷是摘要形态：preview + originalTokens + truncated + artifactId，不含 result 全文
    expect(payload.result.truncated).toBe(true);
    expect(typeof payload.result.artifactId).toBe("string");
    expect((payload.result.preview as string).length).toBeLessThanOrEqual(1_024);
    expect(JSON.stringify(payload).length).toBeLessThan(8_000);
    expect(JSON.stringify(payload)).not.toContain(bigOutput.slice(0, 4096));

    // 全文走 artifact 读取路径：artifact 文件内容完整
    const artifactPath = path.join(sessions.contextRoot(session.id), "artifacts", `${payload.result.artifactId as string}.txt`);
    const artifactText = await readFile(artifactPath, "utf8");
    expect(artifactText).toContain(marker);
    expect(artifactText.length).toBeGreaterThan(200_000);
  }, 15_000);

  it("小工具结果：preview 即全文、无 artifactId、不截断", async () => {
    const { session, published, core, runner } = await setupToolSummary();
    const runPromise = runner.run(session.id, "run it");
    await vi.waitFor(() => expect(core.runCalls.length).toBe(1), { timeout: 10_000 });
    core.emitExecOutput("hello world");
    core.release({ exitCode: 0, durationMs: 1, truncated: false });
    await runPromise;

    const toolEnd = published.find((event) => event.type === "tool.end");
    const payload = toolEnd!.payload as { result: Record<string, unknown> };
    expect(payload.result.truncated).toBe(false);
    expect(payload.result.artifactId).toBeUndefined();
    expect(payload.result.preview as string).toContain("hello world");
  }, 15_000);
});

describe("工具事件 input 限长（tool.start payload）", () => {
  it("write_file 全量 content 超 256KB：事件 input 截断并标记 inputTruncated；小 input 原样", async () => {
    const root = await tempRoot("owc-tool-input-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "tool-input-stub", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const bigContent = "y".repeat(300_000);
    let turn = 0;
    const provider: Provider = {
      name: "tool-input-stub",
      async *streamChat() {
        if (turn === 0) {
          yield { type: "tool_call", id: "wf-big", name: "write_file", input: { path: "big.txt", content: bigContent } };
          yield { type: "done", stopReason: "tool_use" };
        } else if (turn === 1) {
          yield { type: "tool_call", id: "wf-small", name: "write_file", input: { path: "small.txt", content: "small" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
        turn += 1;
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, makeControllableCore().client, events, pricing);

    await runner.run(session.id, "写两个文件");

    const starts = published.filter((event) => event.type === "tool.start");
    expect(starts).toHaveLength(2);
    const bigPayload = starts[0]!.payload as { name: string; input: { content: string }; inputTruncated?: boolean };
    expect(bigPayload.name).toBe("write_file");
    expect(bigPayload.inputTruncated).toBe(true);
    expect(bigPayload.input.content.length).toBeLessThanOrEqual(256 * 1024 + 64);
    // 整帧远小于原始 input（300KB content 不再整帧上 WS）
    expect(JSON.stringify(starts[0]!.payload).length).toBeLessThan(280_000);
    const smallPayload = starts[1]!.payload as { input: { content: string }; inputTruncated?: boolean };
    expect(smallPayload.inputTruncated).toBeUndefined();
    expect(smallPayload.input.content).toBe("small");
  }, 15_000);
});
