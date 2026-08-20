import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner, MAX_MANUAL_SUBAGENTS } from "../src/agent/agent-runner.js";
import { AgentRegistry, parseAgentMarkdown } from "../src/agents.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, ExecRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import { defaultSandboxPolicy } from "../src/sessions/default-sandbox.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeAgentHarness, toolResultOf } from "./helpers/agent-harness.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

interface TrackedFakeCore extends CoreClientLike {
  writeFileCalls: Array<{ sessionId: string; path: string; content: string }>;
  readFileCalls: Array<{ sessionId: string; path: string }>;
  runCalls: ExecRequest[];
  configureCalls: Array<{ sessionId: string; cwd: string; sandbox: unknown }>;
}

/** makeFakeCore + 调用记录（write/read/run/configure） */
function createFakeCore(): TrackedFakeCore {
  const writeFileCalls: TrackedFakeCore["writeFileCalls"] = [];
  const readFileCalls: TrackedFakeCore["readFileCalls"] = [];
  const runCalls: TrackedFakeCore["runCalls"] = [];
  const configureCalls: TrackedFakeCore["configureCalls"] = [];
  const client = makeFakeCore({
    async configureSession(request: { sessionId: string; cwd: string; sandbox: unknown }) {
      configureCalls.push(request);
      return { sandboxCapability: "advisory" as const };
    },
    async readFile(request: { sessionId: string; path: string }) {
      readFileCalls.push(request);
      return { path: request.path, content: "文件内容", totalLines: 1, encoding: "utf-8", truncated: false };
    },
    async writeFile(request: { sessionId: string; path: string; content: string }) {
      writeFileCalls.push(request);
      return { ok: true as const };
    },
    async run(request: ExecRequest) {
      runCalls.push({ ...request });
      return { exitCode: 0, durationMs: 1, truncated: false };
    },
  } as Partial<CoreClientLike>);
  return Object.assign(client, { writeFileCalls, readFileCalls, runCalls, configureCalls }) as TrackedFakeCore;
}

const GENERAL_MARKER = "general-purpose coding sub-agent";
const EXPLORE_MARKER = "read-only exploration sub-agent";

function isSubRequest(request: StreamChatRequest): boolean {
  return request.system.includes(GENERAL_MARKER) || request.system.includes(EXPLORE_MARKER);
}

