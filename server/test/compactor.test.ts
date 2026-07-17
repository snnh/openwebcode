import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { Compactor, extractInstructions } from "../src/context/compactor.js";
import { ContextManager } from "../src/context/context-manager.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import type { Provider2Client } from "../src/provider2.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { UsageLog } from "../src/usage-log.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-compact-"));
  roots.push(root);
  return root;
}

function fakeProvider2(text: string, calls: Array<{ system: string; prompt: string }>): Provider2Client {
  return {
    configured: true,
    model: "fake-cheap-model",
    setConfig() { /* noop */ },
    async complete(input: { system: string; prompt: string }) {
      calls.push(input);
      return { text, usage: { inputTokens: 120, outputTokens: 30 } };
    },
  } as unknown as Provider2Client;
}

const EMPTY_PROVIDER2 = { configured: false, model: undefined, setConfig() { /* noop */ } } as unknown as Provider2Client;

async function sessionWithMessages(store: SessionStore, count: number): Promise<string> {
  const session = await store.create({ cwd: os.tmpdir(), provider: "development", title: "压缩样例" });
  for (let index = 0; index < count; index += 1) {
    await store.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
  }
  return session.id;
}

describe("extractInstructions", () => {
  it("parses the 用户明确指令 section", () => {
    const text = "目标：\n- 做压缩\n\n用户明确指令：\n- 不许删文件\n- 用中文回复\n\n未决事项：\n- 无\n";
    expect(extractInstructions(text)).toEqual(["不许删文件", "用中文回复"]);
    expect(extractInstructions("目标：\n- 无指令")).toEqual([]);
  });
});

describe("Compactor", () => {
  it("overview compacts the prefix and pins accumulated instructions in the view", async () => {
    const root = await tempDir();
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string }> = [];
    const usageLog = new UsageLog(root);
    const compactor = new Compactor(store, fakeProvider2("目标：\n- 测试\n用户明确指令：\n- 用中文\n", calls), { usageLog }, 10);

    const result = await compactor.compact(id, "overview");
    expect(result).toMatchObject({ changed: true, mode: "overview", uptoIndex: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("消息 1");

    const context = new ContextManager(store.contextRoot(id));
    const detail = (await store.get(id))!;
    const view = await context.buildView(detail.messages);
    expect(view.messages[0]).toMatchObject({ role: "user" });
    expect(view.messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("用户明确指令（跨段累积") });
    expect(view.messages[0]!.content[0]).toMatchObject({ text: expect.stringContaining("- 用中文") });
    expect(view.messages).toHaveLength(1 + 10);
    // provider2 用量进报表
    const report = await usageLog.report();
    expect(report.sessions[0]?.providers[0]).toMatchObject({ provider: "provider2", model: "fake-cheap-model", inputTokens: 120 });

    // 第二次压缩：指令累积且去重
    await store.appendMessage(id, "user", [{ type: "text", text: "消息 16" }]);
    const second = await compactor.compact(id, "overview");
    expect(second.changed).toBe(true);
    const ledger = await context.load();
    expect(ledger.compacted?.instructions).toEqual(["用中文"]);
  });

  it("falls back to rule-based toolcalls without provider2; overview requires provider2 unless forced", async () => {
    const root = await tempDir();
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: os.tmpdir(), provider: "development", title: "压缩样例" });
    // 工具消息放最前，确保落在压缩区段内
    await store.appendMessage(session.id, "assistant", [
      { type: "tool_call", id: "t1", name: "bash", input: { cmd: "npm test" } },
    ]);
    await store.appendMessage(session.id, "tool", [{ type: "tool_result", toolCallId: "t1", content: "ok" }]);
    for (let index = 0; index < 15; index += 1) {
      await store.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
    }
    const compactor = new Compactor(store, EMPTY_PROVIDER2, {}, 10);

    await expect(compactor.compact(session.id, "overview")).rejects.toThrow(/provider2 未配置/);

    const toolcalls = await compactor.compact(session.id, "toolcalls");
    expect(toolcalls).toMatchObject({ changed: true, mode: "toolcalls" });
    expect(toolcalls.summary).toContain("[规则压缩]");
    expect(toolcalls.summary).toContain("bash");

    // 区段耗尽后不再重复压缩
    const again = await compactor.compact(session.id, "toolcalls");
    expect(again.changed).toBe(false);
  });

  it("forced overview without provider2 degrades to truncated and clears pins", async () => {
    const root = await tempDir();
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const context = new ContextManager(store.contextRoot(id));
    const ledger = await context.load();
    ledger.entries.push({ messageId: "m", kind: "tool_result", artifactId: "a", state: "restored", createdRound: 0, pinnedUntilRound: 99 });
    await context.save(ledger);

    const compactor = new Compactor(store, EMPTY_PROVIDER2, {}, 10);
    const result = await compactor.compact(id, "overview", { forced: true });
    expect(result.mode).toBe("truncated");
    expect((await context.load()).entries[0]?.pinnedUntilRound).toBe(0);
  });
});

describe("85% watermark forced compaction", () => {
  it("force-compacts before the provider call when utilization hits 0.85", async () => {
    const root = await tempDir();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "anthropic",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const compactor = new Compactor(sessions, fakeProvider2("概览：\n- 早段已压缩\n", []), {}, 2);
    const tinyWindow = () => ({ contextWindow: 100, maxOutput: 10, capabilities: { thinking: ["disabled"], effort: [] } }) as never;
    const runner = new AgentRunner(sessions, providers, core, events, pricing, undefined, "zh-CN", 50, tinyWindow, undefined, undefined, undefined, compactor);
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息，占位占位占位占位" }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复，占位占位占位占位" }]);

    await runner.run(session.id, "新的问题，也占一些 token 让水位超过 85%");

    const compactedEvents = published.filter((event) => event.type === "context.compacted");
    expect(compactedEvents).toHaveLength(1);
    expect(compactedEvents[0]?.payload).toMatchObject({ forced: true });
    // provider 收到的视图首条是压缩摘要而非原始消息
    expect(requests.at(-1)?.messages[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Earlier context compacted") });
  });
});

describe("compact HTTP routes", () => {
  it("serves POST /compact and the /compact composer command", async () => {
    const root = await tempDir();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const core = { on() { return core; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const compactor = new Compactor(sessions, EMPTY_PROVIDER2, {}, 3);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, compactor });
    try {
      const session = await sessions.create({ cwd: os.tmpdir(), title: "HTTP 压缩" });
      for (let index = 0; index < 5; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `消息 ${index + 1}` }]);
      }

      const rest = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/compact`, payload: { mode: "toolcalls" } });
      expect(rest.statusCode).toBe(200);
      expect(rest.json<{ changed: boolean; uptoIndex?: number }>()).toMatchObject({ changed: true, uptoIndex: 2 });

      for (let index = 0; index < 4; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `再来 ${index + 1}` }]);
      }
      const slash = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/compact tools" } });
      expect(slash.statusCode).toBe(200);
      expect(slash.json<{ compacted: boolean }>().compacted).toBe(true);

      // 再补 4 条制造可压缩区段，未配置 provider2 的 overview 应 400
      for (let index = 0; index < 4; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `还有 ${index + 1}` }]);
      }
      const overview = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/compact" } });
      expect(overview.statusCode).toBe(400);
      expect(overview.json<{ error: string }>().error).toContain("provider2 未配置");
    } finally {
      await app.close();
    }
  });
});
