import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient, CoreClientLike, JobStatus } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import type { HookRunner } from "../src/hooks.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";
import { makeAbortPendingProvider, makeAgentHarness, toolResultOf } from "./helpers/agent-harness.js";
import { FAKE_CORE_INFO, makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function setup(provider = "test"): Promise<{ root: string; sessions: SessionStore; sessionId: string; pricing: PricingCatalog; providers: ProviderRegistry; events: EventBus }> {
  const root = await tempRoot("owc-agent-failure-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider, model: "test-model" });
  // 本组只验证消息/错误链，排除真实 GitShadow 快照对临时目录的干扰。
  await sessions.updateConfig(session.id, { provider, model: "test-model", snapshotMode: "manual" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  return { root, sessions, sessionId: session.id, pricing, providers: new ProviderRegistry(), events: new EventBus() };
}

describe("AgentRunner failure resilience", () => {
  it("persists an accepted user message and returns idle when Core configuration fails", async () => {
    const harness = await setup();
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));
    const runner = new AgentRunner(
      harness.sessions,
      harness.providers,
      makeFakeCore({ configureSession: async () => { throw new Error("sandbox configuration denied"); } }),
      harness.events,
      harness.pricing,
    );

    await expect(runner.run(harness.sessionId, "核心配置失败也不能丢消息")).rejects.toThrow("sandbox configuration denied");

    expect((await harness.sessions.get(harness.sessionId))?.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "核心配置失败也不能丢消息" }] },
    ]);
    expect(runner.isRunning(harness.sessionId)).toBe(false);
    await expect(runner.getRun(harness.sessionId)).resolves.toMatchObject({
      sessionId: harness.sessionId,
      state: "failed",
      turnIndex: 0,
      error: { code: "run_failed", message: "sandbox configuration denied", retryable: false },
    });
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.error", payload: expect.objectContaining({ message: "sandbox configuration denied" }) }),
      expect.objectContaining({ type: "run.failed", payload: expect.objectContaining({ state: "failed" }) }),
      expect.objectContaining({ type: "agent.state", payload: { state: "idle" } }),
    ]));
  });

  it("persists the user message and clears running state when the provider fails", async () => {
    const harness = await setup("broken");
    harness.providers.register({
      name: "broken",
      async *streamChat() {
        throw new Error("provider unavailable");
      },
    });
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));
    const runner = new AgentRunner(harness.sessions, harness.providers, makeFakeCore(), harness.events, harness.pricing);

    await expect(runner.run(harness.sessionId, "Provider 出错后仍应保留")).rejects.toThrow("provider unavailable");

    const detail = await harness.sessions.get(harness.sessionId);
    expect(detail?.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "Provider 出错后仍应保留" }] },
    ]);
    expect(detail?.messages).toHaveLength(1);
    expect(runner.isRunning(harness.sessionId)).toBe(false);
    expect(observed.some((event) => event.type === "agent.error")).toBe(true);
    expect(observed.filter((event) => event.type === "agent.state").at(-1)?.payload).toEqual({ state: "idle" });
  });

  it("tags agent.error with the classified kind and retryable=false for an authentication failure", async () => {
    const harness = await setup("broken");
    harness.providers.register({
      name: "broken",
      async *streamChat() {
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      },
    });
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));
    const runner = new AgentRunner(harness.sessions, harness.providers, makeFakeCore(), harness.events, harness.pricing);

    await expect(runner.run(harness.sessionId, "401 需要分类提示")).rejects.toThrow("invalid api key");

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.error",
        payload: expect.objectContaining({ message: "invalid api key", kind: "authentication", retryable: false }),
      }),
    ]));
    await expect(runner.getRun(harness.sessionId)).resolves.toMatchObject({
      state: "failed",
      error: { code: "run_failed", message: "invalid api key", retryable: false },
    });
  });

  it("tags agent.error with kind=rate_limit and retryable=true after retry exhaustion", async () => {
    const harness = await setup("broken");
    let calls = 0;
    harness.providers.register({
      name: "broken",
      async *streamChat() {
        calls += 1;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
    });
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));
    const runner = new AgentRunner(harness.sessions, harness.providers, makeFakeCore(), harness.events, harness.pricing);

    await expect(runner.run(harness.sessionId, "限流耗尽后标记可重试")).rejects.toThrow("rate limited");

    expect(calls).toBe(3);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.error",
        payload: expect.objectContaining({ message: "rate limited", kind: "rate_limit", retryable: true }),
      }),
    ]));
    await expect(runner.getRun(harness.sessionId)).resolves.toMatchObject({
      state: "failed",
      error: { code: "run_failed", message: "rate limited", retryable: true },
    });
  });

  it("converts a tool preflight exception into one persisted tool_result and continues the turn", async () => {
    const harness = await setup();
    let turn = 0;
    const provider: Provider = {
      name: "test",
      async *streamChat() {
        if (turn++ === 0) {
          yield { type: "tool_call", id: "pre-hook-failure", name: "read_file", input: { path: "README.md" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "工具错误已收到，继续完成。" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    harness.providers.register(provider);
    const throwingHooks = {
      async run(event: string) {
        if (event === "PreToolUse") throw new Error("pre-tool hook crashed");
        return {};
      },
    } as unknown as HookRunner;
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));
    const runner = new AgentRunner(
      harness.sessions,
      harness.providers,
      makeFakeCore(),
      harness.events,
      harness.pricing,
      undefined, // exchange rates
      "zh-CN",
      50,
      undefined, // profile
      undefined, // usage log
      undefined, // skills
      undefined, // MCP
      undefined, // compactor
      undefined, // data dir
      undefined, // agent registry
      undefined, // command registry
      undefined, // search
      undefined, // fetch
      undefined, // background tasks
      throwingHooks,
    );

    await runner.run(harness.sessionId, "测试工具前置失败");

    const detail = await harness.sessions.get(harness.sessionId);
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(detail?.messages[2]?.content).toEqual([
      expect.objectContaining({ type: "tool_result", toolCallId: "pre-hook-failure", isError: true, content: "pre-tool hook crashed" }),
    ]);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.end", payload: expect.objectContaining({ toolCallId: "pre-hook-failure", error: "pre-tool hook crashed" }) }),
    ]));
    expect(observed.some((event) => event.type === "agent.error")).toBe(false);
    expect(runner.isRunning(harness.sessionId)).toBe(false);
  });

  it("records ! shell input and a tool error when Core configuration fails", async () => {
    const harness = await setup();
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));
    const runner = new AgentRunner(
      harness.sessions,
      harness.providers,
      makeFakeCore({ configureSession: async () => { throw new Error("shell sandbox unavailable"); } }),
      harness.events,
      harness.pricing,
    );

    await runner.runShell(harness.sessionId, "dir");

    const detail = await harness.sessions.get(harness.sessionId);
    expect(detail?.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "!dir" }] },
      { role: "tool", content: [{ type: "tool_result", isError: true, content: "shell sandbox unavailable" }] },
    ]);
    expect(runner.isShellPending(harness.sessionId)).toBe(false);
    expect(observed.some((event) => event.type === "agent.error")).toBe(true);
  });
});