async function setupRunner(options?: { permissionMode?: "ask" | "yolo" }) {
  const root = await tempRoot("owc-general-sub-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
  await sessions.updateConfig(session.id, { provider: "fake", model: "test-model", snapshotMode: "manual" });
  await sessions.updatePermissions(session.id, options?.permissionMode ?? "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const captured: AppEvent[] = [];
  events.on("event", (event: AppEvent) => captured.push(event));
  const core = createFakeCore();
  return { root, sessions, session, pricing, events, captured, core };
}

type RunnerFixture = Awaited<ReturnType<typeof setupRunner>>;

/** 注册 provider 并构造 AgentRunner（agents 传入时走带注册表的长参构造） */
function makeRunner(h: RunnerFixture, provider: Provider, agents?: AgentRegistry) {
  const providers = new ProviderRegistry();
  providers.register(provider);
  const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, agents);
  return { providers, runner };
}

/** 手动启动通路装配：setupRunner + 全局 AgentRegistry + buildServer */
async function setupApp(provider: Provider, options?: { permissionMode?: "ask" | "yolo" }) {
  const h = await setupRunner({ permissionMode: options?.permissionMode ?? "yolo" });
  const registry = new AgentRegistry(path.join(h.root, "agents-global"));
  const { providers, runner } = makeRunner(h, provider, registry);
  const app = await buildServer({ core: h.core, sessions: h.sessions, agent: runner, events: h.events, providers, pricing: h.pricing });
  return { ...h, registry, providers, runner, app };
}

/**
 * 构造主循环假 provider：主循环首轮发 subagent、次轮收尾；
 * 子代理轮次按序委托给 onSubRequest(request, index)。
 * subRequests 捕获每个子代理轮次的请求（messages 拷贝，避免断言看到跨轮复用的终态数组）。
 */
function makeSpawnProvider(
  onSubRequest: (request: StreamChatRequest, index: number) => Array<ProviderEvent>,
  options: { prompt?: string; agent?: string; tools?: string[] } = {},
): { provider: Provider; subRequests: StreamChatRequest[] } {
  const subRequests: StreamChatRequest[] = [];
  let mainTurn = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(request) {
      if (isSubRequest(request)) {
        subRequests.push({ ...request, messages: [...request.messages] });
        for (const event of onSubRequest(request, subRequests.length - 1)) yield event;
        return;
      }
      if (mainTurn++ === 0) {
        yield {
          type: "tool_call",
          id: "spawn-1",
          name: "subagent",
          input: {
            prompt: options.prompt ?? "写一个文件",
            ...(options.agent ? { agent: options.agent } : {}),
            ...(options.tools ? { tools: options.tools } : {}),
          },
        };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  return { provider, subRequests };
}

describe("subagent agent=general", () => {
  it("yolo 模式下 general 子代理经权限链写文件并返回结论", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const { provider, subRequests } = makeSpawnProvider((request, index) =>
      index === 0
        ? [
            { type: "tool_call", id: "sub-write-1", name: "write_file", input: { path: "out.txt", content: "hello" } },
            { type: "done", stopReason: "tool_use" },
          ]
        : [
            { type: "text_delta", text: "已写入 out.txt" },
            { type: "done", stopReason: "end_turn" },
          ],
      { agent: "general" });
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "派生 general 子代理");

    // general 子代理经权限链执行 write_file（yolo 自动放行，沙盒不变）
    expect(h.core.writeFileCalls).toHaveLength(1);
    expect(h.core.writeFileCalls[0]).toMatchObject({ sessionId: h.session.id, path: "out.txt", content: "hello" });
    const toolResult = toolResultOf(await h.sessions.get(h.session.id), "spawn-1");
    expect(toolResult).toMatchObject({ isError: false, content: "已写入 out.txt" });
    // 子代理工具表为 general 全集（含写/命令），不含编排工具
    const subTools = subRequests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(subTools).toContain("write_file");
    expect(subTools).toContain("edit_file");
    expect(subTools).toContain("bash");
    expect(subTools).toContain("read_artifact");
    expect(subTools).not.toContain("subagent");
    expect(subTools).not.toContain("spawn_swarm");
    expect(subTools).not.toContain("todo_write");
    // 事件回显 agent: general
    const started = h.captured.find((event) => event.type === "subagent.started");
    expect((started?.payload as { agent?: string }).agent).toBe("general");
  });

  it("子代理的 thinking_delta/thinking_end 累积为带 provider 的 thinking 块进入后续轮次请求（思维链回传素材）", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const { provider, subRequests } = makeSpawnProvider((request, index) =>
      index === 0
        ? [
            // 第一轮：思考分片 + 工具调用（DeepSeek 思维模式场景）
            { type: "thinking_delta", text: "先想" },
            { type: "thinking_delta", text: "一下" },
            { type: "thinking_end", text: "先想一下" },
            { type: "tool_call", id: "sub-think-1", name: "read_file", input: { path: "a.txt" } },
            { type: "done", stopReason: "tool_use" },
          ]
        : [
            { type: "text_delta", text: "已读取" },
            { type: "done", stopReason: "end_turn" },
          ],
      { prompt: "读一个文件", agent: "general" });
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "派生 general 子代理");

    // 子代理共两轮：第二轮请求的 assistant 消息携带带 provider 的 thinking 块（分片已合并）
    expect(subRequests).toHaveLength(2);
    const assistant = subRequests[1]!.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", text: "先想一下", provider: "fake" },
      { type: "tool_call", id: "sub-think-1", name: "read_file", input: { path: "a.txt" } },
    ]);
    expect(h.core.readFileCalls).toHaveLength(1);
  });

  it("子代理 text_end（无 text_delta）落盘带 textSignature 的 text 块并进入后续轮次请求", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const { provider, subRequests } = makeSpawnProvider((request, index) =>
      index === 0
        ? [
            // 第一轮：仅 text_end（无 text_delta）——权威文本 + v1 textSignature
            { type: "text_end", text: "第一轮结论", signature: JSON.stringify({ v: 1, id: "msg_text_1", phase: "final" }) },
            { type: "tool_call", id: "sub-text-1", name: "read_file", input: { path: "a.txt" } },
            { type: "done", stopReason: "tool_use" },
          ]
        : [
            // 第二轮：同样只有 text_end，作为最终结论
            { type: "text_end", text: "最终结论文本" },
            { type: "done", stopReason: "end_turn" },
          ],
      { prompt: "读一个文件", agent: "general" });
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "派生 general 子代理");

    // 第二轮请求的 assistant 消息携带带 textSignature 的 text 块（由 text_end 固化）
    expect(subRequests).toHaveLength(2);
    const assistant = subRequests[1]!.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toContainEqual({
      type: "text",
      text: "第一轮结论",
      textSignature: JSON.stringify({ v: 1, id: "msg_text_1", phase: "final" }),
    });
    // 结论取自仅 text_end 轮次的权威文本（lastText 兜底，无 delta 也不丢）
    const toolResult = toolResultOf(await h.sessions.get(h.session.id), "spawn-1");
    expect(toolResult).toMatchObject({ isError: false, content: "最终结论文本" });
  });

  it("子代理同 id 的第二次 thinking_end 原位替换早期 thinking 块（B3 合并）", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const { provider, subRequests } = makeSpawnProvider((request, index) =>
      index === 0
        ? [
            // 同一轮内：先发首块 thinking_end，再发同 id 的 enriched thinking_end（B3 场景）
            { type: "thinking_end", text: "第一段思考", signature: JSON.stringify({ v: 1, id: "reasoning_9" }) },
            { type: "thinking_end", text: "第二段思考", signature: JSON.stringify({ v: 1, id: "reasoning_9", phase: "final" }) },
            { type: "tool_call", id: "sub-think-2", name: "read_file", input: { path: "b.txt" } },
            { type: "done", stopReason: "tool_use" },
          ]
        : [
            // 第二轮：普通收尾
            { type: "text_end", text: "读完了" },
            { type: "done", stopReason: "end_turn" },
          ],
      { prompt: "读一个文件", agent: "general" });
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "派生 general 子代理");

    // 第二轮请求的 assistant 消息只保留一个 thinking 块（被 enriched signature 原位替换而非追加）
    expect(subRequests).toHaveLength(2);
    const assistant = subRequests[1]!.messages.find((message) => message.role === "assistant");
    const thinking = assistant?.content?.filter((block) => block.type === "thinking") ?? [];
    expect(thinking).toEqual([
      { type: "thinking", text: "第二段思考", signature: JSON.stringify({ v: 1, id: "reasoning_9", phase: "final" }), provider: "fake" },
    ]);
  });

  it("ask 模式拒绝写文件：tool_result 为拒绝原因，子代理继续收尾", async () => {
    const h = await setupRunner({ permissionMode: "ask" });
    const { provider, subRequests } = makeSpawnProvider((request, index) =>
      index === 0
        ? [
            { type: "tool_call", id: "sub-write-1", name: "write_file", input: { path: "out.txt", content: "hello" } },
            { type: "done", stopReason: "tool_use" },
          ]
        : [
            { type: "text_delta", text: "写入被拒绝，改为只报告结论" },
            { type: "done", stopReason: "end_turn" },
          ],
      { agent: "general" });
    const { runner } = makeRunner(h, provider);

    const runPromise = runner.run(h.session.id, "派生 general 子代理");
    // 等权限请求挂起后拒绝（与 REST respond 同一协调器路径）
    const requestId = await vi.waitFor(() => {
      const req = h.captured.find((event) => event.type === "permission.request");
      if (!req) throw new Error("no permission.request event");
      return (req.payload as { requestId: string }).requestId;
    });
    expect(h.core.writeFileCalls).toHaveLength(0);
    const complete = await runner.preparePermissionResponse(h.session.id, requestId, "deny", "用户拒绝");
    complete?.();
    await runPromise;

    expect(h.core.writeFileCalls).toHaveLength(0);
    const second = subRequests[1]!;
    const lastMessage = second.messages.at(-1);
    const denial = lastMessage?.content.find((block) => block.type === "tool_result");
    expect(denial).toMatchObject({ isError: true });
    expect((denial as { content: string }).content).toContain("用户拒绝");
    const toolResult = toolResultOf(await h.sessions.get(h.session.id), "spawn-1");
    expect(toolResult).toMatchObject({ isError: false, content: "写入被拒绝，改为只报告结论" });
  });

  it("general 子代理的 bash 与主循环同一沙盒配置", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const { provider } = makeSpawnProvider((request, index) =>
      index === 0
        ? [
            { type: "tool_call", id: "sub-bash-1", name: "bash", input: { cmd: "echo hi" } },
            { type: "done", stopReason: "tool_use" },
          ]
        : [
            { type: "text_delta", text: "命令已执行" },
            { type: "done", stopReason: "end_turn" },
          ],
      { prompt: "跑个命令", agent: "general" });
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "派生 general 子代理");

    expect(h.core.runCalls).toHaveLength(1);
    expect(h.core.runCalls[0]).toMatchObject({ sessionId: h.session.id, cwd: h.session.cwd });
    // 子代理 bash 同样注入会话环境变量（最内层包装），用户命令在其后
    expect(h.core.runCalls[0]?.cmd).toContain("OWC_SESSION_ID");
    expect(h.core.runCalls[0]?.cmd).toContain("echo hi");
    // 沙盒配置与主循环同源（session.sandbox ?? defaultSandboxPolicy(cwd)）
    expect(h.core.configureCalls.length).toBeGreaterThan(0);
    expect(h.core.configureCalls[0]?.sandbox).toEqual(defaultSandboxPolicy(h.session.cwd));
  });

  it("默认（不带 agent）仍为只读 explore：写工具被构造性拒绝", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const { provider, subRequests } = makeSpawnProvider((request, index) =>
      index === 0
        ? [
            { type: "tool_call", id: "sub-bad-1", name: "write_file", input: { path: "out.txt", content: "x" } },
            { type: "done", stopReason: "tool_use" },
          ]
        : [
            { type: "text_delta", text: "无法写入，只读结论" },
            { type: "done", stopReason: "end_turn" },
          ],
      { prompt: "探索" });
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "派生默认子代理");

    expect(h.core.writeFileCalls).toHaveLength(0);
    const subTools = subRequests[0]?.tools.map((tool) => tool.name).sort() ?? [];
    expect(subTools).toEqual(["glob", "grep", "read_artifact", "read_file"]);
    // 第二个子代理请求里带 write_file 被拒绝的错误 tool_result
    const denial = subRequests[1]?.messages.at(-1)?.content.find((block) => block.type === "tool_result");
    expect(denial).toMatchObject({ isError: true });
    expect((denial as { content: string }).content).toContain("not available");
  });

  it("tools 参数与 general 允许集求交（编排工具被过滤）", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const { provider, subRequests } = makeSpawnProvider(
      () => [
        { type: "text_delta", text: "结论" },
        { type: "done", stopReason: "end_turn" },
      ],
      { prompt: "t", agent: "general", tools: ["write_file", "bash", "subagent"] });
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "tools 交集");

    const subTools = subRequests[0]?.tools.map((tool) => tool.name).sort() ?? [];
    expect(subTools).toEqual(["bash", "write_file"]);
  });
});

