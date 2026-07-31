import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-plan-approval-"));
  roots.push(root);
  return root;
}

function createFakeCore(): CoreClientLike {
  return {
    on() { return this; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile() { return { content: "file content" }; },
    async globFiles() { return { matches: [] }; },
    async grepFiles() { return { matches: [] }; },
    async writeFile() { return { ok: true }; },
    async editFile() { return { matches: 1 }; },
    async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async cleanupSession() { return { ok: true }; },
    setRequestTimeoutMs() {},
    start() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
    stop() { return Promise.resolve(); },
    ping() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
    listFiles() { return Promise.resolve({ entries: [], truncated: false }); },
  } as unknown as CoreClientLike;
}

const PLAN = "# 实施计划\n\n1. 改 A\n2. 改 B";

interface SetupOptions {
  agentMode?: "plan" | "code" | "goal";
  permissionMode?: "ask" | "yolo";
  input?: Record<string, unknown>;
  toolCallId?: string;
}

async function setup(options: SetupOptions = {}) {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
  if (options.agentMode) await sessions.updateConfig(session.id, { provider: "fake", model: "model", agentMode: options.agentMode });
  if (options.permissionMode) await sessions.updatePermissions(session.id, options.permissionMode, []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const requests: StreamChatRequest[] = [];
  const toolCallId = options.toolCallId ?? "epm-1";
  const input = options.input ?? { plan: PLAN };
  // 首轮固定调用 exit_plan_mode；看到对应 tool_result 后输出文本收尾
  const provider: Provider = {
    name: "fake",
    async *streamChat(request: StreamChatRequest) {
      requests.push(request);
      const answered = request.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.toolCallId === toolCallId));
      if (!answered) {
        yield { type: "tool_call", id: toolCallId, name: "exit_plan_mode", input };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "执行完成" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const core = createFakeCore();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, session, events, agent, app, requests };
}

async function waitForPendingInteraction(agent: AgentRunner, sessionId: string) {
  await vi.waitFor(async () => {
    const list = await agent.listInteractions(sessionId);
    expect(list.some((item) => item.status === "pending")).toBe(true);
  }, { timeout: 5000 });
  return (await agent.listInteractions(sessionId)).find((item) => item.status === "pending")!;
}

function toolResultOf(detail: Awaited<ReturnType<SessionStore["get"]>>, toolCallId: string) {
  return detail?.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.toolCallId === toolCallId);
}

describe("exit_plan_mode 工具下发", () => {
  it.each([
    { mode: "code" as const, expected: false },
    { mode: "goal" as const, expected: false },
    { mode: "plan" as const, expected: true },
  ])("agentMode=$mode 时下发=$expected", async ({ mode, expected }) => {
    // 直接结束（无工具调用），只采集首轮请求的 tools 列表
    const harness = await setup({ agentMode: mode, input: {} });
    try {
      await harness.agent.run(harness.session.id, "研究一下");
      const tools = harness.requests[0]?.tools.map((tool) => tool.name) ?? [];
      expect(tools.includes("exit_plan_mode")).toBe(expected);
    } finally {
      await harness.app.close();
    }
  });
});

describe("exit_plan_mode 批准流", () => {
  it("approve：切回 build 并注入计划正文，run 继续；发 session.config_updated", async () => {
    const harness = await setup({ agentMode: "plan" });
    try {
      const run = harness.agent.run(harness.session.id, "做个功能");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      expect(pending.kind).toBe("plan_approval");
      expect(pending.prompt).toBe(PLAN);
      // 计划批准是交互不是权限：不得产生 permission.request
      expect(harness.events.replay(0, harness.session.id).events.some((event) => event.type === "permission.request")).toBe(false);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: { decision: "approve" } } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const detail = await harness.sessions.get(harness.session.id);
      // agentMode 已切回 build（build 不落盘）
      expect(detail?.agentMode).toBeUndefined();
      const result = toolResultOf(detail, "epm-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(false);
      const content = (result as { content: string }).content;
      expect(content).toContain("计划已批准");
      expect(content).toContain(PLAN);
      // 后续轮次已是 code 模式提示词
      expect(harness.requests[1]?.system).not.toContain("PLAN mode");
      // web 端经 session.config_updated 事件刷新会话配置
      expect(harness.events.replay(0, harness.session.id).events.some((event) => event.type === "session.config_updated")).toBe(true);
    } finally {
      await harness.app.close();
    }
  });

  it("edit：注入用户改后的计划文本并切回 build", async () => {
    const harness = await setup({ agentMode: "plan" });
    try {
      const run = harness.agent.run(harness.session.id, "做个功能");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      const revised = "# 改后计划\n\n1. 先改 C";
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: { decision: "edit", plan: revised } } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const detail = await harness.sessions.get(harness.session.id);
      expect(detail?.agentMode).toBeUndefined();
      const result = toolResultOf(detail, "epm-1");
      const content = (result as { content: string }).content;
      expect(content).toContain("计划已批准");
      expect(content).toContain(revised);
      expect(content).not.toContain(PLAN);
    } finally {
      await harness.app.close();
    }
  });

  it("reject：意见回注，保持 plan 模式", async () => {
    const harness = await setup({ agentMode: "plan" });
    try {
      const run = harness.agent.run(harness.session.id, "做个功能");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: { decision: "reject", feedback: "先调研替代方案" } } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const detail = await harness.sessions.get(harness.session.id);
      expect(detail?.agentMode).toBe("plan");
      const result = toolResultOf(detail, "epm-1");
      expect(result!.isError).toBe(false);
      const content = (result as { content: string }).content;
      expect(content).toContain("计划被拒绝");
      expect(content).toContain("先调研替代方案");
      // 未发配置切换事件
      expect(harness.events.replay(0, harness.session.id).events.some((event) => event.type === "session.config_updated")).toBe(false);
    } finally {
      await harness.app.close();
    }
  });

  it("yolo 权限档不跳过计划批准：仍挂起等待人工 respond", async () => {
    const harness = await setup({ agentMode: "plan", permissionMode: "yolo" });
    try {
      const run = harness.agent.run(harness.session.id, "做个功能");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      expect(pending.kind).toBe("plan_approval");
      // 未 respond 前没有 tool_result 落盘（run 仍在挂起）
      expect(toolResultOf(await harness.sessions.get(harness.session.id), "epm-1")).toBeUndefined();
      await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: { decision: "approve" } } });
      await run;
      expect(toolResultOf(await harness.sessions.get(harness.session.id), "epm-1")).toBeDefined();
    } finally {
      await harness.app.close();
    }
  });

  it("pending 交互持久化：新 AgentRunner 实例可恢复列出", async () => {
    const harness = await setup({ agentMode: "plan" });
    try {
      const run = harness.agent.run(harness.session.id, "做个功能");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      // 模拟重启：同一 SessionStore 上新建 runner，pending 交互从 interactions.json 恢复
      const providers = new ProviderRegistry();
      const events = new EventBus();
      const pricing = new PricingCatalog(path.join(harness.root, "pricing2.json"));
      await pricing.initialize();
      const revived = new AgentRunner(harness.sessions, providers, createFakeCore(), events, pricing);
      const restored = (await revived.listInteractions(harness.session.id)).find((item) => item.id === pending.id);
      expect(restored).toBeDefined();
      expect(restored!.kind).toBe("plan_approval");
      expect(restored!.status).toBe("pending");
      expect(restored!.prompt).toBe(PLAN);
      // respond 恢复挂起的 run
      await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: { decision: "reject", feedback: "重来" } } });
      await run;
    } finally {
      await harness.app.close();
    }
  });

  it("输入校验：空 plan 报错且不产生交互", async () => {
    const harness = await setup({ agentMode: "plan", input: { plan: "  " } });
    try {
      await harness.agent.run(harness.session.id, "做个功能");
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "epm-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect((result as { content: string }).content).toContain("non-empty plan");
      expect(await harness.agent.listInteractions(harness.session.id)).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });
});
