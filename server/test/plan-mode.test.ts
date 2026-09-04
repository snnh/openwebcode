import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { buildServer } from "../src/app.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("plan mode — agent-runner level", () => {
  function createFakeCore(): CoreClientLike {
    return makeFakeCore({
      async readFile() { return { content: "file content" }; },
      async globFiles() { return { matches: [] }; },
      async grepFiles() { return { matches: [] }; },
      async editFile() { return { matches: 1 }; },
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
    } as unknown as Partial<CoreClientLike>);
  }

  async function setup(agentMode: "plan" | "code", toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>) {
    const root = await tempRoot("owc-plan-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    // 创建后通过 updateConfig 设置 agentMode
    await sessions.updateConfig(session.id, { provider: "fake", model: "model", agentMode });
    // yolo 放行写工具，使 code 模式用例直达 fake core 而非挂起在权限审批
    await sessions.updatePermissions(session.id, "yolo", []);

    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request: StreamChatRequest) {
        const isFirst = requests.length === 0;
        requests.push(request);
        if (isFirst) {
          for (const tc of toolCalls) {
            yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.input };
          }
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "已处理" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const core = createFakeCore();
    const runner = new AgentRunner(sessions, providers, core, events, pricing);
    await runner.run(session.id, "test message");
    const detail = await sessions.get(session.id);
    return { runner, session, sessions, requests, detail, events };
  }

  it.each([
    { name: "write_file", id: "wf-1", input: { path: "test.txt", content: "hello" }, blocked: true },
    { name: "bash", id: "bash-1", input: { cmd: "echo hi" }, blocked: true },
    { name: "edit_file", id: "ef-1", input: { path: "test.txt", oldText: "a", newText: "b" }, blocked: true },
    { name: "read_file", id: "rf-1", input: { path: "test.txt" }, blocked: false },
    { name: "glob", id: "glob-1", input: { path: ".", pattern: "*.ts" }, blocked: false },
    { name: "grep", id: "grep-1", input: { path: ".", pattern: "TODO" }, blocked: false },
    { name: "mcp__filesystem_read", id: "mcp-1", input: { path: "/test" }, blocked: true },
  ])("plan 模式下 $name 门禁 blocked=$blocked", async ({ name, id, input, blocked }) => {
    const { detail } = await setup("plan", [{ name, id, input }]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === id);
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(blocked);
    if (blocked) expect((toolResult as { content: string }).content).toContain("Plan 模式为只读");
  });

  it("code 模式下 write_file 不被 plan 门禁拦截", { timeout: 15_000 }, async () => {
    const { detail } = await setup("code", [
      { name: "write_file", id: "wf-2", input: { path: "test.txt", content: "hello" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "wf-2");
    expect(toolResult).toBeDefined();
    // code 模式下走到 core.writeFile，fake core 返回 ok:true
    // 关键是 error 消息不含 "Plan 模式为只读"
    expect((toolResult as { content: string }).content).not.toContain("Plan 模式为只读");
  });

  it("code 模式下 bash 不被 plan 门禁拦截", { timeout: 15_000 }, async () => {
    const { detail } = await setup("code", [
      { name: "bash", id: "bash-2", input: { cmd: "echo hello" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "bash-2");
    expect(toolResult).toBeDefined();
    expect((toolResult as { content: string }).content).not.toContain("Plan 模式为只读");
  });

  it("plan 模式：PLAN 指令不在 system，而以注入消息随触发消息下发", async () => {
    const { requests } = await setup("plan", [
      { name: "read_file", id: "rf-2", input: { path: "a.txt" } } as { name: string; id: string; input: Record<string, unknown> },
    ]);
    // system 保持跨模式字节稳定（缓存连续性）——PLAN 指令不在此
    expect(requests[0]?.system).not.toContain("PLAN mode");
    // 引导为 user 角色合成注入消息（id 前缀 inj:plan:full:），位于触发用户消息之前
    const first = requests[0]?.messages[0];
    expect(first?.id.startsWith("inj:plan:full:")).toBe(true);
    expect(first?.role).toBe("user");
    const text = (first!.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("PLAN mode");
    expect(text).toContain("<system-reminder>");
    // 触发消息紧随其后，链上以其为父
    expect(requests[0]?.messages[1]?.parentId).toBe(first?.id);
  });

  it("code 模式：system 与消息流均无 PLAN 指令/注入", async () => {
    const { requests } = await setup("code", [
      { name: "read_file", id: "rf-3", input: { path: "a.txt" } } as { name: string; id: string; input: Record<string, unknown> },
    ]);
    expect(requests[0]?.system).not.toContain("PLAN mode");
    // 普通会话首轮无任何注入（日期也仅在跨日变化时注入）：第一条消息即用户原文
    expect(requests[0]?.messages.some((message) => message.id.startsWith("inj:"))).toBe(false);
    expect(requests[0]?.messages[0]?.role).toBe("user");
  });

  it("PUT config agentMode 非法值 → 400", async () => {
    const root = await tempRoot("owc-plan-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    // 用 test-only provider 创建，验证 PUT 行为不依赖运行时 provider
    const session = await sessions.create({ cwd: root, provider: "test-stub", model: "model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* () { yield { type: "done", stopReason: "end_turn" }; }));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; }, async cleanupSession() { return { ok: true }; }, setRequestTimeoutMs() {} } as unknown as CoreClientLike;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });

    // 非法值
    const res1 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "invalid" } });
    expect(res1.statusCode).toBe(400);
    const body1 = JSON.parse(res1.body);
    expect(body1.error).toBe('agentMode must be "plan", "code", or "goal"');

    // "plan" 合法
    const res2 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "plan" } });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.agentMode).toBe("plan");

    // "code" 合法（code 值不落盘）
    const res3 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "code" } });
    expect(res3.statusCode).toBe(200);
    const body3 = JSON.parse(res3.body);
    expect(body3.agentMode).toBeUndefined();

    // 恢复为 code（缺省不落盘）
    const res4 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "plan" } });
    expect(res4.statusCode).toBe(200);
    const res5 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "code" } });
    expect(res5.statusCode).toBe(200);
    const body5 = JSON.parse(res5.body);
    expect(body5.agentMode).toBeUndefined();
  });

  it("创建会话时 agentMode=plan 落盘，缺省不落盘，非法值 400", async () => {
    const root = await tempRoot("owc-plan-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* () { yield { type: "done", stopReason: "end_turn" }; }));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClientLike;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });

    const plan = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "test-stub", model: "deterministic-tool-loop", agentMode: "plan" } });
    expect(plan.statusCode).toBe(201);
    expect(plan.json<{ agentMode?: string }>().agentMode).toBe("plan");
    const direct = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "test-stub", model: "deterministic-tool-loop" } });
    expect(direct.json<{ agentMode?: string }>().agentMode).toBeUndefined();
    const invalid = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "test-stub", model: "deterministic-tool-loop", agentMode: "study" } });
    expect(invalid.statusCode).toBe(400);
  });
});