describe("spawn_swarm 逐项 general", () => {
  it("单项 agent=general 可写文件，默认项保持只读", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    // spawn_swarm 为会话级开关（默认关）：显式开启
    await h.sessions.updateConfig(h.session.id, { provider: "fake", model: "test-model", swarmEnabled: true });
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes(GENERAL_MARKER)) {
          const last = request.messages.at(-1);
          if (last?.role === "user") {
            yield { type: "tool_call", id: "sub-write-1", name: "write_file", input: { path: "a.txt", content: "A" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "general 项完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (request.system.includes(EXPLORE_MARKER)) {
          const last = request.messages.at(-1);
          if (last?.role === "user") {
            yield { type: "tool_call", id: "sub-read-1", name: "read_file", input: { path: "b.txt" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "explore 项完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (mainTurn++ === 0) {
          yield {
            type: "tool_call",
            id: "swarm-1",
            name: "spawn_swarm",
            input: { prompt_template: "处理 {{item}}", items: [{ task: "a", agent: "general" }, "b"] },
          };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const { runner } = makeRunner(h, provider);

    await runner.run(h.session.id, "swarm");

    expect(h.core.writeFileCalls).toHaveLength(1);
    expect(h.core.readFileCalls).toHaveLength(1);
    const toolResult = toolResultOf(await h.sessions.get(h.session.id), "swarm-1");
    expect(toolResult).toMatchObject({ isError: false });
    expect((toolResult as { content: string }).content).toContain("general 项完成");
    expect((toolResult as { content: string }).content).toContain("explore 项完成");
    const generalStarted = h.captured.find((event) =>
      event.type === "subagent.started" && (event.payload as { agent?: string }).agent === "general");
    expect(generalStarted).toBeDefined();
  });
});

describe("POST /api/sessions/:id/subagents 手动启动", () => {
  it("202 + 事件序列 started→finished + 转录可 GET", async () => {
    const h = await setupApp({
      name: "fake",
      async *streamChat(request) {
        if (isSubRequest(request)) {
          yield { type: "usage", inputTokens: 7, outputTokens: 3, cacheRead: 0, cacheWrite: 0 };
          yield { type: "text_delta", text: "手动结论" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "主循环不应被触发" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    try {
      const res = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "调查一下" } });
      expect(res.statusCode, res.body).toBe(202);
      const { taskId, toolCallId } = res.json() as { taskId: string; toolCallId: string };
      expect(toolCallId).toBe(`manual-${taskId}`);

      await vi.waitFor(() => {
        const finished = h.captured.find((event) =>
          event.type === "subagent.finished" && (event.payload as { taskId?: string }).taskId === taskId);
        if (!finished) throw new Error("no subagent.finished");
        expect((finished.payload as { status?: string }).status).toBe("done");
      }, { timeout: 5_000 });
      const started = h.captured.find((event) => event.type === "subagent.started" && (event.payload as { taskId?: string }).taskId === taskId);
      expect(started?.payload).toMatchObject({ toolCallId, taskId, prompt: "调查一下", manual: true });
      // started 先于 finished
      const startedIdx = h.captured.indexOf(started!);
      const finishedIdx = h.captured.findIndex((event) => event.type === "subagent.finished" && (event.payload as { taskId?: string }).taskId === taskId);
      expect(startedIdx).toBeLessThan(finishedIdx);
      // 子代理 token 走既有 onUsage 记账路径
      expect(h.captured.some((event) => event.type === "context.usage" && (event.payload as { inputTokens?: number }).inputTokens === 7)).toBe(true);

      const transcript = await h.app.inject({ method: "GET", url: `/api/sessions/${h.session.id}/subagents/${taskId}` });
      expect(transcript.statusCode).toBe(200);
      expect(transcript.json()).toMatchObject({ id: taskId, prompt: "调查一下", conclusion: "手动结论" });
    } finally {
      await h.app.close();
    }
  });

  it("无效 agent / 空 prompt / 超长 prompt / 无此会话 → 400/404", async () => {
    const h = await setupApp({ name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
    try {
      const badAgent = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "x", agent: "ghost" } });
      expect(badAgent.statusCode).toBe(400);
      expect(badAgent.body).toContain("Unknown sub-agent");
      const empty = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "   " } });
      expect(empty.statusCode).toBe(400);
      const tooLong = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "x".repeat(4_001) } });
      expect(tooLong.statusCode).toBe(400);
      const noSession = await h.app.inject({ method: "POST", url: "/api/sessions/123e4567-e89b-42d3-a456-426614174999/subagents", payload: { prompt: "x" } });
      expect(noSession.statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it("并发上限：第 5 个手动子代理 → 429", async () => {
    const gate: Array<() => void> = [];
    const h = await setupApp({
      name: "fake",
      async *streamChat(request) {
        if (isSubRequest(request)) {
          await new Promise<void>((resolve) => gate.push(resolve));
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    try {
      const launched: string[] = [];
      for (let i = 0; i < MAX_MANUAL_SUBAGENTS; i++) {
        const res = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: `任务 ${i}` } });
        expect(res.statusCode, res.body).toBe(202);
        launched.push((res.json() as { taskId: string }).taskId);
      }
      // 等 4 个全部 started（在途登记生效）
      await vi.waitFor(() => {
        const startedCount = h.captured.filter((event) => event.type === "subagent.started").length;
        if (startedCount < MAX_MANUAL_SUBAGENTS) throw new Error("not all started");
      }, { timeout: 5_000 });
      const overflow = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "溢出" } });
      expect(overflow.statusCode).toBe(429);
      // 放行全部在途子代理，等其 finished 收尾（避免 afterEach 清理竞态）
      for (const release of gate.splice(0)) release();
      await vi.waitFor(() => {
        const finished = h.captured.filter((event) => event.type === "subagent.finished").length;
        if (finished < MAX_MANUAL_SUBAGENTS) throw new Error("not all finished");
      }, { timeout: 5_000 });
      // 释放后槽位空出，可再次启动
      const again = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "再来一个" } });
      expect(again.statusCode, again.body).toBe(202);
      // 新子代理的 provider 调用异步发生：等它挂到 gate 上再放行
      await vi.waitFor(() => {
        if (gate.length === 0) throw new Error("subagent not waiting yet");
      }, { timeout: 5_000 });
      for (const release of gate.splice(0)) release();
      await vi.waitFor(() => {
        const taskId = (again.json() as { taskId: string }).taskId;
        const done = h.captured.find((event) => event.type === "subagent.finished" && (event.payload as { taskId?: string }).taskId === taskId);
        if (!done) throw new Error("not finished");
      }, { timeout: 5_000 });
      expect(launched).toHaveLength(MAX_MANUAL_SUBAGENTS);
    } finally {
      await h.app.close();
    }
  });

  it("ask 模式：子代理写工具发 permission.request，respond allow 后执行", async () => {
    let subTurn = 0;
    const h = await setupApp({
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes(GENERAL_MARKER)) {
          if (subTurn++ === 0) {
            yield { type: "tool_call", id: "sub-write-1", name: "write_file", input: { path: "m.txt", content: "M" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "手动 general 完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        yield { type: "done", stopReason: "end_turn" };
      },
    }, { permissionMode: "ask" });
    try {
      const res = await h.app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "写文件", agent: "general" } });
      expect(res.statusCode, res.body).toBe(202);
      const { taskId } = res.json() as { taskId: string };
      const requestId = await vi.waitFor(() => {
        const req = h.captured.find((event) => event.type === "permission.request" && (event.payload as { tool?: string }).tool === "write_file");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      }, { timeout: 5_000 });
      expect(h.core.writeFileCalls).toHaveLength(0);
      const allow = await h.app.inject({
        method: "POST",
        url: `/api/sessions/${h.session.id}/permissions/respond`,
        payload: { requestId, decision: "allow" },
      });
      expect(allow.statusCode).toBe(200);
      await vi.waitFor(() => {
        const done = h.captured.find((event) => event.type === "subagent.finished" && (event.payload as { taskId?: string }).taskId === taskId);
        if (!done) throw new Error("not finished");
        expect((done.payload as { status?: string }).status).toBe("done");
      }, { timeout: 5_000 });
      expect(h.core.writeFileCalls).toHaveLength(1);
      expect(h.core.writeFileCalls[0]).toMatchObject({ path: "m.txt", content: "M" });
    } finally {
      await h.app.close();
    }
  });
});

