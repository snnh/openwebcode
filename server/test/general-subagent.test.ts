import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, MAX_MANUAL_SUBAGENTS } from "../src/agent/agent-runner.js";
import { AgentRegistry } from "../src/agents.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, CoreInfo, ExecRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { defaultSandboxPolicy } from "../src/sessions/default-sandbox.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-general-sub-"));
  roots.push(root);
  return root;
}

const FAKE_CORE_INFO: CoreInfo = {
  version: "0.8.0-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

interface FakeCore extends CoreClientLike {
  writeFileCalls: Array<{ sessionId: string; path: string; content: string }>;
  readFileCalls: Array<{ sessionId: string; path: string }>;
  runCalls: ExecRequest[];
  configureCalls: Array<{ sessionId: string; cwd: string; sandbox: unknown }>;
}

function createFakeCore(): FakeCore {
  const core = {
    writeFileCalls: [] as FakeCore["writeFileCalls"],
    readFileCalls: [] as FakeCore["readFileCalls"],
    runCalls: [] as ExecRequest[],
    configureCalls: [] as FakeCore["configureCalls"],
    on() { return core; },
    async ping() { return FAKE_CORE_INFO; },
    async configureSession(request: { sessionId: string; cwd: string; sandbox: unknown }) {
      core.configureCalls.push(request);
      return { sandboxCapability: "advisory" as const };
    },
    async readFile(request: { sessionId: string; path: string }) {
      core.readFileCalls.push(request);
      return { path: request.path, content: "文件内容", totalLines: 1, encoding: "utf-8", truncated: false };
    },
    async writeFile(request: { sessionId: string; path: string; content: string }) {
      core.writeFileCalls.push(request);
      return { ok: true as const };
    },
    async editFile() { return { matches: 1 }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    async run(request: ExecRequest) {
      core.runCalls.push({ ...request });
      return { exitCode: 0, durationMs: 1, truncated: false };
    },
  };
  return core as unknown as FakeCore;
}

const GENERAL_MARKER = "general-purpose coding sub-agent";
const EXPLORE_MARKER = "read-only exploration sub-agent";

function isSubRequest(request: StreamChatRequest): boolean {
  return request.system.includes(GENERAL_MARKER) || request.system.includes(EXPLORE_MARKER);
}

async function setupRunner(options?: { permissionMode?: "ask" | "yolo"; agents?: AgentRegistry }) {
  const root = await tempRoot();
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
  return { root, sessions, session, pricing, events, captured, core, agents: options?.agents };
}

function toolResultOf(detail: Awaited<ReturnType<SessionStore["get"]>>, toolCallId: string) {
  return detail?.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.toolCallId === toolCallId);
}

describe("spawn_task agent=general", () => {
  it("yolo 模式下 general 子代理经权限链写文件并返回结论", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const requests: StreamChatRequest[] = [];
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (request.system.includes(GENERAL_MARKER)) {
          const last = request.messages.at(-1);
          if (last?.role === "user") {
            yield { type: "tool_call", id: "sub-write-1", name: "write_file", input: { path: "out.txt", content: "hello" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "已写入 out.txt" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "写一个文件", agent: "general" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing);

    await runner.run(h.session.id, "派生 general 子代理");

    // general 子代理经权限链执行 write_file（yolo 自动放行，沙盒不变）
    expect(h.core.writeFileCalls).toHaveLength(1);
    expect(h.core.writeFileCalls[0]).toMatchObject({ sessionId: h.session.id, path: "out.txt", content: "hello" });
    const toolResult = toolResultOf(await h.sessions.get(h.session.id), "spawn-1");
    expect(toolResult).toMatchObject({ isError: false, content: "已写入 out.txt" });
    // 子代理工具表为 general 全集（含写/命令），不含编排工具
    const subRequest = requests.find((request) => request.system.includes(GENERAL_MARKER));
    const subTools = subRequest?.tools.map((tool) => tool.name) ?? [];
    expect(subTools).toContain("write_file");
    expect(subTools).toContain("edit_file");
    expect(subTools).toContain("bash");
    expect(subTools).toContain("read_artifact");
    expect(subTools).not.toContain("spawn_task");
    expect(subTools).not.toContain("spawn_swarm");
    expect(subTools).not.toContain("todo_write");
    // 事件回显 agent: general
    const started = h.captured.find((event) => event.type === "subagent.started");
    expect((started?.payload as { agent?: string }).agent).toBe("general");
  });

  it("ask 模式拒绝写文件：tool_result 为拒绝原因，子代理继续收尾", async () => {
    const h = await setupRunner({ permissionMode: "ask" });
    let mainTurn = 0;
    const subCalls: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes(GENERAL_MARKER)) {
          subCalls.push({ ...request, messages: [...request.messages] });
          if (subCalls.length === 1) {
            yield { type: "tool_call", id: "sub-write-1", name: "write_file", input: { path: "out.txt", content: "hello" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "写入被拒绝，改为只报告结论" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "写一个文件", agent: "general" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing);

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
    const second = subCalls[1]!;
    const lastMessage = second.messages.at(-1);
    const denial = lastMessage?.content.find((block) => block.type === "tool_result");
    expect(denial).toMatchObject({ isError: true });
    expect((denial as { content: string }).content).toContain("用户拒绝");
    const toolResult = toolResultOf(await h.sessions.get(h.session.id), "spawn-1");
    expect(toolResult).toMatchObject({ isError: false, content: "写入被拒绝，改为只报告结论" });
  });

  it("general 子代理的 bash 与主循环同一沙盒配置", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    let mainTurn = 0;
    let subTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes(GENERAL_MARKER)) {
          if (subTurn++ === 0) {
            yield { type: "tool_call", id: "sub-bash-1", name: "bash", input: { cmd: "echo hi" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "命令已执行" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "跑个命令", agent: "general" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing);

    await runner.run(h.session.id, "派生 general 子代理");

    expect(h.core.runCalls).toHaveLength(1);
    expect(h.core.runCalls[0]).toMatchObject({ sessionId: h.session.id, cmd: "echo hi", cwd: h.session.cwd });
    // 沙盒配置与主循环同源（session.sandbox ?? defaultSandboxPolicy(cwd)）
    expect(h.core.configureCalls.length).toBeGreaterThan(0);
    expect(h.core.configureCalls[0]?.sandbox).toEqual(defaultSandboxPolicy(h.session.cwd));
  });

  it("默认（不带 agent）仍为只读 explore：写工具被构造性拒绝", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const requests: StreamChatRequest[] = [];
    let mainTurn = 0;
    let subTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        // messages 数组跨轮复用并原地追加：捕获时拷贝，断言才不会看到终态
        requests.push({ ...request, messages: [...request.messages] });
        if (request.system.includes(EXPLORE_MARKER)) {
          if (subTurn++ === 0) {
            yield { type: "tool_call", id: "sub-bad-1", name: "write_file", input: { path: "out.txt", content: "x" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "无法写入，只读结论" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "探索" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing);

    await runner.run(h.session.id, "派生默认子代理");

    expect(h.core.writeFileCalls).toHaveLength(0);
    const subRequest = requests.find((request) => request.system.includes(EXPLORE_MARKER));
    expect(subRequest?.tools.map((tool) => tool.name).sort()).toEqual(["glob", "grep", "read_artifact", "read_file"]);
    // 第二个子代理请求里带 write_file 被拒绝的错误 tool_result
    const subSecond = requests.filter((request) => request.system.includes(EXPLORE_MARKER))[1];
    const denial = subSecond?.messages.at(-1)?.content.find((block) => block.type === "tool_result");
    expect(denial).toMatchObject({ isError: true });
    expect((denial as { content: string }).content).toContain("not available");
  });

  it("tools 参数与 general 允许集求交（编排工具被过滤）", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
    const requests: StreamChatRequest[] = [];
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (isSubRequest(request)) {
          yield { type: "text_delta", text: "结论" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "t", agent: "general", tools: ["write_file", "bash", "spawn_task"] } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing);

    await runner.run(h.session.id, "tools 交集");

    const subRequest = requests.find(isSubRequest);
    expect(subRequest?.tools.map((tool) => tool.name).sort()).toEqual(["bash", "write_file"]);
  });
});

describe("spawn_swarm 逐项 general", () => {
  it("单项 agent=general 可写文件，默认项保持只读", async () => {
    const h = await setupRunner({ permissionMode: "yolo" });
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
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing);

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
  async function setupApp(options?: { permissionMode?: "ask" | "yolo" }) {
    const h = await setupRunner({ permissionMode: options?.permissionMode ?? "yolo" });
    const globalAgents = path.join(h.root, "agents-global");
    const registry = new AgentRegistry(globalAgents);
    const providers = new ProviderRegistry();
    return { ...h, globalAgents, registry, providers };
  }

  it("202 + 事件序列 started→finished + 转录可 GET", async () => {
    const h = await setupApp();
    const provider: Provider = {
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
    };
    h.providers.register(provider);
    const runner = new AgentRunner(h.sessions, h.providers, h.core, h.events, h.pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, h.registry);
    const app = await buildServer({ core: h.core, sessions: h.sessions, agent: runner, events: h.events, providers: h.providers, pricing: h.pricing });
    try {
      const res = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "调查一下" } });
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

      const transcript = await app.inject({ method: "GET", url: `/api/sessions/${h.session.id}/subagents/${taskId}` });
      expect(transcript.statusCode).toBe(200);
      expect(transcript.json()).toMatchObject({ id: taskId, prompt: "调查一下", conclusion: "手动结论" });
    } finally {
      await app.close();
    }
  });

  it("无效 agent / 空 prompt / 超长 prompt → 400", async () => {
    const h = await setupApp();
    h.providers.register({ name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
    const runner = new AgentRunner(h.sessions, h.providers, h.core, h.events, h.pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, h.registry);
    const app = await buildServer({ core: h.core, sessions: h.sessions, agent: runner, events: h.events, providers: h.providers, pricing: h.pricing });
    try {
      const badAgent = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "x", agent: "ghost" } });
      expect(badAgent.statusCode).toBe(400);
      expect(badAgent.body).toContain("Unknown sub-agent");
      const empty = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "   " } });
      expect(empty.statusCode).toBe(400);
      const tooLong = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "x".repeat(4_001) } });
      expect(tooLong.statusCode).toBe(400);
      const noSession = await app.inject({ method: "POST", url: "/api/sessions/123e4567-e89b-42d3-a456-426614174999/subagents", payload: { prompt: "x" } });
      expect(noSession.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("并发上限：第 5 个手动子代理 → 429", async () => {
    const h = await setupApp();
    const gate: Array<() => void> = [];
    const provider: Provider = {
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
    };
    h.providers.register(provider);
    const runner = new AgentRunner(h.sessions, h.providers, h.core, h.events, h.pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, h.registry);
    const app = await buildServer({ core: h.core, sessions: h.sessions, agent: runner, events: h.events, providers: h.providers, pricing: h.pricing });
    try {
      const launched: string[] = [];
      for (let i = 0; i < MAX_MANUAL_SUBAGENTS; i++) {
        const res = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: `任务 ${i}` } });
        expect(res.statusCode, res.body).toBe(202);
        launched.push((res.json() as { taskId: string }).taskId);
      }
      // 等 4 个全部 started（在途登记生效）
      await vi.waitFor(() => {
        const startedCount = h.captured.filter((event) => event.type === "subagent.started").length;
        if (startedCount < MAX_MANUAL_SUBAGENTS) throw new Error("not all started");
      }, { timeout: 5_000 });
      const overflow = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "溢出" } });
      expect(overflow.statusCode).toBe(429);
      // 放行全部在途子代理，等其 finished 收尾（避免 afterEach 清理竞态）
      for (const release of gate.splice(0)) release();
      await vi.waitFor(() => {
        const finished = h.captured.filter((event) => event.type === "subagent.finished").length;
        if (finished < MAX_MANUAL_SUBAGENTS) throw new Error("not all finished");
      }, { timeout: 5_000 });
      // 释放后槽位空出，可再次启动
      const again = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "再来一个" } });
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
      await app.close();
    }
  });

  it("ask 模式：子代理写工具发 permission.request，respond allow 后执行", async () => {
    const h = await setupApp({ permissionMode: "ask" });
    let subTurn = 0;
    const provider: Provider = {
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
    };
    h.providers.register(provider);
    const runner = new AgentRunner(h.sessions, h.providers, h.core, h.events, h.pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, h.registry);
    const app = await buildServer({ core: h.core, sessions: h.sessions, agent: runner, events: h.events, providers: h.providers, pricing: h.pricing });
    try {
      const res = await app.inject({ method: "POST", url: `/api/sessions/${h.session.id}/subagents`, payload: { prompt: "写文件", agent: "general" } });
      expect(res.statusCode, res.body).toBe(202);
      const { taskId } = res.json() as { taskId: string };
      const requestId = await vi.waitFor(() => {
        const req = h.captured.find((event) => event.type === "permission.request" && (event.payload as { tool?: string }).tool === "write_file");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      }, { timeout: 5_000 });
      expect(h.core.writeFileCalls).toHaveLength(0);
      const allow = await app.inject({
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
      await app.close();
    }
  });
});

