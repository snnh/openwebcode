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

const thinkingCore = {
  on() { return thinkingCore; },
  async configureSession() { return { sandboxCapability: "advisory" }; },
} as unknown as CoreClientLike;

/** 测试 rig 公共部分：临时目录 + 会话 + pricing + 事件收集 + provider 注册。 */
async function makeStack(prefix: string, provider: Provider, options: { model?: string; permissions?: "yolo"; config?: Record<string, unknown>; cwd?: (root: string) => string } = {}) {
  const root = await tempRoot(prefix);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const model = options.model ?? "test-model";
  const session = await sessions.create({ cwd: options.cwd ? options.cwd(root) : root, provider: provider.name, model });
  if (options.permissions) await sessions.updatePermissions(session.id, "yolo", []);
  if (options.config) await sessions.updateConfig(session.id, { provider: provider.name, model, ...options.config });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const seen: AppEvent[] = [];
  events.on("event", (event) => seen.push(event));
  const providers = new ProviderRegistry();
  providers.register(provider);
  return { root, sessions, session, pricing, events, seen, providers };
}

describe("AgentRunner live streaming", () => {
  it("流式发布 delta/tool_call_delta；重试前发 stream_reset，完整 tool_call 只落盘一次", async () => {
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
          yield { type: "text_delta", text: "hello " }; yield { type: "text_delta", text: "world" };
          yield { type: "tool_call_delta", id: "c1", name: "read_file", argumentsDelta: "" }; yield { type: "tool_call_delta", id: "c1", argumentsDelta: "{\"path\":\"a.ts\"}" };
          yield { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.ts" } }; yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "done" }; yield { type: "done", stopReason: "end_turn" };
      },
    };
    const stack = await makeStack("owc-agent-live-", provider, { model: "claude-opus-4-8", permissions: "yolo" });
    const core = makeFakeCore({
      async readFile() { return { content: "file", totalLines: 1, encoding: "utf-8" as const, truncated: false }; },
    });
    await new AgentRunner(stack.sessions, stack.providers, core, stack.events, stack.pricing).run(stack.session.id, "stream it"); expect(attempt).toBe(3);
    const types = stack.seen.map((event) => event.type);
    const firstDelta = types.indexOf("message.delta"); expect(firstDelta).toBeGreaterThanOrEqual(0); expect(types.indexOf("message.stream_reset")).toBeGreaterThan(firstDelta); expect(firstDelta).toBeLessThan(types.lastIndexOf("agent.state")); // 失败 attempt 的 partial 先于 reset，delta 先于 run 结束
    const deltaText = stack.seen.filter((event) => event.type === "message.delta").map((event) => (event.payload as { text: string }).text).join(""); expect(deltaText).toBe(" partialhello worlddone"); expect(deltaText.match(/hello /g)).toHaveLength(1); // 重试不重复文本
    const toolDeltas = stack.seen.filter((event) => event.type === "message.tool_call_delta").map((event) => event.payload as { id: string; name?: string; text: string }); expect(toolDeltas[0]).toMatchObject({ id: "c1", name: "read_file" });
    expect(toolDeltas.map((delta) => delta.text).join("")).toBe("{\"path\":\"a.ts\"}");
    const toolCalls = (await stack.sessions.get(stack.session.id))?.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_call") ?? []; expect(toolCalls).toEqual([expect.objectContaining({ id: "c1", name: "read_file" })]);
  });

  it("一轮内多个 usage chunk：WS 逐条实时转发，ledger 只记最后一条", async () => {
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
    const stack = await makeStack("owc-agent-usage-", provider, { model: "claude-opus-4-8" });
    await new AgentRunner(stack.sessions, stack.providers, makeFakeCore(), stack.events, stack.pricing).run(stack.session.id, "hi"); expect(stack.seen.filter((event) => event.type === "context.usage")).toHaveLength(2); // UI 实时成本不丢
    const ledger = await new ContextManager(stack.sessions.contextRoot(stack.session.id)).load(); expect(ledger.usage).toMatchObject({ inputTokens: 42, outputTokens: 7, cacheRead: 4 }); // 不逐 chunk 累加
  });

  it("MessageQueue 跨实例持久化与 status 流转；并发写串行落盘且领取可回退", async () => {
    const root = await tempRoot("owc-message-queue-");
    const sessionRoot = path.join(root, "session-a");
    await mkdir(sessionRoot, { recursive: true });
    const first = new MessageQueue(() => sessionRoot);
    const queued = await first.enqueue("session-a", "steer", "use a streaming parser");
    const restored = new MessageQueue(() => sessionRoot); expect(await restored.list("session-a", "steer")).toMatchObject([{ id: queued.item.id, status: "queued" }]); expect(await restored.take("session-a", "steer")).toMatchObject({ id: queued.item.id, status: "consuming" });
    await restored.apply("session-a", queued.item.id, "message-42"); expect(await first.list("session-a", "steer")).toMatchObject([{ status: "applied", appliedMessageId: "message-42" }]);
    const secondRoot = path.join(root, "session-b");
    await mkdir(secondRoot, { recursive: true });
    const second = new MessageQueue(() => secondRoot);
    const [one, two] = await Promise.all([second.enqueue("session-b", "steer", "first"), second.enqueue("session-b", "follow_up", "second")]); expect((await second.list("session-b")).map((item) => item.content)).toEqual(["first", "second"]);
    await second.requeue("session-b", (await second.take("session-b", "steer"))!.id); expect(await second.list("session-b", "steer")).toMatchObject([{ id: one.item.id, status: "queued" }]); expect(await second.list("session-b", "follow_up")).toMatchObject([{ id: two.item.id, status: "queued" }]);
  });

  it("轮次上限：默认 50 轮 / 构造参数压低 / setMaxTurns 取值函数覆盖且实时生效", async () => {
    // 每轮都发起工具调用的 provider：主循环无法自然收尾，只能撞轮次上限
    const looping = (): Provider => {
      let counter = 0;
      return {
        name: "loop",
        async *streamChat() {
          counter += 1;
          yield { type: "tool_call", id: `loop-${counter}`, name: "todo_write", input: { items: [{ content: `轮次 ${counter}`, status: "pending" }] } };
          yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
          yield { type: "done", stopReason: "tool_use" };
        },
      };
    };
    // manual 排除快照后端干扰、yolo 跳过权限确认，聚焦轮次上限
    const setup = async (maxTurns?: number) => {
      const stack = await makeStack("owc-agent-max-turns-", looping(), { permissions: "yolo", config: { snapshotMode: "manual" } });
      const runner = new AgentRunner(
        stack.sessions, stack.providers, makeFakeCore(), new EventBus(), stack.pricing,
        undefined, "zh-CN", ...(maxTurns !== undefined ? [maxTurns] as const : []),
      );
      return { runner, sessionId: stack.session.id };
    };
    const byDefault = await setup();
    await expect(byDefault.runner.run(byDefault.sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 50 turns");
    const lowered = await setup(2);
    await expect(lowered.runner.run(lowered.sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 2 turns");
    const { runner, sessionId } = await setup(50);
    let current = 3;
    runner.setMaxTurns(() => current);
    await expect(runner.run(sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 3 turns");
    current = 5;
    await expect(runner.run(sessionId, "继续跑")).rejects.toThrow("Agent exceeded 5 turns");
  }, 30_000);
});

/** 用单个 provider 跑一轮，返回 assistant 消息内容块（直接观察持久化形态）。 */
async function runAssistant(provider: Provider, model: string, tempPrefix: string) {
  const stack = await makeStack(tempPrefix, provider, { model });
  await new AgentRunner(stack.sessions, stack.providers, thinkingCore, new EventBus(), stack.pricing).run(stack.session.id, "请回答");
  return (await stack.sessions.get(stack.session.id))?.messages.find((message) => message.role === "assistant")?.content ?? [];
}

describe("thinking / text 块持久化", () => {
  it("thinking_delta 累积落盘；同 reasoning item 的第二次 thinking_end 原位替换", async () => {
    // 只发 thinking_delta 的 provider：按累积文本落一个 thinking 块
    const accumulated = await runAssistant({
      name: "openai-compatible",
      async *streamChat() {
        yield { type: "thinking_delta", text: "先分析" }; yield { type: "thinking_delta", text: "问题。" }; yield { type: "text_delta", text: "最终答案" }; yield { type: "done", stopReason: "end_turn" };
      },
    }, "reasoning-model", "owc-thinking-");
    expect(accumulated).toEqual([
      { type: "thinking", text: "先分析问题。", provider: "openai-compatible" },
      { type: "text", text: "最终答案" },
    ]);
    const signature = (encrypted: boolean): string => JSON.stringify({
      type: "reasoning", id: "rs_abc123", content: [{ type: "reasoning_text", text: "思考" }], ...(encrypted ? { encrypted_content: "加密回填" } : {}),
    });
    // B3：首次收尾（无 encrypted_content）与同 rs_ id 的回填，不得追加成两个 thinking 块
    const replaced = await runAssistant({
      name: "openai-responses",
      async *streamChat() {
        yield { type: "thinking_end", text: "初版", signature: signature(false) }; yield { type: "thinking_end", text: "回填版", signature: signature(true) }; yield { type: "done", stopReason: "end_turn" };
      },
    }, "gpt-test", "owc-thinking-b3-");
    expect(replaced).toEqual([{ type: "thinking", text: "回填版", signature: signature(true), provider: "openai-responses" }]);
  });

  it("text_end 以权威文本替换 delta 累积块并固化 v1 textSignature；分片合并为单块", async () => {
    // output_item.done 权威文本兜底 + v1 textSignature（{v:1,id,phase?}）
    const authoritative = await runAssistant({
      name: "openai-responses",
      async *streamChat() {
        yield { type: "text_delta", text: "你好" }; yield { type: "text_end", text: "你好世界", signature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }) }; yield { type: "done", stopReason: "end_turn" };
      },
    }, "gpt-test", "owc-text-end-");
    expect(authoritative).toEqual([{ type: "text", text: "你好世界", textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }) }]);
    const merged = await runAssistant({
      name: "openai-responses",
      async *streamChat() {
        yield { type: "text_delta", text: "foo " }; yield { type: "text_delta", text: "bar" }; yield { type: "text_end", text: "foo bar", signature: JSON.stringify({ v: 1, id: "msg_2" }) }; yield { type: "done", stopReason: "end_turn" };
      },
    }, "gpt-test", "owc-text-merge-");
    expect(merged).toEqual([{ type: "text", text: "foo bar", textSignature: JSON.stringify({ v: 1, id: "msg_2" }) }]);
  });
});

describe("自动检查点的跳过与降级", () => {
  it("manual 模式 / 后台任务占用 / 托管工作区租约 / 快照失败：一律不落 shadow，失败也继续用户轮次", async () => {
    let downgraded = 0;
    const cases: Array<{ name: string; prefix: string; text: string; config?: Record<string, unknown>; cwd?: (root: string) => string; background?: boolean; runOptions: Record<string, unknown>; expectMessage?: string }> = [
      { name: "manual 快照模式", prefix: "owc-manual-snapshot-", text: "完成", config: { snapshotMode: "manual" }, runOptions: {} },
      { name: "后台任务仍在使用工作区", prefix: "owc-background-snapshot-", text: "继续执行", background: true, runOptions: {}, expectMessage: "后台任务" },
      { name: "托管工作区只有共享租约", prefix: "owc-workspace-lease-snapshot-", text: "继续执行", runOptions: { managedWorkspace: { automaticSnapshotAllowed: false } }, expectMessage: "文件或命令" },
      {
        name: "自动快照失败（工作区已删除）", prefix: "owc-checkpoint-failure-", text: "仍然继续",
        cwd: (root) => path.join(root, "workspace-was-removed"),
        runOptions: { managedWorkspace: { automaticSnapshotAllowed: true, downgradeAfterAutomaticSnapshot: () => { downgraded += 1; } } }, expectMessage: "",
      },
    ];
    for (const item of cases) {
      const provider: Provider = {
        name: "test",
        async *streamChat() { yield { type: "text_delta", text: item.text }; yield { type: "done", stopReason: "end_turn" }; },
      };
      const stack = await makeStack(item.prefix, provider, { config: item.config, cwd: item.cwd });
      const backgroundTasks = item.background ? { hasRunningForSession: () => true, drainNotices: () => [] } as unknown as BackgroundTaskRegistry : undefined;
      const runner = new AgentRunner(
        stack.sessions, stack.providers, thinkingCore, stack.events, stack.pricing,
        undefined, "zh-CN", 50, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, backgroundTasks,
      );
      await runner.run(stack.session.id, "不要因为快照失败而丢失这条消息", item.runOptions);
      const failures = stack.seen.filter((event) => event.type === "checkpoint.failed");
      if (item.expectMessage === undefined) {
        expect(failures, item.name).toHaveLength(0);
      } else {
        expect(failures, item.name).toEqual([expect.objectContaining({ payload: expect.objectContaining({ message: expect.stringContaining(item.expectMessage) }) })]);
      }
      expect(existsSync(path.join(stack.sessions.contextRoot(stack.session.id), "shadow.git")), item.name).toBe(false); expect(stack.seen.some((event) => event.type === "agent.error"), item.name).toBe(false);
      expect((await stack.sessions.get(stack.session.id))?.messages.map((message) => message.role), item.name).toEqual(["user", "assistant"]);
    }
    expect(downgraded).toBe(1);
  }, 30_000);
});

describe("工具事件载荷（结果摘要 + input 限长）", () => {
  it("大结果只发 ≤1KB preview + artifactId（全文落 artifact）；小结果 preview 即全文", async () => {
    const marker = "FULL-OUTPUT-MARKER-";
    for (const item of [
      { name: "大结果", output: marker + "x".repeat(200_000), truncated: true },
      { name: "小结果", output: "hello world", truncated: false },
    ]) {
      // 首轮发起一次 bash 调用，次轮结束 turn；jobControl: false 走非 jobControl 的 core.run 路径
      let turn = 0;
      const provider: Provider = {
        name: "tool-summary-stub",
        async *streamChat() {
          turn += 1;
          if (turn === 1) { yield { type: "tool_call", id: "bash-1", name: "bash", input: { cmd: "echo hi" } }; yield { type: "done", stopReason: "tool_use" }; return; }
          yield { type: "done", stopReason: "end_turn" };
        },
      };
      const stack = await makeStack("owc-tool-summary-", provider, { model: "claude-opus-4-8", permissions: "yolo" });
      const core = makeControllableCore();
      const runPromise = new AgentRunner(stack.sessions, stack.providers, core.client, stack.events, stack.pricing).run(stack.session.id, "run it");
      await vi.waitFor(() => expect(core.runCalls.length).toBe(1), { timeout: 10_000 });
      core.emitExecOutput(item.output);
      core.release({ exitCode: 0, durationMs: 1, truncated: false });
      await runPromise;
      const payload = stack.seen.find((event) => event.type === "tool.end")!.payload as { toolCallId: string; result: Record<string, unknown> }; expect(payload.toolCallId, item.name).toBe("bash-1"); expect(payload.result.truncated, item.name).toBe(item.truncated);
      if (!item.truncated) {
        expect(String(payload.result.preview)).toContain("hello world"); expect(payload.result.artifactId).toBeUndefined();
        continue;
      }
      // ~200KB 输出远超 bash 预算：事件载荷必须是摘要形态，不含 result 全文
      expect((payload.result.preview as string).length).toBeLessThanOrEqual(1_024); expect(JSON.stringify(payload).length).toBeLessThan(8_000);
      const artifactText = await readFile(path.join(stack.sessions.contextRoot(stack.session.id), "artifacts", `${payload.result.artifactId as string}.txt`), "utf8"); expect(artifactText).toContain(marker); expect(artifactText.length).toBeGreaterThan(200_000);
    }
  }, 20_000);
  it("write_file 全量 content 超 256KB：tool.start input 截断并标记 inputTruncated；小 input 原样", async () => {
    const bigContent = "y".repeat(300_000);
    let turn = 0;
    const provider: Provider = {
      name: "tool-input-stub",
      async *streamChat() {
        turn += 1;
        if (turn === 1) { yield { type: "tool_call", id: "wf-big", name: "write_file", input: { path: "big.txt", content: bigContent } }; yield { type: "done", stopReason: "tool_use" }; return; }
        if (turn === 2) { yield { type: "tool_call", id: "wf-small", name: "write_file", input: { path: "small.txt", content: "small" } }; yield { type: "done", stopReason: "tool_use" }; return; }
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const stack = await makeStack("owc-tool-input-", provider, { model: "claude-opus-4-8", permissions: "yolo" });
    await new AgentRunner(stack.sessions, stack.providers, makeControllableCore().client, stack.events, stack.pricing).run(stack.session.id, "写两个文件");
    const starts = stack.seen.filter((event) => event.type === "tool.start");
    const bigPayload = starts[0]!.payload as { name: string; input: { content: string }; inputTruncated?: boolean }; expect(bigPayload.name).toBe("write_file"); expect(bigPayload.inputTruncated).toBe(true); expect(bigPayload.input.content.length).toBeLessThanOrEqual(256 * 1024 + 64);
    expect(JSON.stringify(starts[0]!.payload).length).toBeLessThan(280_000); // 不再整帧上 WS
    const smallPayload = starts[1]!.payload as { input: { content: string }; inputTruncated?: boolean }; expect(smallPayload.inputTruncated).toBeUndefined(); expect(smallPayload.input.content).toBe("small");
  }, 15_000);
});
