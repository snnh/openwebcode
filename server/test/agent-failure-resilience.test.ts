import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import type { HookRunner } from "../src/hooks.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function makeCore(configureSession: () => Promise<unknown> = async () => ({ sandboxCapability: "advisory" })): CoreClientLike {
  const client = {
    on() { return client; },
    configureSession,
  };
  return client as unknown as CoreClientLike;
}

async function setup(provider = "test"): Promise<{ root: string; sessions: SessionStore; sessionId: string; pricing: PricingCatalog; providers: ProviderRegistry; events: EventBus }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-agent-failure-"));
  roots.push(root);
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
      makeCore(async () => { throw new Error("sandbox configuration denied"); }),
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
    const runner = new AgentRunner(harness.sessions, harness.providers, makeCore(), harness.events, harness.pricing);

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
    const runner = new AgentRunner(harness.sessions, harness.providers, makeCore(), harness.events, harness.pricing);

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
    const runner = new AgentRunner(harness.sessions, harness.providers, makeCore(), harness.events, harness.pricing);

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
      makeCore(),
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
      makeCore(async () => { throw new Error("shell sandbox unavailable"); }),
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
