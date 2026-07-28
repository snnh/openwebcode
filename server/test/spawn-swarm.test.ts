import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../src/agents.js";
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
  /** 子代理实际收到的 prompt（按启动顺序） */
  startedSub: string[];
}

/** 主循环第一轮调用 spawn_swarm；子代理按用户消息里的 item 回结论；failOn 命中的 item 抛错；hang 时子代理挂起直到中断 */
async function setupSwarm(input: Record<string, unknown>, failOn?: string, options?: { registry?: AgentRegistry; hang?: boolean }): Promise<SwarmFixture> {
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
  const startedSub: string[] = [];
  let mainTurn = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(request) {
      requests.push(request);
      if (request.system.includes("exploration sub-agent")) {
        const last = request.messages.at(-1);
        const text = last?.content.find((block) => block.type === "text");
        const prompt = text?.type === "text" ? text.text : "";
        startedSub.push(prompt);
        if (options?.hang) {
          // 挂起直到 run 中断（与 steering.test.ts 同一模式）：模拟在途长任务，验证中断传播与排队项门控
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (request.signal.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error("sub aborted");
        }
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
  const runner = options?.registry
    ? new AgentRunner(sessions, providers, createFakeCore(), events, pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, options.registry)
    : new AgentRunner(sessions, providers, createFakeCore(), events, pricing);
  return { sessions, runner, captured, requests, sessionId: session.id, startedSub };
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

    // 进度事件携带 swarm 序号（每个子代理单轮，无工具）
    const progress = fixture.captured.filter((event) => event.type === "subagent.progress");
    expect(progress).toHaveLength(3);
    expect(progress.map((event) => (event.payload as { swarm?: { index: number } }).swarm?.index).sort()).toEqual([1, 2, 3]);
    expect(progress.every((event) => (event.payload as { turns?: number; toolsUsed?: string[] }).turns === 1)).toBe(true);
    expect(progress.every((event) => ((event.payload as { toolsUsed?: string[] }).toolsUsed ?? []).length === 0)).toBe(true);

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
      { input: { prompt_template: "评审 {{item}}", items: [{ task: " " }, "b.ts"] }, message: "non-empty task" },
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

  it("lets an item override the call-level agent and reports the effective agent in started events", async () => {
    const root = await tempRoot();
    const globalDir = path.join(root, "agents");
    await mkdir(globalDir, { recursive: true });
    await writeFile(path.join(globalDir, "reviewer.md"), "---\ndescription: Reviews code\n---\nREVIEWER BODY", "utf8");
    await writeFile(path.join(globalDir, "scout.md"), "---\ndescription: Scans code\n---\nSCOUT BODY", "utf8");
    const registry = new AgentRegistry(globalDir);
    const fixture = await setupSwarm(
      { prompt_template: "评审 {{item}}", items: [{ task: "a.ts", agent: "reviewer" }, "b.ts"], agent: "scout" },
      undefined,
      { registry },
    );
    await fixture.runner.run(fixture.sessionId, "逐项覆盖 agent");

    const toolResult = await swarmToolResult(fixture);
    expect(toolResult).toMatchObject({ isError: false });

    // started 事件携带实际生效的 agent：第 1 项覆盖为 reviewer，第 2 项用调用级 scout
    const started = fixture.captured.filter((event) => event.type === "subagent.started");
    expect(started).toHaveLength(2);
    const agentByIndex = new Map(started.map((event) => {
      const payload = event.payload as { swarm?: { index: number }; agent?: string };
      return [payload.swarm?.index, payload.agent];
    }));
    expect(agentByIndex.get(1)).toBe("reviewer");
    expect(agentByIndex.get(2)).toBe("scout");

    // 覆盖项的子代理请求使用对应 body 作为 systemExtra
    const subRequests = fixture.requests.filter((request) => request.system.includes("exploration sub-agent"));
    expect(subRequests.some((request) => request.system.includes("REVIEWER BODY"))).toBe(true);
    expect(subRequests.some((request) => request.system.includes("SCOUT BODY"))).toBe(true);

    // 字符串 items 与对象 items 混用保持向后兼容（b.ts 结论仍聚合）
    expect((toolResult as { content: string }).content).toContain("[2/2] 结论：评审 b.ts");
  });

  it("rejects an unknown per-item agent before launching anything", async () => {
    const root = await tempRoot();
    const globalDir = path.join(root, "agents");
    await mkdir(globalDir, { recursive: true });
    const registry = new AgentRegistry(globalDir);
    const fixture = await setupSwarm(
      { prompt_template: "评审 {{item}}", items: [{ task: "a.ts", agent: "ghost" }, "b.ts"] },
      undefined,
      { registry },
    );
    await fixture.runner.run(fixture.sessionId, "未知逐项 agent");

    const toolResult = await swarmToolResult(fixture);
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as { content: string }).content).toContain("Unknown sub-agent: ghost");
    expect(fixture.requests.some((request) => request.system.includes("exploration sub-agent"))).toBe(false);
  });

  it("stops launching queued items once the run is aborted", async () => {
    // 6 项、并发 4：4 项在途 + 2 项排队；中断后排队项不再启动
    const fixture = await setupSwarm(
      { prompt_template: "评审 {{item}}", items: ["a", "b", "c", "d", "e", "f"] },
      undefined,
      { hang: true },
    );
    const run = fixture.runner.run(fixture.sessionId, "中断 swarm");
    await vi.waitFor(() => expect(fixture.startedSub).toHaveLength(4), { timeout: 5000 });
    fixture.runner.abort(fixture.sessionId);
    await expect(run).rejects.toBeTruthy();

    // 在途 4 项经 signal 中止；排队的 e/f 两项从未启动
    expect(fixture.startedSub).toHaveLength(4);
  });
});