describe("GET /api/agents", () => {
  it("内置 explore/general 在前，自定义子代理在后", async () => {
    const h = await setupRunner();
    const globalAgents = path.join(h.root, "agents-global");
    await mkdir(globalAgents, { recursive: true });
    await writeFile(path.join(globalAgents, "reviewer.md"), "---\ndescription: Reviews code\n---\nREVIEWER BODY", "utf8");
    const registry = new AgentRegistry(globalAgents);
    const providers = new ProviderRegistry();
    providers.register({ name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
    const runner = new AgentRunner(h.sessions, providers, h.core, h.events, h.pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, registry);
    const app = await buildServer({ core: h.core, sessions: h.sessions, agent: runner, events: h.events, providers, pricing: h.pricing });
    try {
      const res = await app.inject({ method: "GET", url: `/api/agents?cwd=${encodeURIComponent(h.root)}` });
      expect(res.statusCode).toBe(200);
      const { agents } = res.json() as { agents: Array<{ id: string; name: string; description: string; builtin: boolean }> };
      expect(agents[0]).toMatchObject({ id: "explore", builtin: true });
      expect(agents[1]).toMatchObject({ id: "general", builtin: true });
      const custom = agents.find((agent) => agent.id === "reviewer");
      expect(custom).toMatchObject({ name: "reviewer", description: "Reviews code", builtin: false });

      const noCwd = await app.inject({ method: "GET", url: "/api/agents" });
      const globalOnly = (noCwd.json() as { agents: Array<{ id: string }> }).agents;
      expect(globalOnly.map((agent) => agent.id)).toEqual(["explore", "general", "reviewer"]);
    } finally {
      await app.close();
    }
  });
});