/** jobControl 挂起 job 的 fake core：job 一直 running，cancelJob 后转为 cancelled（复刻真实中断链路）。 */
function makeHangingJobCore(): { core: CoreClientLike; started: () => number } {
  let cancelled = false;
  let started = 0;
  const status = (): JobStatus => cancelled
    ? { jobId: "job-1", state: "cancelled", error: "Job cancelled" }
    : { jobId: "job-1", state: "running" };
  const core = makeFakeCore({
    async start() { return { ...FAKE_CORE_INFO, features: { ...FAKE_CORE_INFO.features, jobControl: true } }; },
    async ping() { return { ...FAKE_CORE_INFO, features: { ...FAKE_CORE_INFO.features, jobControl: true } }; },
    async startJob() { started++; return status(); },
    async jobStatus() { return status(); },
    async jobOutput() { return { chunks: [], nextSeq: 0, truncated: false }; },
    async cancelJob() { cancelled = true; return { jobId: "job-1", accepted: true as const }; },
  });
  return { core, started: () => started };
}

describe("中断后 tool_result 补写", () => {
  it("挂起的 bash 被中断：已落盘 tool_call 补写错误 tool_result，历史保持配对", async () => {
    const { core, started } = makeHangingJobCore();
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        yield { type: "tool_call", id: "hang-1", name: "bash", input: { cmd: "sleep 600" } };
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const harness = await makeAgentHarness({ provider, core, model: "model", permissionMode: "yolo", tempPrefix: "owc-abort-backfill-" });
    try {
      const run = harness.agent.run(harness.session.id, "跑个长任务");
      // 等 bash 真正进入 core job（assistant 的 tool_call 已落盘、工具在途）
      await vi.waitFor(() => expect(started()).toBe(1), { timeout: 5000 });
      expect(harness.agent.abort(harness.session.id)).toBe(true);
      // abort 路径 run() 会 rethrow（agent.aborted 语义）
      await run.then(() => undefined, () => undefined);
      const detail = await harness.sessions.get(harness.session.id);
      const result = toolResultOf(detail, "hang-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect((result as { content: string }).content).toContain("interrupted");
    } finally {
      await harness.app.close();
    }
  });
});

// ---- steering 组（合并） ----
describe("AgentRunner steering", () => {
  it("starts one durable follow-up after the current run reaches a natural stop", async () => {
    const root = await tempRoot("owc-follow-up-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "steering",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) {
          entered();
          await gate;
        }
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const initial = runner.run(session.id, "initial task");
    await firstEntered;
    const followUp = await runner.enqueueFollowUp(session.id, "continue with tests", "retry-safe-id");
    const duplicate = await runner.enqueueFollowUp(session.id, "continue with tests", "retry-safe-id");
    expect(duplicate).toMatchObject({ id: followUp.id, reused: true });
    release();
    await initial;
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(async () => expect((await sessions.get(session.id))?.messages.some((message) =>
      message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "continue with tests"))).toBe(true));
    await vi.waitFor(async () => {
      expect(runner.isRunning(session.id)).toBe(false);
      expect((await runner.getRun(session.id))?.state).toBe("completed");
    }, { timeout: 5_000 });
  });

  it("queues messages during a provider turn and applies them at the next safe boundary", async () => {
    const root = await tempRoot("owc-steering-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let allowFirstToFinish!: () => void;
    const gate = new Promise<void>((resolve) => { allowFirstToFinish = resolve; });
    const requests: StreamChatRequest[] = [];
    let turn = 0;
    const provider: Provider = {
      name: "steering",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          releaseFirst();
          await gate;
        }
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
    } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    const queued = await runner.enqueueSteering(session.id, "use the safer parser");
    expect(queued.position).toBe(1);
    expect(await runner.listSteering(session.id)).toHaveLength(1);
    allowFirstToFinish();
    await running;

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text === "use the safer parser"))).toBe(true);
    expect(await runner.listSteering(session.id)).toEqual([]);
    expect(published.map((event) => event.type)).toEqual(expect.arrayContaining(["steering.queued", "steering.applied"]));
  });

  it("removes a queued message before it is applied", async () => {
    const root = await tempRoot("owc-steering-remove-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const provider: Provider = { name: "steering", async *streamChat() { entered(); await gate; yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    const queued = await runner.enqueueSteering(session.id, "remove me");
    expect(await runner.removeSteering(session.id, queued.id)).toBe(true);
    finish();
    await running;
    expect((await sessions.get(session.id))?.messages.some((message) =>
      message.content.some((block) => block.type === "text" && block.text === "remove me"))).toBe(false);
  });

  it("preserves the unapplied steering queue when the run is aborted", async () => {
    const root = await tempRoot("owc-steering-abort-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const { provider, entered: firstEntered } = makeAbortPendingProvider("steering");
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    await runner.enqueueSteering(session.id, "saved for retry");
    expect(runner.abort(session.id)).toBe(true);
    await expect(running).rejects.toBeTruthy();
    // abort 保留未应用 steering，用户可在 idle 后重新入队/编辑
    expect((await runner.listSteering(session.id)).map((item) => item.content)).toEqual(["saved for retry"]);
  });

  it("rejects an over-long steering message with a too_long error", async () => {
    const root = await tempRoot("owc-steering-long-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "steering", model: "claude-opus-4-8" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const provider: Provider = { name: "steering", async *streamChat() { entered(); await gate; yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    const running = runner.run(session.id, "initial task");
    await firstEntered;
    const oversized = "x".repeat(8_001);
    await expect(runner.enqueueSteering(session.id, oversized)).rejects.toThrow(/exceeds/);
    finish();
    await running;
  });
});

// ---- agent-file-tools 组（合并） ----
describe("AgentRunner file tools", () => {
  it("exposes and executes dedicated file tools through CoreClient", async () => {
    const root = await tempRoot("owc-agent-fs-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "files", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "acceptEdits", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const calls: Array<{ sessionId: string; path: string; oldText: string; newText: string }> = [];
    const core = makeFakeCore({
      async editFile(request: { sessionId: string; path: string; oldText: string; newText: string }) { calls.push(request); return { matches: 1 }; },
    });
    let turn = 0;
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "files",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          yield { type: "tool_call", id: "edit-1", name: "edit_file", input: { path: "src/a.ts", oldText: "a", newText: "b" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "edit it");

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "glob", "grep"]));
    expect(calls).toEqual([{ sessionId: session.id, path: "src/a.ts", oldText: "a", newText: "b" }]);
    const detail = await sessions.get(session.id);
    expect(await new GitShadowSnapshots(sessions.contextRoot(session.id), root).list()).toHaveLength(1);
    expect(detail?.messages.some((message) => message.role === "tool" && message.content.some((block) => block.type === "tool_result" && block.content.includes('"matches":1')))).toBe(true);
  });

  it("write_file/edit_file 成功后广播 scm.updated（SCM 面板自动刷新，阶段 2b）", async () => {
    const root = await tempRoot("owc-agent-scm-event-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "files", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "acceptEdits", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const core = makeFakeCore();
    let turn = 0;
    const provider: Provider = {
      name: "files",
      async *streamChat() {
        if (turn++ === 0) {
          yield { type: "tool_call", id: "write-1", name: "write_file", input: { path: "src/new.ts", content: "export {};\n" } };
          yield { type: "tool_call", id: "edit-1", name: "edit_file", input: { path: "src/a.ts", oldText: "a", newText: "b" } };
          yield { type: "tool_call", id: "read-1", name: "read_file", input: { path: "src/a.ts" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const published: Array<{ type: string; sessionId?: string; payload: unknown }> = [];
    events.on("event", (event: { type: string; sessionId?: string; payload: unknown }) => published.push(event));
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    await runner.run(session.id, "write then edit");

    const scmEvents = published.filter((event) => event.type === "scm.updated");
    // write_file 与 edit_file 各发一次；read_file 不发
    expect(scmEvents).toHaveLength(2);
    expect(scmEvents[0]).toMatchObject({ sessionId: session.id, payload: { sessionId: session.id, reason: "file.write", path: "src/new.ts" } });
    expect(scmEvents[1]).toMatchObject({ sessionId: session.id, payload: { sessionId: session.id, reason: "file.write", path: "src/a.ts" } });
  });

  it("defaults glob/grep path to the session root when omitted", async () => {
    const root = await tempRoot("owc-agent-glob-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "files", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "acceptEdits", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const calls: Array<{ sessionId: string; path: string; pattern: string }> = [];
    const core = makeFakeCore({
      async globFiles(request: { sessionId: string; path: string; pattern: string }) { calls.push(request); return { paths: ["a.ts"], truncated: false }; },
    });
    let turn = 0;
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "files",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          yield { type: "tool_call", id: "glob-1", name: "glob", input: { pattern: "**/*.ts" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "list files");

    // schema 不再要求 path；缺省按会话根（"."）下发 core
    const globSchema = requests[0]?.tools.find((tool) => tool.name === "glob");
    expect(globSchema?.inputSchema.required).toEqual(["pattern"]);
    expect(calls).toEqual([{ sessionId: session.id, path: ".", pattern: "**/*.ts" }]);
  });
});