describe("GET /api/agents", () => {
  it("内置 explore/general 在前，自定义子代理在后", async () => {
    const h = await setupApp({ name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
    try {
      // AgentRegistry 在请求时懒扫描：setupApp 之后写自定义 agent 即可被读到
      await mkdir(path.join(h.root, "agents-global"), { recursive: true });
      await writeFile(path.join(h.root, "agents-global", "reviewer.md"), "---\ndescription: Reviews code\n---\nREVIEWER BODY", "utf8");
      const res = await h.app.inject({ method: "GET", url: `/api/agents?cwd=${encodeURIComponent(h.root)}` });
      expect(res.statusCode).toBe(200);
      const { agents } = res.json() as { agents: Array<{ id: string; name: string; description: string; builtin: boolean }> };
      expect(agents[0]).toMatchObject({ id: "explore", builtin: true });
      expect(agents[1]).toMatchObject({ id: "general", builtin: true });
      const custom = agents.find((agent) => agent.id === "reviewer");
      expect(custom).toMatchObject({ name: "reviewer", description: "Reviews code", builtin: false });

      const noCwd = await h.app.inject({ method: "GET", url: "/api/agents" });
      const globalOnly = (noCwd.json() as { agents: Array<{ id: string }> }).agents;
      expect(globalOnly.map((agent) => agent.id)).toEqual(["explore", "general", "reviewer"]);
    } finally {
      await h.app.close();
    }
  });
});

describe("GET /api/sessions/:id/subagents/:taskId", () => {
  it("serves the persisted transcript and rejects invalid or missing taskIds", async () => {
    const h = await makeAgentHarness({ title: "Transcript route" });
    try {
      const taskId = "123e4567-e89b-42d3-a456-426614174000";
      await mkdir(path.join(h.sessions.contextRoot(h.session.id), "subagents"), { recursive: true });
      await writeFile(
        path.join(h.sessions.contextRoot(h.session.id), "subagents", `${taskId}.json`),
        JSON.stringify({ id: taskId, prompt: "调查", startedAt: new Date().toISOString(), turns: 1, toolsUsed: [], conclusion: "结论", messages: [] }),
        "utf8",
      );

      const ok = await h.app.inject({ method: "GET", url: `/api/sessions/${h.session.id}/subagents/${taskId}` });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ id: taskId, prompt: "调查", conclusion: "结论" });

      const missing = await h.app.inject({ method: "GET", url: `/api/sessions/${h.session.id}/subagents/123e4567-e89b-42d3-a456-426614174001` });
      expect(missing.statusCode).toBe(404);

      const invalid = await h.app.inject({ method: "GET", url: `/api/sessions/${h.session.id}/subagents/..%2F..%2Fledger` });
      expect([400, 404]).toContain(invalid.statusCode);
      const notUuid = await h.app.inject({ method: "GET", url: `/api/sessions/${h.session.id}/subagents/not-a-uuid` });
      expect(notUuid.statusCode).toBe(400);

      const noSession = await h.app.inject({ method: "GET", url: `/api/sessions/123e4567-e89b-42d3-a456-426614174999/subagents/${taskId}` });
      expect(noSession.statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });
});

async function writeAgent(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), text, "utf8");
}

