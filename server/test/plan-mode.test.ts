import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { buildServer } from "../src/app.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-plan-"));
  roots.push(root);
  return root;
}

describe("plan mode — agent-runner level", () => {
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

  async function setup(agentMode: "plan" | "build", toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>) {
    const root = await tempRoot();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    // 创建后通过 updateConfig 设置 agentMode
    await sessions.updateConfig(session.id, { provider: "fake", model: "model", agentMode });
    // yolo 放行写工具，使 build 模式用例直达 fake core 而非挂起在权限审批
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

  it("plan 模式下 write_file 被门禁 → tool_result isError", async () => {
    const { detail } = await setup("plan", [
      { name: "write_file", id: "wf-1", input: { path: "test.txt", content: "hello" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "wf-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect((toolResult as { content: string }).content).toContain("Plan 模式为只读");
  });

  it("plan 模式下 bash 被门禁 → tool_result isError", async () => {
    const { detail } = await setup("plan", [
      { name: "bash", id: "bash-1", input: { cmd: "echo hi" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "bash-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect((toolResult as { content: string }).content).toContain("Plan 模式为只读");
  });

  it("plan 模式下 edit_file 被门禁 → tool_result isError", async () => {
    const { detail } = await setup("plan", [
      { name: "edit_file", id: "ef-1", input: { path: "test.txt", oldText: "a", newText: "b" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "ef-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect((toolResult as { content: string }).content).toContain("Plan 模式为只读");
  });

  it("plan 模式下 read_file 放行", async () => {
    const { detail } = await setup("plan", [
      { name: "read_file", id: "rf-1", input: { path: "test.txt" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "rf-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
  });

  it("plan 模式下 glob 放行", async () => {
    const { detail } = await setup("plan", [
      { name: "glob", id: "glob-1", input: { path: ".", pattern: "*.ts" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "glob-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
  });

  it("plan 模式下 grep 放行", async () => {
    const { detail } = await setup("plan", [
      { name: "grep", id: "grep-1", input: { path: ".", pattern: "TODO" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "grep-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
  });

  it("mcp__ 前缀工具在 plan 模式被拦截", async () => {
    const { detail } = await setup("plan", [
      { name: "mcp__filesystem_read", id: "mcp-1", input: { path: "/test" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "mcp-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect((toolResult as { content: string }).content).toContain("Plan 模式为只读");
  });

  it("build 模式下 write_file 不被 plan 门禁拦截", { timeout: 15_000 }, async () => {
    const { detail } = await setup("build", [
      { name: "write_file", id: "wf-2", input: { path: "test.txt", content: "hello" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "wf-2");
    expect(toolResult).toBeDefined();
    // build 模式下走到 core.writeFile，fake core 返回 ok:true
    // 关键是 error 消息不含 "Plan 模式为只读"
    expect((toolResult as { content: string }).content).not.toContain("Plan 模式为只读");
  });

  it("build 模式下 bash 不被 plan 门禁拦截", { timeout: 15_000 }, async () => {
    const { detail } = await setup("build", [
      { name: "bash", id: "bash-2", input: { cmd: "echo hello" } },
    ]);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "bash-2");
    expect(toolResult).toBeDefined();
    expect((toolResult as { content: string }).content).not.toContain("Plan 模式为只读");
  });

  it("plan 模式 provider 收到的 system 含 PLAN mode 指令", async () => {
    const { requests } = await setup("plan", [
      { name: "read_file", id: "rf-2", input: { path: "a.txt" } },
    ]);
    expect(requests[0]?.system).toContain("PLAN mode");
  });

  it("build 模式 provider 收到的 system 不含 PLAN mode 指令", async () => {
    const { requests } = await setup("build", [
      { name: "read_file", id: "rf-3", input: { path: "a.txt" } },
    ]);
    expect(requests[0]?.system).not.toContain("PLAN mode");
  });

  it("PUT config agentMode 非法值 → 400", async () => {
    const root = await tempRoot();
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
    expect(body1.error).toContain("agentMode");

    // "plan" 合法
    const res2 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "plan" } });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.agentMode).toBe("plan");

    // "build" 合法（build 值不落盘）
    const res3 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "build" } });
    expect(res3.statusCode).toBe(200);
    const body3 = JSON.parse(res3.body);
    expect(body3.agentMode).toBeUndefined();

    // 恢复为 build（缺省不落盘）
    const res4 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "plan" } });
    expect(res4.statusCode).toBe(200);
    const res5 = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "build" } });
    expect(res5.statusCode).toBe(200);
    const body5 = JSON.parse(res5.body);
    expect(body5.agentMode).toBeUndefined();
  });

  it("创建会话时 agentMode=plan 落盘，缺省不落盘，非法值 400", async () => {
    const root = await tempRoot();
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
