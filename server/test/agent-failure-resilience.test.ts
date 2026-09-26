import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike, JobStatus } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import type { HookRunner } from "../src/hooks.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";
import { makeAbortPendingProvider, makeAgentHarness, toolResultOf } from "./helpers/agent-harness.js";
import { FAKE_CORE_INFO, makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

interface RigOptions {
  provider: Provider;
  core?: CoreClientLike;
  model?: string;
  permissionMode?: "yolo" | "acceptEdits";
  config?: Record<string, unknown>;
  snapshotMode?: "auto"; // 打开自动检查点（默认 manual，排除真实 GitShadow 干扰）
}

async function rig(options: RigOptions) {
  const root = await tempRoot("owc-agent-failure-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const model = options.model ?? "test-model";
  const session = await sessions.create({ cwd: root, provider: options.provider.name, model });
  await sessions.updateConfig(session.id, {
    provider: options.provider.name, model, ...(options.snapshotMode === "auto" ? {} : { snapshotMode: "manual" }), ...options.config,
  });
  if (options.permissionMode) await sessions.updatePermissions(session.id, options.permissionMode, []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const seen: AppEvent[] = [];
  events.on("event", (event) => seen.push(event));
  const providers = new ProviderRegistry();
  providers.register(options.provider);
  const core = options.core ?? makeFakeCore();
  const runner = new AgentRunner(sessions, providers, core, events, pricing);
  return { root, sessions, session, events, seen, providers, pricing, core, runner };
}

const throwingProvider = (name: string, error: unknown): Provider => ({
  name,
  async *streamChat() { throw error; },
});

/** 跑一轮即挂起的 provider（gate 在测试里放行）：run 仍在途时制造「运行中」窗口，requests 收集收到的请求。 */
async function gatedRig(requests: StreamChatRequest[] = []) {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider: Provider = {
    name: "steering",
    async *streamChat(request) {
      requests.push(request);
      if (requests.length === 1) { markEntered(); await gate; }
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  const harness = await rig({ provider, model: "claude-opus-4-8" });
  return { ...harness, entered, release };
}

describe("AgentRunner failure resilience", () => {
  it("Core 配置失败 / provider 失败 / 401 / 429 重试耗尽：保留用户消息、清 running、按分类落 run.failed", async () => {
    const cases: Array<{ name: string; core?: CoreClientLike; error: Error & { status?: number }; text: string; kind?: string; retryable: boolean }> = [
      { name: "Core 配置失败", core: makeFakeCore({ configureSession: async () => { throw new Error("sandbox configuration denied"); } }), error: new Error("sandbox configuration denied"), text: "核心配置失败也不能丢消息", retryable: false },
      { name: "provider 不可用", error: new Error("provider unavailable"), text: "Provider 出错后仍应保留", retryable: false },
      { name: "鉴权失败", error: Object.assign(new Error("invalid api key"), { status: 401 }), text: "401 需要分类提示", kind: "authentication", retryable: false },
      { name: "限流耗尽重试", error: Object.assign(new Error("rate limited"), { status: 429 }), text: "限流耗尽后标记可重试", kind: "rate_limit", retryable: true },
    ];

    for (const item of cases) {
      const harness = await rig({ provider: throwingProvider("broken", item.error), core: item.core });
      await expect(harness.runner.run(harness.session.id, item.text), item.name).rejects.toThrow(item.error.message);

      expect((await harness.sessions.get(harness.session.id))?.messages, item.name).toMatchObject([{ role: "user", content: [{ type: "text", text: item.text }] }]);
      expect(harness.runner.isRunning(harness.session.id), item.name).toBe(false);
      await expect(harness.runner.getRun(harness.session.id), item.name).resolves.toMatchObject({
        sessionId: harness.session.id, state: "failed", turnIndex: 0,
        error: { code: "run_failed", message: item.error.message, retryable: item.retryable },
      });
      expect(harness.seen, item.name).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "agent.error", payload: expect.objectContaining({ message: item.error.message, retryable: item.retryable, ...(item.kind ? { kind: item.kind } : {}) }) }),
        expect.objectContaining({ type: "run.failed", payload: expect.objectContaining({ state: "failed" }) }),
        expect.objectContaining({ type: "agent.state", payload: { state: "idle" } }),
      ]));
    }
  }, 30_000);

  it("!shell 在 Core 配置失败时仍记录输入与 error tool_result", async () => {
    const harness = await rig({
      provider: throwingProvider("unused", new Error("unused")),
      core: makeFakeCore({ configureSession: async () => { throw new Error("shell sandbox unavailable"); } }),
    });
    await harness.runner.runShell(harness.session.id, "dir");

    expect((await harness.sessions.get(harness.session.id))?.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "!dir" }] },
      { role: "tool", content: [{ type: "tool_result", isError: true, content: "shell sandbox unavailable" }] },
    ]);
    expect(harness.runner.isShellPending(harness.session.id)).toBe(false);
    expect(harness.seen.some((event) => event.type === "agent.error")).toBe(true);
  });

  it("工具前置钩子抛错：转成一条 error tool_result 后继续 turn，不中断 run", async () => {
    let turn = 0;
    const provider: Provider = {
      name: "test",
      async *streamChat() {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "pre-hook-failure", name: "read_file", input: { path: "README.md" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "工具错误已收到，继续完成。" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const harness = await rig({ provider, config: { permissionMode: "yolo" } });
    const throwingHooks = {
      async run(event: string) { if (event === "PreToolUse") throw new Error("pre-tool hook crashed"); return {}; },
    } as unknown as HookRunner;
    const runner = new AgentRunner(
      harness.sessions, harness.providers, harness.core, harness.events, harness.pricing,
      undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, throwingHooks,
    );

    await runner.run(harness.session.id, "测试工具前置失败");

    const detail = await harness.sessions.get(harness.session.id);
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(detail?.messages[2]?.content).toEqual([
      expect.objectContaining({ type: "tool_result", toolCallId: "pre-hook-failure", isError: true, content: "pre-tool hook crashed" }),
    ]);
    expect(harness.seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.end", payload: expect.objectContaining({ toolCallId: "pre-hook-failure", error: "pre-tool hook crashed" }) }),
    ]));
    expect(harness.seen.some((event) => event.type === "agent.error")).toBe(false);
    expect(runner.isRunning(harness.session.id)).toBe(false);
  });

  it("挂起的 bash 被中断：已落盘 tool_call 补写错误 tool_result，历史保持配对", async () => {
    let cancelled = false;
    let started = 0;
    const status = (): JobStatus => cancelled ? { jobId: "job-1", state: "cancelled", error: "Job cancelled" } : { jobId: "job-1", state: "running" };
    const jobControl = { ...FAKE_CORE_INFO.features, jobControl: true };
    const core = makeFakeCore({
      async start() { return { ...FAKE_CORE_INFO, features: jobControl }; },
      async ping() { return { ...FAKE_CORE_INFO, features: jobControl }; },
      async startJob() { started++; return status(); },
      async jobStatus() { return status(); },
      async jobOutput() { return { chunks: [], nextSeq: 0, truncated: false }; },
      async cancelJob() { cancelled = true; return { jobId: "job-1", accepted: true as const }; },
    });
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
      await vi.waitFor(() => expect(started).toBe(1), { timeout: 5000 });
      expect(harness.agent.abort(harness.session.id)).toBe(true);
      await run.then(() => undefined, () => undefined); // abort 路径 run() 会 rethrow（agent.aborted 语义）
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "hang-1");
      expect(result).toMatchObject({ isError: true });
      expect((result as { content: string }).content).toContain("interrupted");
    } finally {
      await harness.app.close();
    }
  }, 20_000);
});

