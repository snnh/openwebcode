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
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-ask-user-"));
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

interface AskSetup {
  agentMode?: "plan" | "build";
  toolCallId?: string;
  input: Record<string, unknown>;
}

async function setup(options: AskSetup) {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
  if (options.agentMode) await sessions.updateConfig(session.id, { provider: "fake", model: "model", agentMode: options.agentMode });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const toolCallId = options.toolCallId ?? "ask-1";
  // 首轮固定调用 ask_user；看到 tool_result 后输出文本收尾
  const provider: Provider = {
    name: "fake",
    async *streamChat(request: StreamChatRequest) {
      const answered = request.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.toolCallId === toolCallId));
      if (!answered) {
        yield { type: "tool_call", id: toolCallId, name: "ask_user", input: options.input };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "已收到回答" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const core = createFakeCore();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, session, events, agent, app };
}

async function waitForPendingInteraction(agent: AgentRunner, sessions: SessionStore, sessionId: string) {
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

describe("ask_user 工具", () => {
  it("confirm：发布 interaction.requested，REST respond 后工具结果含布尔答案，agent 继续", async () => {
    const harness = await setup({ input: { questions: [{ question: "继续执行吗？", type: "confirm" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.sessions, harness.session.id);
      expect(pending.kind).toBe("confirm");
      expect(pending.prompt).toBe("继续执行吗？");
      // interaction.requested 已发布到事件流
      expect(harness.events.replay(0, harness.session.id).events.some((event) => event.type === "interaction.requested")).toBe(true);
      // ask_user 是用户交互工具：不得产生 permission.request
      expect(harness.events.replay(0, harness.session.id).events.some((event) => event.type === "permission.request")).toBe(false);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: true } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const detail = await harness.sessions.get(harness.session.id);
      const result = toolResultOf(detail, "ask-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(false);
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ question: string; type: string; answer: unknown }>;
      expect(parsed).toEqual([{ question: "继续执行吗？", type: "confirm", answer: true }]);
      // agent 继续并输出最终文本
      const finalText = detail?.messages.filter((message) => message.role === "assistant").flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
      expect(finalText).toContain("已收到回答");
      // 交互状态已落盘为 answered
      const interactions = await harness.agent.listInteractions(harness.session.id);
      expect(interactions[0]?.status).toBe("answered");
    } finally {
      await harness.app.close();
    }
  });

  it("multi_select：工具结果返回选中项 label 数组", async () => {
    const harness = await setup({
      input: {
        questions: [{
          question: "选择要迁移的模块",
          header: "模块选择",
          type: "multi_select",
          options: [{ label: "core" }, { label: "server", description: "Node 服务层" }, { label: "web" }],
        }],
      },
    });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.sessions, harness.session.id);
      expect(pending.title).toBe("模块选择");
      expect(pending.options?.map((option) => option.label)).toEqual(["core", "server", "web"]);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: ["opt-0", "opt-2"] } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ answer: unknown }>;
      expect(parsed[0]?.answer).toEqual(["core", "web"]);
    } finally {
      await harness.app.close();
    }
  });

  it("text：工具结果返回字符串答案", async () => {
    const harness = await setup({ input: { questions: [{ question: "目标分支名？", type: "text" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.sessions, harness.session.id);
      await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: "feature/export" } });
      await run;
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ answer: unknown }>;
      expect(parsed[0]?.answer).toBe("feature/export");
    } finally {
      await harness.app.close();
    }
  });

  it("plan 模式不拦截 ask_user", async () => {
    const harness = await setup({ agentMode: "plan", input: { questions: [{ question: "计划是否可行？", type: "confirm" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.sessions, harness.session.id);
      await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: false } });
      await run;
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      expect(result!.isError).toBe(false);
      expect((result as { content: string }).content).not.toContain("Plan 模式为只读");
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ answer: unknown }>;
      expect(parsed[0]?.answer).toBe(false);
    } finally {
      await harness.app.close();
    }
  });

  it("run abort：挂起的交互解析为 { cancelled: true }（非错误结果）", async () => {
    const harness = await setup({ input: { questions: [{ question: "继续？", type: "confirm" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      await waitForPendingInteraction(harness.agent, harness.sessions, harness.session.id);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/abort` });
      expect(res.statusCode).toBe(202);
      // abort 路径 run() 会 rethrow（agent.aborted 语义），工具结果仍已落盘
      await run.then(() => undefined, () => undefined);
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(false);
      expect(JSON.parse((result as { content: string }).content)).toEqual({ cancelled: true });
    } finally {
      await harness.app.close();
    }
  });

  it("输入校验：0 题 / 选项不足 / 超过 4 题 / confirm 携带 options 均被拒绝", async () => {
    const cases: Array<{ id: string; input: Record<string, unknown>; message: string }> = [
      { id: "v-empty", input: { questions: [] }, message: "1-4 questions" },
      { id: "v-one-option", input: { questions: [{ question: "选一个", type: "single_select", options: [{ label: "仅一项" }] }] }, message: "2-4 options" },
      { id: "v-five", input: { questions: [1, 2, 3, 4, 5].map((index) => ({ question: `q${index}`, type: "confirm" })) }, message: "1-4 questions" },
      { id: "v-confirm-options", input: { questions: [{ question: "确认？", type: "confirm", options: [{ label: "a" }, { label: "b" }] }] }, message: "must not carry options" },
      { id: "v-empty-label", input: { questions: [{ question: "选一个", type: "multi_select", options: [{ label: "" }, { label: "b" }] }] }, message: "non-empty label" },
    ];
    for (const testCase of cases) {
      const harness = await setup({ toolCallId: testCase.id, input: testCase.input });
      try {
        await harness.agent.run(harness.session.id, "先问我");
        const result = toolResultOf(await harness.sessions.get(harness.session.id), testCase.id);
        expect(result, testCase.id).toBeDefined();
        expect(result!.isError, testCase.id).toBe(true);
        expect((result as { content: string }).content, testCase.id).toContain(testCase.message);
        // 校验失败不得产生任何交互
        expect(await harness.agent.listInteractions(harness.session.id), testCase.id).toEqual([]);
      } finally {
        await harness.app.close();
      }
    }
  });
});
