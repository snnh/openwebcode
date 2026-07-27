import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, SPAWN_SWARM_MAX_ITEMS } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-swarm-"));
  roots.push(root);
  return root;
}

function createFakeCore(): CoreClientLike {
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile() { return { content: "文件内容" }; },
    async globFiles() { return { matches: [] }; },
    async grepFiles() { return { matches: [] }; },
  };
  return core as unknown as CoreClientLike;
}

interface SwarmFixture {
  sessions: SessionStore;
  runner: AgentRunner;
  captured: AppEvent[];
  requests: StreamChatRequest[];
  sessionId: string;
}

/** 主循环第一轮调用 spawn_swarm；子代理按用户消息里的 item 回结论；failOn 命中的 item 抛错 */
async function setupSwarm(input: Record<string, unknown>, failOn?: string): Promise<SwarmFixture> {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const captured: AppEvent[] = [];
  events.on("event", (event: AppEvent) => captured.push(event));

  const requests: StreamChatRequest[] = [];
  let mainTurn = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(request) {
      requests.push(request);
      if (request.system.includes("exploration sub-agent")) {
        const last = request.messages.at(-1);
        const text = last?.content.find((block) => block.type === "text");
        const prompt = text?.type === "text" ? text.text : "";
        if (failOn && prompt.includes(failOn)) throw new Error("provider boom");
        yield { type: "text_delta", text: `结论：${prompt}` };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      if (mainTurn++ === 0) {
        yield { type: "tool_call", id: "swarm-1", name: "spawn_swarm", input };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const runner = new AgentRunner(sessions, providers, createFakeCore(), events, pricing);
  return { sessions, runner, captured, requests, sessionId: session.id };
}

async function swarmToolResult(fixture: SwarmFixture) {
  const detail = await fixture.sessions.get(fixture.sessionId);
  return detail?.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.toolCallId === "swarm-1");
}

describe("spawn_swarm via AgentRunner", () => {
  it("runs items in parallel and aggregates numbered conclusions", async () => {
    const fixture = await setupSwarm({ prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts", "c.ts"] });
    await fixture.runner.run(fixture.sessionId, "并行评审");

    const toolResult = await swarmToolResult(fixture);
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false });
    const content = (toolResult as { content: string }).content;
    expect(content).toContain("[1/3] 结论：评审 a.ts");
    expect(content).toContain("[2/3] 结论：评审 b.ts");
    expect(content).toContain("[3/3] 结论：评审 c.ts");

    // 三个子代理转录 + 三个 started/finished 事件（带 swarm 序号）
    const contextRoot = fixture.sessions.contextRoot(fixture.sessionId);
    expect(await readdir(path.join(contextRoot, "subagents"))).toHaveLength(3);
    const started = fixture.captured.filter((event) => event.type === "subagent.started");
    expect(started).toHaveLength(3);
    expect(started.map((event) => (event.payload as { swarm?: { index: number } }).swarm?.index).sort()).toEqual([1, 2, 3]);
    expect(fixture.captured.filter((event) => event.type === "subagent.finished")).toHaveLength(3);

    // 工具结果携带转录 id；tool.end 汇总 total/failed
    const ids = (toolResult as { subagentTaskIds?: string[] }).subagentTaskIds;
    expect(ids).toHaveLength(3);
    const toolEnd = fixture.captured.find((event) =>
      event.type === "tool.end" && (event.payload as { toolCallId?: string }).toolCallId === "swarm-1");
    expect((toolEnd!.payload as { result?: { total?: number; failed?: number } }).result).toMatchObject({ total: 3, failed: 0 });

    // 主循环工具清单包含 spawn_swarm
    expect(fixture.requests[0]?.tools.map((tool) => tool.name)).toContain("spawn_swarm");
  });

  it("rejects a template without {{item}}, a single item, too many items and duplicate prompts", async () => {
    const cases: Array<{ input: Record<string, unknown>; message: string }> = [
      { input: { prompt_template: "没有占位符", items: ["a", "b"] }, message: "{{item}}" },
      { input: { prompt_template: "评审 {{item}}", items: ["a.ts"] }, message: "at least 2 items" },
      { input: { prompt_template: "评审 {{item}}", items: Array.from({ length: SPAWN_SWARM_MAX_ITEMS + 1 }, (_, i) => `f${i}.ts`) }, message: "at most" },
      { input: { prompt_template: "评审 {{item}}", items: ["a.ts", "a.ts"] }, message: "distinct" },
    ];
    for (const { input, message } of cases) {
      const fixture = await setupSwarm(input);
      await fixture.runner.run(fixture.sessionId, "触发校验");
      const toolResult = await swarmToolResult(fixture);
      expect(toolResult).toMatchObject({ isError: true });
      expect((toolResult as { content: string }).content).toContain(message);
      // 校验失败时不应启动任何子代理
      expect(fixture.requests.some((request) => request.system.includes("exploration sub-agent"))).toBe(false);
    }
  });

  it("reports a single failed item without failing the whole batch", async () => {
    const fixture = await setupSwarm({ prompt_template: "评审 {{item}}", items: ["a.ts", "bad.ts"] }, "bad.ts");
    await fixture.runner.run(fixture.sessionId, "部分失败");

    const toolResult = await swarmToolResult(fixture);
    expect(toolResult).toMatchObject({ isError: false });
    const content = (toolResult as { content: string }).content;
    expect(content).toContain("[1/2] 结论：评审 a.ts");
    expect(content).toContain("[2/2] FAILED: provider boom");
    const finished = fixture.captured.filter((event) => event.type === "subagent.finished");
    expect(finished.map((event) => (event.payload as { status?: string }).status).sort()).toEqual(["done", "failed"]);
    const toolEnd = fixture.captured.find((event) =>
      event.type === "tool.end" && (event.payload as { toolCallId?: string }).toolCallId === "swarm-1");
    expect((toolEnd!.payload as { result?: { total?: number; failed?: number } }).result).toMatchObject({ total: 2, failed: 1 });
  });
});