const core = makeFakeCore();

describe("AgentRegistry", () => {
  it("parses arrays, comma-separated tools and omitted optional fields", () => {
    expect(parseAgentMarkdown("---\ndescription: review\ntools: [read_file, grep]\nmodel: model-x\n---\nBody", "reviewer", "global"))
      .toMatchObject({ name: "reviewer", description: "review", tools: ["read_file", "grep"], model: "model-x", body: "Body" });
    expect(parseAgentMarkdown("---\nname: scout\ndescription: scan\ntools: glob, grep\n---\nPrompt", "file", "project"))
      .toMatchObject({ name: "scout", tools: ["glob", "grep"], source: "project" });
    expect(parseAgentMarkdown("---\ndescription: list\ntools:\n  - read_file\n  - glob\n---\nPrompt", "list", "global"))
      .toMatchObject({ tools: ["read_file", "glob"] });
    expect(parseAgentMarkdown("---\ndescription: plain\n---\nPrompt", "plain", "global"))
      .toEqual({ name: "plain", description: "plain", body: "Prompt", source: "global" });
  });

  it("parses provider/role frontmatter and silently ignores invalid role values", () => {
    expect(parseAgentMarkdown("---\ndescription: review\nprovider: alt-provider\nmodel: model-x\nrole: premium\n---\nBody", "reviewer", "global"))
      .toMatchObject({ provider: "alt-provider", model: "model-x", role: "premium" });
    expect(parseAgentMarkdown("---\ndescription: review\nrole: cheap\n---\nBody", "reviewer", "global"))
      .toEqual({ name: "reviewer", description: "review", role: "cheap", body: "Body", source: "global" });
    // 非法 role：字段静默忽略，定义本身保留（与 tools 解析的宽松风格一致）
    expect(parseAgentMarkdown("---\ndescription: review\nrole: bogus\n---\nBody", "reviewer", "global"))
      .toEqual({ name: "reviewer", description: "review", body: "Body", source: "global" });
  });

  it("lets project definitions override global definitions and skips malformed files", async () => {
    const root = await tempRoot("owc-agents-");
    const globalDir = path.join(root, "global");
    const projectDir = path.join(root, "workspace", ".owc", "agents");
    await writeAgent(globalDir, "reviewer", "---\ndescription: global\n---\nGlobal body");
    await writeAgent(globalDir, "bad", "---\ndescription: missing close\nBad body");
    await writeAgent(projectDir, "reviewer", "---\ndescription: project\n---\nProject body");

    const agents = await new AgentRegistry(globalDir).listFor(path.join(root, "workspace"));
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "reviewer", description: "project", body: "Project body", source: "project" });
  });

  it("invalidates a cached scan when an agent definition changes", async () => {
    const root = await tempRoot("owc-agents-");
    const globalDir = path.join(root, "agents");
    await writeAgent(globalDir, "reviewer", "---\ndescription: first\n---\nFirst body");
    const registry = new AgentRegistry(globalDir);
    expect((await registry.listFor(path.join(root, "workspace")))[0]?.description).toBe("first");
    await writeAgent(globalDir, "reviewer", "---\ndescription: second definition\n---\nSecond body");
    expect((await registry.listFor(path.join(root, "workspace")))[0]?.description).toBe("second definition");
  });
});

