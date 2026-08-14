import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { runSubAgent, SUB_AGENT_CONCLUSION_LIMIT, type SubAgentOptions } from "../src/agent/sub-agent.js";
import type { CoreClientLike } from "../src/core-client.js";
import { ContextManager } from "../src/context/context-manager.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { toolResultOf } from "./helpers/agent-harness.js";
import { tempRoot } from "./helpers/temp-roots.js";

function createFakeCore(handlers: {
  readFile?: (request: { sessionId: string; path: string }) => Promise<unknown>;
  globFiles?: (request: { sessionId: string; path: string; pattern: string }) => Promise<unknown>;
  grepFiles?: (request: { sessionId: string; path: string; pattern: string }) => Promise<unknown>;
}): CoreClientLike {
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile(request: { sessionId: string; path: string }) {
      if (!handlers.readFile) throw new Error("readFile not expected");
      return handlers.readFile(request);
    },
    async globFiles(request: { sessionId: string; path: string; pattern: string }) {
      if (!handlers.globFiles) throw new Error("globFiles not expected");
      return handlers.globFiles(request);
    },
    async grepFiles(request: { sessionId: string; path: string; pattern: string }) {
      if (!handlers.grepFiles) throw new Error("grepFiles not expected");
      return handlers.grepFiles(request);
    },
  };
  return core as unknown as CoreClientLike;
}

