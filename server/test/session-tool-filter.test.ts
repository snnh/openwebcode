import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { filterBuiltInTools, READ_ONLY_TOOL_NAMES, toolAllowedBySession } from "../src/agent/tool-schemas.js";
import { buildServer } from "../src/app.js";
import type { CoreClient, CoreClientLike, CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type ProviderTool, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

function fakeTool(name: string): ProviderTool {
  return { name, description: name, inputSchema: { type: "object", additionalProperties: false } };
}

describe("filterBuiltInTools / toolAllowedBySession", () => {
  const tools = ["bash", "read_file", "write_file", "glob", "ask_user"].map(fakeTool);

  it("allow/deny 均缺省或为空：原样返回", () => {
    expect(filterBuiltInTools(tools)).toBe(tools);
    expect(filterBuiltInTools(tools, [], [])).toBe(tools);
  });

  it("toolsAllow 非空：仅保留名单内内置工具", () => {
    expect(filterBuiltInTools(tools, ["read_file", "glob"]).map((tool) => tool.name)).toEqual(["read_file", "glob", "ask_user"]);
  });

  it("toolsDeny 在 allow 结果上再剔除", () => {
    expect(filterBuiltInTools(tools, ["read_file", "glob", "write_file"], ["write_file"]).map((tool) => tool.name)).toEqual(["read_file", "glob", "ask_user"]);
    expect(filterBuiltInTools(tools, undefined, ["bash", "write_file"]).map((tool) => tool.name)).toEqual(["read_file", "glob", "ask_user"]);
  });

  it("未知工具名静默忽略（不报错也不产生效果）", () => {
    expect(filterBuiltInTools(tools, ["read_file", "no_such_tool"]).map((tool) => tool.name)).toEqual(["read_file", "ask_user"]);
    expect(filterBuiltInTools(tools, undefined, ["no_such_tool"]).map((tool) => tool.name)).toEqual(["bash", "read_file", "write_file", "glob", "ask_user"]);
  });

  it("交互类工具（ask_user/exit_plan_mode）始终保留，不受 allow/deny 影响", () => {
    expect(toolAllowedBySession("ask_user", ["read_file"], ["ask_user"])).toBe(true);
    expect(toolAllowedBySession("exit_plan_mode", ["read_file"], ["exit_plan_mode"])).toBe(true);
    expect(toolAllowedBySession("bash", ["read_file"])).toBe(false);
  });

  it("READ_ONLY_TOOL_NAMES 为只读集：含读类工具，不含写/进程类工具", () => {
    expect(READ_ONLY_TOOL_NAMES).toContain("read_file");
    expect(READ_ONLY_TOOL_NAMES).toContain("glob");
    expect(READ_ONLY_TOOL_NAMES).toContain("grep");
    expect(READ_ONLY_TOOL_NAMES).toContain("repo_map");
    expect(READ_ONLY_TOOL_NAMES).toContain("code_search");
    expect(READ_ONLY_TOOL_NAMES).not.toContain("bash");
    expect(READ_ONLY_TOOL_NAMES).not.toContain("write_file");
    expect(READ_ONLY_TOOL_NAMES).not.toContain("edit_file");
  });
});

const FAKE_CORE_INFO: CoreInfo = {
  version: "0.8.0-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

function createFakeCore(): CoreClientLike {
  const core = {
    on() { return core; },
    async ping() { return FAKE_CORE_INFO; },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async readFile() { return { path: "x", content: "", totalLines: 0, encoding: "utf-8", truncated: false }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 1 }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    async run() { return { exitCode: 0, durationMs: 1, truncated: false }; },
  };
  return core as unknown as CoreClientLike;
}

const GENERAL_MARKER = "general-purpose coding sub-agent";

describe("会话级工具过滤（agent loop 集成）", () => {
  let root: string;
  let sessions: SessionStore;
  let pricing: PricingCatalog;
  let events: EventBus;

  beforeEach(async () => {
    root = await tempRoot("owc-tool-filter-");
    sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    events = new EventBus();
  });

  async function createSession(toolsAllow?: string[], toolsDeny?: string[]) {
    const session = await sessions.create({ cwd: root, provider: "fake", model: "test-model", ...(toolsAllow ? { toolsAllow } : {}), ...(toolsDeny ? { toolsDeny } : {}) });
    // 与 general-subagent 测试同款：手动快照，避免自动检查点触发快照后端探测
    // （updateConfig 的 undefined=清除语义要求原样透传 toolsAllow/toolsDeny）
    await sessions.updateConfig(session.id, { provider: "fake", model: "test-model", snapshotMode: "manual", ...(toolsAllow ? { toolsAllow } : {}), ...(toolsDeny ? { toolsDeny } : {}) });
    await sessions.updatePermissions(session.id, "yolo", []);
    return session;
  }

  it("主循环：toolsAllow/toolsDeny 过滤内置工具，ask_user 始终保留", async () => {
    const session = await createSession(["read_file", "grep"], ["grep"]);
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, createFakeCore(), events, pricing);

    await runner.run(session.id, "你好");

    const names = requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("read_file");
    expect(names).toContain("ask_user");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
  });

  it("子代理继承：general 子代理的工具集同样被 toolsDeny 剔除", async () => {
    const session = await createSession(undefined, ["bash", "write_file", "edit_file"]);
    const subRequests: StreamChatRequest[] = [];
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes(GENERAL_MARKER)) {
          subRequests.push(request);
          yield { type: "text_delta", text: "子代理结论" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "看看工作区", agent: "general" } };
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

    await runner.run(session.id, "派生子代理");

    expect(subRequests).toHaveLength(1);
    const subNames = subRequests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(subNames).toContain("read_file");
    expect(subNames).not.toContain("bash");
    expect(subNames).not.toContain("write_file");
    expect(subNames).not.toContain("edit_file");
  });

  it("toolsAllow 白名单同样约束子代理（explore 默认只读集 ∩ 白名单）", async () => {
    // 白名单需显式含 spawn_task，否则主代理自身也拿不到派发工具
    const session = await createSession(["read_file", "spawn_task"]);
    const subRequests: StreamChatRequest[] = [];
    let mainTurn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        if (request.system.includes("read-only exploration sub-agent")) {
          subRequests.push(request);
          yield { type: "text_delta", text: "探索结论" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        if (mainTurn++ === 0) {
          yield { type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "探索一下" } };
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

    await runner.run(session.id, "派生探索子代理");

    const subNames = subRequests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(subNames).toEqual(["read_file"]);
  });
});

describe("会话工具限制 REST 透传", () => {
  let root: string;
  let sessions: SessionStore;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    root = await tempRoot("owc-tool-filter-api-");
    sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const provider: Provider = { name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const agent = { isRunning: () => false } as unknown as AgentRunner;
    app = await buildServer({ core: {} as CoreClient, sessions, agent, events: new EventBus(), providers, pricing });
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /api/sessions：toolsAllow/toolsDeny 持久化；非字符串数组 400", async () => {
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", toolsAllow: ["read_file", "glob"], toolsDeny: ["bash"] } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ toolsAllow: ["read_file", "glob"], toolsDeny: ["bash"] });
    const invalidAllow = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", toolsAllow: "read_file" } });
    expect(invalidAllow.statusCode).toBe(400);
    const invalidDeny = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", toolsDeny: ["bash", 1] } });
    expect(invalidDeny.statusCode).toBe(400);
  });

  it("PUT /config：设置/清除/缺省保持，与 nodeEnv 同款语义", async () => {
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "m" });
    const setBoth = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { toolsAllow: ["read_file"], toolsDeny: ["grep"] } });
    expect(setBoth.statusCode).toBe(200);
    expect(await sessions.get(session.id)).toMatchObject({ toolsAllow: ["read_file"], toolsDeny: ["grep"] });
    // 缺省保持不变
    const keep = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "m2" } });
    expect(keep.statusCode).toBe(200);
    expect(await sessions.get(session.id)).toMatchObject({ toolsAllow: ["read_file"], toolsDeny: ["grep"] });
    // null 清除
    const cleared = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { toolsAllow: null, toolsDeny: null } });
    expect(cleared.statusCode).toBe(200);
    const afterClear = await sessions.get(session.id);
    expect(afterClear).not.toHaveProperty("toolsAllow");
    expect(afterClear).not.toHaveProperty("toolsDeny");
    // 空数组同样清除
    await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { toolsAllow: ["read_file"] } });
    const clearedByEmpty = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { toolsAllow: [] } });
    expect(clearedByEmpty.statusCode).toBe(200);
    expect(await sessions.get(session.id)).not.toHaveProperty("toolsAllow");
    // 形状校验
    const invalid = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { toolsAllow: "read_file" } });
    expect(invalid.statusCode).toBe(400);
  });
});