describe("custom subagent agents", () => {
  it("injects the catalog and applies body, model, tool allowlist and transcript agent", async () => {
    const root = await tempRoot("owc-agents-");
    const workspace = path.join(root, "workspace");
    const globalDir = path.join(root, "agents");
    await mkdir(workspace, { recursive: true });
    await writeAgent(globalDir, "reviewer", "---\ndescription: Reviews code\ntools: [read_file, bash, grep]\nmodel: reviewer-model\n---\nREVIEWER BODY");
    const registry = new AgentRegistry(globalDir);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: workspace, provider: "fake", model: "main-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    let mainTurns = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (request.system.includes("REVIEWER BODY")) {
          yield { type: "text_delta", text: "review complete" };
          yield { type: "done", stopReason: "end_turn" };
        } else if (mainTurns++ === 0) {
          yield { type: "tool_call", id: "spawn-custom", name: "subagent", input: { prompt: "review", agent: "reviewer" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, registry);
    await runner.run(session.id, "review this");

    expect(requests[0]?.system).toContain("Available sub-agents");
    expect(requests[0]?.system).toContain("- reviewer: Reviews code");
    expect(requests[0]?.system).toContain("unsupported tools ignored: bash");
    const sub = requests.find((request) => request.system.includes("REVIEWER BODY"));
    expect(sub?.model).toBe("reviewer-model");
    expect(sub?.tools.map((tool) => tool.name).sort()).toEqual(["grep", "read_file"]);
    const files = await readdir(path.join(sessions.contextRoot(session.id), "subagents"));
    const transcript = JSON.parse(await readFile(path.join(sessions.contextRoot(session.id), "subagents", files[0]!), "utf8")) as { agent?: string };
    expect(transcript.agent).toBe("reviewer");
  });

  it("omits the catalog section when no agents are configured", async () => {
    const root = await tempRoot("owc-agents-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "main-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let system = "";
    const providers = new ProviderRegistry();
    providers.register({
      name: "fake",
      async *streamChat(request) {
        system = request.system;
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, new AgentRegistry(path.join(root, "missing")));
    await runner.run(session.id, "hello");
    expect(system).not.toContain("Available sub-agents");
  });
});