describe("AgentRunner steering / follow-up", () => {
  it("follow-up 幂等入队并在当前 run 自然收尾后被执行", async () => {
    const requests: StreamChatRequest[] = [];
    const harness = await gatedRig(requests);

    const initial = harness.runner.run(harness.session.id, "initial task");
    await harness.entered;
    const followUp = await harness.runner.enqueueFollowUp(harness.session.id, "continue with tests", "retry-safe-id");
    expect(await harness.runner.enqueueFollowUp(harness.session.id, "continue with tests", "retry-safe-id")).toMatchObject({ id: followUp.id, reused: true });
    harness.release();
    await initial;

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(async () => expect((await harness.sessions.get(harness.session.id))?.messages.some((message) =>
      message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "continue with tests"))).toBe(true));
    await vi.waitFor(async () => expect((await harness.runner.getRun(harness.session.id))?.state).toBe("completed"), { timeout: 5_000 });
  }, 20_000);

  it("steering 排队消息在下一个安全边界应用并广播事件；应用前可撤回", async () => {
    const requests: StreamChatRequest[] = [];
    const { session, seen, runner, entered, release } = await gatedRig(requests);

    const running = runner.run(session.id, "initial task");
    await entered;
    await runner.enqueueSteering(session.id, "use the safer parser");
    expect(await runner.listSteering(session.id)).toHaveLength(1);
    release();
    await running;

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text === "use the safer parser"))).toBe(true);
    expect(await runner.listSteering(session.id)).toEqual([]);
    expect(seen.map((event) => event.type)).toEqual(expect.arrayContaining(["steering.queued", "steering.applied"]));

    const second = await gatedRig(); // 应用前撤回：消息不得进入历史
    const runningSecond = second.runner.run(second.session.id, "initial task");
    await second.entered;
    const removed = await second.runner.enqueueSteering(second.session.id, "remove me");
    expect(await second.runner.removeSteering(second.session.id, removed.id)).toBe(true);
    second.release();
    await runningSecond;
    expect((await second.sessions.get(second.session.id))?.messages.some((message) =>
      message.content.some((block) => block.type === "text" && block.text === "remove me"))).toBe(false);
  }, 20_000);

  it("run 中止时保留未应用的 steering 队列；超长消息以 too_long 拒绝", async () => {
    const { provider, entered } = makeAbortPendingProvider("steering");
    const harness = await rig({ provider, model: "claude-opus-4-8" });
    const running = harness.runner.run(harness.session.id, "initial task");
    await entered;
    await harness.runner.enqueueSteering(harness.session.id, "saved for retry");
    expect(harness.runner.abort(harness.session.id)).toBe(true);
    await expect(running).rejects.toBeTruthy();
    expect((await harness.runner.listSteering(harness.session.id)).map((item) => item.content)).toEqual(["saved for retry"]);

    const oversize = await gatedRig();
    const busy = oversize.runner.run(oversize.session.id, "initial task");
    await oversize.entered;
    await expect(oversize.runner.enqueueSteering(oversize.session.id, "x".repeat(8_001))).rejects.toThrow(/exceeds/);
    oversize.release();
    await busy;
  }, 20_000);
});