function subAgentOptions(provider: Provider, core: CoreClientLike, contextRoot: string, overrides?: Partial<SubAgentOptions>): SubAgentOptions {
  return {
    provider,
    model: "test-model",
    prompt: "调查代码结构",
    toolNames: ["read_file", "glob", "grep", "read_artifact"],
    core,
    sessionId: "sub-test",
    cwd: contextRoot,
    contextRoot,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("spawn_task via AgentRunner", () => {
  it("exposes spawn_task and returns the sub-agent conclusion as the tool result", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (event: AppEvent) => captured.push(event));

    let readFileCalls = 0;
    const core = createFakeCore({
      async readFile(request) {
        readFileCalls += 1;
        return { path: request.path, content: "文件内容" };
      },
    });

    const requests: StreamChatRequest[] = [];
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (request.system.includes("exploration sub-agent")) {
          const last = request.messages[request.messages.length - 1];
          if (last?.role === "user") {
            yield { type: "tool_call", id: "sub-read-1", name: "read_file", input: { path: "src/a.ts" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "usage", inputTokens: 120, outputTokens: 30, cacheRead: 0, cacheWrite: 0 };
            yield { type: "text_delta", text: "结论：一切正常" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "调查代码结构" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    await runner.run(session.id, "先调查再回答");

    // spawn_task 出现在主循环 TOOLS；子代理请求里只有四件只读工具（不可再 spawn_task）
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("spawn_task");
    const subRequest = requests.find((request) => request.system.includes("exploration sub-agent"));
    expect(subRequest?.tools.map((tool) => tool.name).sort()).toEqual(["glob", "grep", "read_artifact", "read_file"]);

    expect(readFileCalls).toBe(1);
    const toolResult = toolResultOf(await sessions.get(session.id), "spawn-1");
    expect(toolResult).toMatchObject({ type: "tool_result", content: "结论：一切正常", isError: false });

    const toolEnd = captured.find((event) =>
      event.type === "tool.end" && (event.payload as { toolCallId?: string }).toolCallId === "spawn-1");
    expect(toolEnd).toBeDefined();
    expect((toolEnd!.payload as { result?: { conclusion?: string; turns?: number; toolsUsed?: string[] } }).result)
      .toMatchObject({ conclusion: "结论：一切正常", turns: 2, toolsUsed: ["read_file"] });

    // 子代理生命周期事件 + 工具结果携带转录 id
    const taskId = (toolResult as { subagentTaskIds?: string[] }).subagentTaskIds?.[0];
    expect(taskId).toBeTruthy();
    expect(captured.some((event) =>
      event.type === "subagent.started" && (event.payload as { taskId?: string }).taskId === taskId)).toBe(true);
    expect(captured.some((event) =>
      event.type === "subagent.finished" && (event.payload as { taskId?: string; status?: string }).taskId === taskId)).toBe(true);

    // 进度事件：每轮 provider 调用后与工具执行后各发一次（仅元数据，不含文本）
    const progress = captured.filter((event) =>
      event.type === "subagent.progress" && (event.payload as { toolCallId?: string }).toolCallId === "spawn-1");
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.every((event) => (event.payload as { taskId?: string }).taskId === taskId)).toBe(true);
    const lastProgress = progress.at(-1)!.payload as { turns?: number; toolsUsed?: string[] };
    expect(lastProgress.turns).toBe(2);
    expect(lastProgress.toolsUsed).toEqual(["read_file"]);

    // 子代理文本不进入主聊天流
    expect(captured.some((event) =>
      event.type === "message.delta" && (event.payload as { text?: string }).text === "结论：一切正常")).toBe(false);

    // 子代理 token 经 onUsage 复用主循环记账路径（context.usage 事件 + 会话 ledger）
    expect(captured.some((event) =>
      event.type === "context.usage" && (event.payload as { inputTokens?: number }).inputTokens === 120)).toBe(true);
    const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
    expect(ledger.usage.inputTokens).toBe(120);
    expect(ledger.usage.outputTokens).toBe(30);
  });

  it("honors the maxTurns argument of spawn_task over the default", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();

    let subCalls = 0;
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes("exploration sub-agent")) {
          subCalls += 1;
          yield { type: "tool_call", id: `sub-tool-${subCalls}`, name: "glob", input: { path: ".", pattern: "*.ts" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "调查", maxTurns: 1 } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, createFakeCore({}), events, pricing);
    // 全局默认 100 不应影响显式参数 1
    runner.setSubAgentMaxTurns(() => 100);

    await runner.run(session.id, "调查");

    expect(subCalls).toBe(1);
    const toolResult = toolResultOf(await sessions.get(session.id), "spawn-1");
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false });
    expect(String(toolResult.content)).toContain("reached max turns (1)");
  });

  it("applies the injected global default when spawn_task omits maxTurns", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();

    let subCalls = 0;
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes("exploration sub-agent")) {
          subCalls += 1;
          yield { type: "tool_call", id: `sub-tool-${subCalls}`, name: "glob", input: { path: ".", pattern: "*.ts" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "调查" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, createFakeCore({}), events, pricing);
    runner.setSubAgentMaxTurns(() => 2);

    await runner.run(session.id, "调查");

    expect(subCalls).toBe(2);
    const toolResult = toolResultOf(await sessions.get(session.id), "spawn-1");
    expect(String(toolResult.content)).toContain("reached max turns (2)");
  });

  it("keeps the started subagent taskId and per-item status in the tool result when the subagent fails", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (event: AppEvent) => captured.push(event));

    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes("exploration sub-agent")) {
          // 子代理已启动（onStart 先于 provider 调用），随后失败
          throw new Error("provider boom");
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "调查代码结构" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, createFakeCore({}), events, pricing);

    await runner.run(session.id, "派生一个会失败的子代理");

    // 启动后失败的 tool_result 仍携带 taskId 与逐项终态，页面刷新后历史可还原
    const toolResult = toolResultOf(await sessions.get(session.id), "spawn-1");
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as { content: string }).content).toContain("provider boom");
    const taskId = (toolResult as { subagentTaskIds?: string[] }).subagentTaskIds?.[0];
    expect(taskId).toBeTruthy();
    const tasks = (toolResult as { subagentTasks?: Array<{ taskId: string; index: number; status: string; error?: string }> }).subagentTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks?.[0]).toMatchObject({ taskId, index: 0, status: "failed" });
    expect(tasks?.[0]?.error).toContain("provider boom");

    // 失败子代理的转录已落盘（UI 可提供转录入口）
    const transcripts = await readdir(path.join(sessions.contextRoot(session.id), "subagents"));
    expect(transcripts).toHaveLength(1);
    expect(captured.some((event) =>
      event.type === "subagent.finished"
      && (event.payload as { taskId?: string; status?: string }).taskId === taskId
      && (event.payload as { status?: string }).status === "failed")).toBe(true);
  });
});

