import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

/* ---------------------------------- REST ---------------------------------- */

async function restFixture() {
  const root = await tempRoot("owc-prompt-api-");
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: workspace, provider: "test-stub", model: "m" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("test-stub", async function* () {
    yield { type: "done", stopReason: "end_turn" };
  }));
  const events = new EventBus();
  let refreshes = 0;
  const agent = { isRunning: () => false, refreshPromptOverride: () => { refreshes += 1; } } as unknown as AgentRunner;
  const core = {} as CoreClientLike;
  const app = await buildServer({ core: core as never, sessions, agent, events, providers, pricing, dataDir });
  return { root, dataDir, workspace, session, app, refreshes: () => refreshes };
}

describe("/api/prompt 作用域", () => {
  it("scope=project 缺少 cwd 或 cwd 非任一已存在会话的工作目录时拒绝", async () => {
    const { app, root } = await restFixture();
    try {
      const missing = await app.inject({ method: "GET", url: "/api/prompt?scope=project" });
      expect(missing.statusCode).toBe(400);
      const unknown = await app.inject({ method: "GET", url: `/api/prompt?scope=project&cwd=${encodeURIComponent(path.join(root, "elsewhere"))}` });
      expect(unknown.statusCode).toBe(400);
      const putUnknown = await app.inject({
        method: "PUT",
        url: "/api/prompt",
        payload: { scope: "project", cwd: path.join(root, "elsewhere"), customAppend: "x" },
      });
      expect(putUnknown.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PUT scope=project 写入 <cwd>/.owc，GET 按作用域各读各级", async () => {
    const { app, dataDir, workspace, refreshes } = await restFixture();
    try {
      const putProject = await app.inject({
        method: "PUT",
        url: "/api/prompt",
        payload: { scope: "project", cwd: workspace, identityOverride: "proj identity", subAgentAppend: "proj subagent" },
      });
      expect(putProject.statusCode).toBe(200);
      expect(refreshes()).toBe(1);

      const project = await app.inject({ method: "GET", url: `/api/prompt?scope=project&cwd=${encodeURIComponent(workspace)}` });
      expect(project.json()).toMatchObject({ identityOverride: "proj identity", baseOverride: null, customAppend: null, subAgentAppend: "proj subagent" });
      // 全局级不受项目写入影响
      const global = await app.inject({ method: "GET", url: "/api/prompt?scope=global" });
      expect(global.json()).toMatchObject({ identityOverride: null, subAgentAppend: null });
      // 旧契约（无 scope）返回两级合并视图
      const merged = await app.inject({ method: "GET", url: `/api/prompt?cwd=${encodeURIComponent(workspace)}` });
      expect(merged.json()).toMatchObject({ identityOverride: "proj identity", subAgentAppend: "proj subagent" });
      // 全局写入后合并视图逐面回落全局
      await app.inject({ method: "PUT", url: "/api/prompt", payload: { customAppend: "global append" } });
      expect((await app.inject({ method: "GET", url: `/api/prompt?cwd=${encodeURIComponent(workspace)}` }).then((r) => r.json())))
        .toMatchObject({ customAppend: "global append", identityOverride: "proj identity" });
      expect(dataDir).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("PUT scope=project 置空删除项目级文件", async () => {
    const { app, workspace } = await restFixture();
    try {
      await app.inject({ method: "PUT", url: "/api/prompt", payload: { scope: "project", cwd: workspace, customAppend: "temp" } });
      await app.inject({ method: "PUT", url: "/api/prompt", payload: { scope: "project", cwd: workspace } });
      const view = await app.inject({ method: "GET", url: `/api/prompt?scope=project&cwd=${encodeURIComponent(workspace)}` });
      expect(view.json()).toMatchObject({ customAppend: null });
    } finally {
      await app.close();
    }
  });
});

/* ------------------------------ AgentRunner 组装 ------------------------------ */

function createFakeCore(handlers: {
  readFile?: (request: { sessionId: string; path: string }) => Promise<unknown>;
}): CoreClientLike {
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile(request: { sessionId: string; path: string }) {
      if (!handlers.readFile) throw new Error("readFile not expected");
      return handlers.readFile(request);
    },
  };
  return core as unknown as CoreClientLike;
}

interface RunnerHarnessOptions {
  files?: Record<string, string>;
  provider: Provider;
}

async function runnerHarness(options: RunnerHarnessOptions) {
  const root = await tempRoot("owc-prompt-scope-");
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(path.join(dataDir, name), content, "utf8");
  }
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(options.provider);
  const core = createFakeCore({ async readFile() { return { content: "内容" }; } });
  const agent = new AgentRunner(
    sessions, providers, core, events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined,
    dataDir,
  );
  return { root, dataDir, sessions, session, agent };
}

describe("identity 覆盖生效链路", () => {
  it("identity 覆盖文件替换默认身份行", async () => {
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text_delta", text: "好" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const { agent, session } = await runnerHarness({
      files: { "system-prompt-identity.md": "You are a meticulous reviewer.\n" },
      provider,
    });
    await agent.run(session.id, "你好");
    const system = requests[0]!.system;
    expect(system).toContain("You are a meticulous reviewer.");
    expect(system).not.toContain("You are OpenWebCode. The workspace");
  });

  it("env-sim persona 身份优先于 identity 覆盖文件", async () => {
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text_delta", text: "好" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const root = await tempRoot("owc-prompt-scope-");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "system-prompt-identity.md"), "You are a meticulous reviewer.\n", "utf8");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    providers.register(provider);
    const core = createFakeCore({ async readFile() { return { content: "内容" }; } });
    const manager = new ExtensionManager(dataDir, events, { sessions });
    await manager.initialize();
    try {
      await manager.configure("env-sim", { enabled: true, config: { persona: "claude-code" } });
      const agent = new AgentRunner(
        sessions, providers, core, events, pricing,
        undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined,
        dataDir, undefined, undefined, undefined, undefined, undefined, undefined, manager,
      );
      await agent.run(session.id, "你好");
      const system = requests[0]!.system;
      expect(system).toContain("You are Claude Code, Anthropic's agentic coding tool.");
      expect(system).not.toContain("You are a meticulous reviewer.");
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("subAgentAppend 生效链路", () => {
  it("拼入 spawn_task 子代理的系统提示", async () => {
    const requests: StreamChatRequest[] = [];
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (request.system.includes("exploration sub-agent")) {
          yield { type: "text_delta", text: "结论" };
          yield { type: "done", stopReason: "end_turn" };
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
    const { agent, session } = await runnerHarness({
      files: { "system-prompt-subagent.md": "All sub-agents answer in bullet points.\n" },
      provider,
    });
    await agent.run(session.id, "先调查再回答");
    const subRequest = requests.find((request) => request.system.includes("exploration sub-agent"));
    expect(subRequest?.system).toContain("All sub-agents answer in bullet points.");
    // 主代理系统提示不携带子代理附加指令
    expect(requests[0]!.system).not.toContain("All sub-agents answer in bullet points.");
  });

  it("refreshPromptOverride 后新值生效（共用同一缓存失效路径）", async () => {
    const requests: StreamChatRequest[] = [];
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (request.system.includes("exploration sub-agent")) {
          yield { type: "text_delta", text: "结论" };
          yield { type: "done", stopReason: "end_turn" };
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
    const { agent, session, dataDir } = await runnerHarness({ provider });
    // 首次运行后覆盖已缓存；写入新文件并刷新缓存
    await agent.run(session.id, "第一轮");
    await writeFile(path.join(dataDir, "system-prompt-subagent.md"), "v2 sub-agent rule\n", "utf8");
    agent.refreshPromptOverride();
    mainTurn = 0;
    await agent.run(session.id, "第二轮");
    const subRequests = requests.filter((request) => request.system.includes("exploration sub-agent"));
    expect(subRequests).toHaveLength(2);
    expect(subRequests[0]!.system).not.toContain("v2 sub-agent rule");
    expect(subRequests[1]!.system).toContain("v2 sub-agent rule");
  });
});