describe("AgentRunner file tools", () => {
  it("write/edit 经 CoreClient 执行并落 tool_result、成功各广播 scm.updated；glob 缺省下发会话根（\".\"）", async () => {
    const edits: Array<{ sessionId: string; path: string; oldText: string; newText: string }> = [];
    const globs: Array<{ sessionId: string; path: string; pattern: string }> = [];
    const core = makeFakeCore({
      async editFile(request: { sessionId: string; path: string; oldText: string; newText: string }) { edits.push(request); return { matches: 1 }; },
      async globFiles(request: { sessionId: string; path: string; pattern: string }) { globs.push(request); return { paths: ["a.ts"], truncated: false }; },
    });
    let turn = 0;
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "files",
      async *streamChat(request) {
        requests.push(request);
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "write-1", name: "write_file", input: { path: "src/new.ts", content: "export {};\n" } };
          yield { type: "tool_call", id: "edit-1", name: "edit_file", input: { path: "src/a.ts", oldText: "a", newText: "b" } };
          yield { type: "tool_call", id: "read-1", name: "read_file", input: { path: "src/a.ts" } };
        } else if (turn === 2) {
          yield { type: "tool_call", id: "edit-2", name: "edit_file", input: { path: "src/a.ts", oldText: "b", newText: "c" } };
        } else if (turn === 3) {
          yield { type: "tool_call", id: "glob-1", name: "glob", input: { pattern: "**/*.ts" } };
        } else {
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const harness = await rig({ provider, core, model: "claude-opus-4-8", permissionMode: "acceptEdits", snapshotMode: "auto" });
    await harness.runner.run(harness.session.id, "write, edit then list");

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "glob", "grep"]));
    expect(edits).toEqual([
      { sessionId: harness.session.id, path: "src/a.ts", oldText: "a", newText: "b" },
      { sessionId: harness.session.id, path: "src/a.ts", oldText: "b", newText: "c" },
    ]);
    expect(await new GitShadowSnapshots(harness.sessions.contextRoot(harness.session.id), harness.root).list()).toHaveLength(1);
    const messages = (await harness.sessions.get(harness.session.id))?.messages ?? [];
    expect(messages.some((message) => message.role === "tool" && message.content.some((block) =>
      block.type === "tool_result" && block.content.includes("\"matches\":1")))).toBe(true);
    expect(requests[0]?.tools.find((tool) => tool.name === "glob")?.inputSchema.required).toEqual(["pattern"]);
    expect(globs).toEqual([{ sessionId: harness.session.id, path: ".", pattern: "**/*.ts" }]);
    const scm = harness.seen.filter((event) => event.type === "scm.updated");
    expect(scm).toHaveLength(3);
    expect(scm.map((event) => (event.payload as { path?: string }).path)).toEqual(["src/new.ts", "src/a.ts", "src/a.ts"]);
  }, 20_000);
});