describe("runSubAgent", () => {
  it("reports progress after each provider turn and after tool execution", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const core = createFakeCore({
      async globFiles() { return { matches: ["a.ts"] }; },
    });
    let calls = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        calls += 1;
        if (calls === 1) {
          yield { type: "tool_call", id: "glob-1", name: "glob", input: { path: ".", pattern: "*.ts" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "结论" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const events: Array<{ turns: number; toolsUsed: string[] }> = [];
    const result = await runSubAgent(subAgentOptions(provider, core, root, { onProgress: (progress) => events.push(progress) }));

    expect(result.turns).toBe(2);
    // 第 1 轮 provider 结束后（尚无工具）、第 1 轮工具执行后、第 2 轮 provider 结束后
    expect(events).toEqual([
      { turns: 1, toolsUsed: [] },
      { turns: 1, toolsUsed: ["glob"] },
      { turns: 2, toolsUsed: ["glob"] },
    ]);
  });

  it("truncates a conclusion longer than the hard limit (64000 characters)", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        yield { type: "text_delta", text: "长".repeat(65_000) };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const result = await runSubAgent(subAgentOptions(provider, createFakeCore({}), root));
    expect(result.conclusion.endsWith("…(truncated)")).toBe(true);
    expect(result.conclusion.length).toBe(SUB_AGENT_CONCLUSION_LIMIT + "…(truncated)".length);
    expect(result.turns).toBe(1);
  });

  it("rejects tools narrowed out by the tools option and keeps going", async () => {
    const root = await tempRoot("owc-spawn-task-");
    let readFileCalls = 0;
    const core = createFakeCore({
      async readFile() {
        readFileCalls += 1;
        return { content: "不应被读到" };
      },
    });
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push({ ...request, messages: [...request.messages] });
        if (requests.length === 1) {
          yield { type: "tool_call", id: "bad-1", name: "read_file", input: { path: "a.ts" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "部分结论" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const result = await runSubAgent(subAgentOptions(provider, core, root, { toolNames: ["glob"] }));

    expect(readFileCalls).toBe(0);
    // 第二轮请求里应带着 read_file 被拒绝的错误 tool_result
    const second = requests[1];
    const lastMessage = second?.messages[second.messages.length - 1];
    expect(lastMessage?.role).toBe("tool");
    const toolResult = lastMessage?.content.find((block) => block.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as { content: string }).content).toContain("not available");
    // 子代理请求里不出现被收窄掉的工具
    expect(second?.tools.map((tool) => tool.name)).toEqual(["glob"]);
    expect(result.conclusion).toBe("部分结论");
    expect(result.toolsUsed).toEqual([]);
  });

  it("wraps up with a max-turns note when the turn budget is exhausted", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const core = createFakeCore({
      async globFiles() { return { matches: [] }; },
    });
    let calls = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        calls += 1;
        yield { type: "text_delta", text: `第${calls}轮发现` };
        yield { type: "tool_call", id: `glob-${calls}`, name: "glob", input: { path: ".", pattern: "*.ts" } };
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const result = await runSubAgent(subAgentOptions(provider, core, root, { maxTurns: 2 }));
    expect(calls).toBe(2);
    expect(result.turns).toBe(2);
    expect(result.conclusion).toContain("第2轮发现");
    expect(result.conclusion).toContain("reached max turns (2)");
    expect(result.toolsUsed).toEqual(["glob"]);
  });

  it("writes a transcript with prompt and conclusion under subagents/", async () => {
    const root = await tempRoot("owc-spawn-task-");
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        yield { type: "text_delta", text: "最终结论" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const result = await runSubAgent(subAgentOptions(provider, createFakeCore({}), root, { prompt: "转录测试任务" }));

    const dir = path.join(root, "subagents");
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const transcript = JSON.parse(await readFile(path.join(dir, files[0]!), "utf8")) as {
      id: string;
      prompt: string;
      conclusion: string;
      turns: number;
      toolsUsed: string[];
      messages: unknown[];
    };
    expect(transcript.prompt).toBe("转录测试任务");
    expect(transcript.conclusion).toBe(result.conclusion);
    expect(transcript.turns).toBe(1);
    expect(transcript.messages.length).toBeGreaterThanOrEqual(2);
  });
});
