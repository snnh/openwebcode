import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { AgentRegistry } from "../src/agents.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { FastModelClient } from "../src/fast-model.js";
import { ModelRoleResolver } from "../src/model-roles.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { DEFAULT_PROVIDER_MAX_ATTEMPTS } from "../src/providers/retry.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { encodeFastModelSelection, SettingsService } from "../src/settings-service.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

const USAGE = { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 } as const;

async function setup(fallbackModels: Array<{ provider: string; model: string }>) {
  const root = await tempRoot("owc-model-fallback-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "main", model: "m1", fallbackModels });
  // 本组只验证模型切换链，排除真实快照对临时目录的干扰；
  // updateConfig 的 undefined=清除语义要求原样透传 fallbackModels
  await sessions.updateConfig(session.id, { provider: "main", model: "m1", snapshotMode: "manual", fallbackModels });
  // yolo：工具调用不经权限确认，聚焦模型切换路径
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  return {
    root,
    sessions,
    sessionId: session.id,
    pricing,
    usageLog: new UsageLog(path.join(root, "data")),
    providers: new ProviderRegistry(),
    events: new EventBus(),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function makeRunner(harness: Harness): AgentRunner {
  return new AgentRunner(
    harness.sessions,
    harness.providers,
    makeFakeCore(),
    harness.events,
    harness.pricing,
    undefined, // exchange rates
    "zh-CN",
    50,
    undefined, // profile
    harness.usageLog,
  );
}

describe("AgentRunner 会话级模型 fallback", () => {
  it("主模型 overloaded/rate_limit 重试耗尽后自动切到备选模型续跑，usage 两模型各归各", async () => {
    const harness = await setup([{ provider: "backup", model: "m2" }]);
    let mainCalls = 0;
    let backupCalls = 0;
    // 首轮主模型正常（工具调用），第二轮主模型 429 重试耗尽 → 切 backup 收尾
    harness.providers.register({
      name: "main",
      async *streamChat(request) {
        mainCalls += 1;
        if (request.messages.at(-1)?.role === "tool") throw Object.assign(new Error("rate limited"), { status: 429 });
        yield { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "echo hi" } };
        yield { ...USAGE };
        yield { type: "done", stopReason: "tool_use" };
      },
    } as Provider);
    harness.providers.register({
      name: "backup",
      async *streamChat() {
        backupCalls += 1;
        yield { type: "text_delta", text: "fallback reply" };
        yield { ...USAGE, inputTokens: 2, outputTokens: 2 };
        yield { type: "done", stopReason: "end_turn" };
      },
    } as Provider);
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));

    await makeRunner(harness).run(harness.sessionId, "跑个命令再回答");

    // 主模型：首轮 1 次 + 次轮默认重试次数耗尽；备选模型只尝试一次
    expect(mainCalls).toBe(1 + DEFAULT_PROVIDER_MAX_ATTEMPTS);
    expect(backupCalls).toBe(1);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.model_fallback",
        payload: {
          from: { provider: "main", model: "m1" },
          to: { provider: "backup", model: "m2" },
          kind: "rate_limit",
          message: "rate limited",
        },
      }),
    ]));
    expect(observed.some((event) => event.type === "agent.error")).toBe(false);
    const detail = await harness.sessions.get(harness.sessionId);
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(detail?.messages.at(-1)?.content).toEqual([{ type: "text", text: "fallback reply" }]);
    // usage 记账按实际 provider/model 逐 turn 记录：首轮记 main/m1，切换后记 backup/m2
    const usage = (await harness.usageLog.readAll()).map((event) => ({ provider: event.provider, model: event.model }));
    expect(usage).toEqual([
      { provider: "main", model: "m1" },
      { provider: "backup", model: "m2" },
    ]);
    // 切换只影响本 run：会话主模型字段不变
    expect(await harness.sessions.get(harness.sessionId)).toMatchObject({ provider: "main", model: "m1" });
  });

  it("不可恢复错误（401 鉴权）不切换、直接失败", async () => {
    const harness = await setup([{ provider: "backup", model: "m2" }]);
    let mainCalls = 0;
    let backupCalls = 0;
    harness.providers.register({
      name: "main",
      async *streamChat() {
        mainCalls += 1;
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      },
    } as Provider);
    harness.providers.register({
      name: "backup",
      async *streamChat() {
        backupCalls += 1;
        yield { type: "done", stopReason: "end_turn" };
      },
    } as Provider);
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));

    await expect(makeRunner(harness).run(harness.sessionId, "401 不应触发切换")).rejects.toThrow("invalid api key");

    expect(mainCalls).toBe(1);
    expect(backupCalls).toBe(0);
    expect(observed.some((event) => event.type === "agent.model_fallback")).toBe(false);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.error", payload: expect.objectContaining({ kind: "authentication", retryable: false }) }),
    ]));
  });

  it("链穷尽报错结束；每个候选每 run 只尝试一次；未配置 provider 的候选被跳过", async () => {
    // ghost 未注册：链上跳过；backup 同样 429 耗尽 → 链走完按原 agent.error 路径失败
    const harness = await setup([{ provider: "ghost", model: "g" }, { provider: "backup", model: "m2" }]);
    let mainCalls = 0;
    let backupCalls = 0;
    const broken = (name: string, counter: () => void): Provider => ({
      name,
      async *streamChat() {
        counter();
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
    } as Provider);
    harness.providers.register(broken("main", () => { mainCalls += 1; }));
    harness.providers.register(broken("backup", () => { backupCalls += 1; }));
    const observed: Array<{ type: string; payload: unknown }> = [];
    harness.events.on("event", (event) => observed.push(event));

    await expect(makeRunner(harness).run(harness.sessionId, "链穷尽后报错")).rejects.toThrow("rate limited");

    // 每个候选恰好一次 turn 的重试集（默认重试次数次 attempt），不二次尝试
    expect(mainCalls).toBe(DEFAULT_PROVIDER_MAX_ATTEMPTS);
    expect(backupCalls).toBe(DEFAULT_PROVIDER_MAX_ATTEMPTS);
    const switches = observed.filter((event) => event.type === "agent.model_fallback");
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ payload: { from: { provider: "main", model: "m1" }, to: { provider: "backup", model: "m2" } } });
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.error", payload: expect.objectContaining({ kind: "rate_limit", retryable: true }) }),
    ]));
  });
});

describe("会话备选模型 REST 透传", () => {
  let root: string;
  let sessions: SessionStore;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    root = await tempRoot("owc-model-fallback-api-");
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

  it("POST /api/sessions：归一化持久化（剔除与主模型重复/彼此重复项）；形状非法或超上限 400", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        cwd: root,
        provider: "anthropic",
        model: "m",
        fallbackModels: [
          { provider: "anthropic", model: "m" }, // 与主模型重复：剔除
          { provider: "backup", model: "b1" },
          { provider: "backup", model: "b1" }, // 彼此重复：剔除
          { provider: "backup", model: "b2" },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ fallbackModels: [{ provider: "backup", model: "b1" }, { provider: "backup", model: "b2" }] });

    const notArray = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", fallbackModels: "backup/b1" } });
    expect(notArray.statusCode).toBe(400);
    const missingModel = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", fallbackModels: [{ provider: "backup" }] } });
    expect(missingModel.statusCode).toBe(400);
    const tooMany = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { cwd: root, provider: "anthropic", model: "m", fallbackModels: [1, 2, 3, 4].map((n) => ({ provider: "backup", model: `b${n}` })) },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("PUT /config：设置/清除/缺省保持，与 toolsAllow 同款语义", async () => {
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "m" });
    const set = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { fallbackModels: [{ provider: "backup", model: "b" }] } });
    expect(set.statusCode).toBe(200);
    expect(await sessions.get(session.id)).toMatchObject({ fallbackModels: [{ provider: "backup", model: "b" }] });
    // 缺省保持不变
    const keep = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "m2" } });
    expect(keep.statusCode).toBe(200);
    expect(await sessions.get(session.id)).toMatchObject({ fallbackModels: [{ provider: "backup", model: "b" }] });
    // null 清除
    const cleared = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { fallbackModels: null } });
    expect(cleared.statusCode).toBe(200);
    expect(await sessions.get(session.id)).not.toHaveProperty("fallbackModels");
    // 空数组同样清除
    await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { fallbackModels: [{ provider: "backup", model: "b" }] } });
    const clearedByEmpty = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { fallbackModels: [] } });
    expect(clearedByEmpty.statusCode).toBe(200);
    expect(await sessions.get(session.id)).not.toHaveProperty("fallbackModels");
    // 形状校验
    const invalid = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { fallbackModels: "backup/b" } });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("FastModelClient", () => {
  it("reuses the selected provider and forwards model request parameters", async () => {
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "thinking_delta", text: "hidden" };
        yield { type: "text_delta", text: "快速" };
        yield { type: "text_delta", text: "回答" };
        yield { type: "usage", inputTokens: 12, outputTokens: 4, cacheRead: 0, cacheWrite: 0 };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const client = new FastModelClient(providers, {
      provider: "shared-provider",
      model: "fast-1",
      thinking: "enabled",
      effort: "high",
    });

    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 512 })).resolves.toEqual({
      text: "快速回答",
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "fast-1",
      thinking: "enabled",
      effort: "high",
      system: "system",
      tools: [],
      maxTokens: 512,
      messages: [{ role: "user", content: [{ type: "text", text: "prompt" }] }],
    });
  });

  it("forwards the caller-required maxTokens without any config cap and reports unavailable providers", async () => {
    const requests: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    // 无全局钳制：调用方给多少就透传多少
    await client.complete({ system: "system", prompt: "prompt", maxTokens: 8_192 });
    expect(requests[0]?.maxTokens).toBe(8_192);

    client.setConfig({ provider: "disabled-provider", model: "fast-2" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("快速模型服务商不可用");
  });

  it("经 collectProviderTurn 重试：可重试失败第二次成功（maxAttempts=2）", async () => {
    let attempts = 0;
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        attempts += 1;
        if (attempts === 1) throw new ProviderError("overloaded", "瞬时限流", true);
        yield { type: "text_delta", text: "重试成功" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toMatchObject({ text: "重试成功" });
    expect(attempts).toBe(2);
  });

  it("不可重试失败不重试", async () => {
    let attempts = 0;
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        attempts += 1;
        throw new ProviderError("authentication", "bad key", false);
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("快速模型请求失败");
    expect(attempts).toBe(1);
  });

  it("空 text + max_tokens：翻倍预算重试一次，第二次成功且 usage 合并", async () => {
    const requests: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "thinking_delta", text: "推理占满预算" };
          yield { type: "usage", inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 };
          yield { type: "done", stopReason: "max_tokens" };
        } else {
          yield { type: "text_delta", text: "兜底成功" };
          yield { type: "usage", inputTokens: 10, outputTokens: 8, cacheRead: 0, cacheWrite: 0 };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toEqual({ text: "兜底成功", usage: { inputTokens: 110, outputTokens: 58 } });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.maxTokens).toBe(256);
    expect(requests[1]?.maxTokens).toBe(512);
  });

  it("重试仍空但有 thinking_delta：返回 thinking 文本", async () => {
    const requests: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "thinking_delta", text: "思考结论" };
        yield { type: "done", stopReason: "max_tokens" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toMatchObject({ text: "思考结论" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.maxTokens).toBe(512);
  });

  it("空 text + end_turn 但有 thinking：不重试，直接返回 thinking", async () => {
    let attempts = 0;
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        attempts += 1;
        yield { type: "thinking_delta", text: "结论" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 }))
      .resolves.toMatchObject({ text: "结论" });
    expect(attempts).toBe(1);
  });

  it("空 text 且无任何 thinking：仍抛「快速模型返回为空」", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("快速模型返回为空");
  });

  it("refusal 仍抛模型停止原因（不做空结果兜底）", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      name: "shared-provider",
      async *streamChat() {
        yield { type: "thinking_delta", text: "被拒绝前的思考" };
        yield { type: "done", stopReason: "refusal" };
      },
    });
    const client = new FastModelClient(providers, { provider: "shared-provider", model: "fast-1" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 256 })).rejects.toThrow("模型停止原因：refusal");
  });
});

async function loadResolver(env: NodeJS.ProcessEnv, providers: ProviderRegistry): Promise<ModelRoleResolver> {
  const root = await tempRoot("owc-model-roles-");
  const settings = await SettingsService.load({ env, filePath: path.join(root, "server-settings.json") });
  return new ModelRoleResolver(settings, providers);
}

describe("ModelRoleResolver", () => {
  it("resolves configured roles; the fast role reads the existing fastModel setting", async () => {
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("main"));
    const resolver = await loadResolver({
      OWC_ROLE_MODEL_PREMIUM: encodeFastModelSelection("main", "premium-m"),
      OWC_FAST_MODEL: encodeFastModelSelection("main", "fast-m"),
    }, providers);
    expect(resolver.resolve("premium")).toEqual({ provider: "main", model: "premium-m" });
    expect(resolver.resolve("fast")).toEqual({ provider: "main", model: "fast-m" });
    expect(resolver.resolve("balanced")).toBeUndefined();
    expect(resolver.resolve("cheap")).toBeUndefined();
  });

  it("falls back role -> balanced -> caller fallback", async () => {
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("main"));
    const sessionDefault = { provider: "main", model: "session-m" };
    const resolver = await loadResolver({
      OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("main", "bal-m"),
    }, providers);
    expect(resolver.resolveWithFallback("cheap", sessionDefault)).toEqual({ provider: "main", model: "bal-m" });
    expect(resolver.resolveWithFallback("balanced", sessionDefault)).toEqual({ provider: "main", model: "bal-m" });
    // balanced 自身未配置时不绕圈，直接到调用方 fallback
    const bare = await loadResolver({}, providers);
    expect(bare.resolveWithFallback("premium", sessionDefault)).toEqual(sessionDefault);
    expect(bare.resolveWithFallback("balanced", sessionDefault)).toEqual(sessionDefault);
  });

  it("treats a role whose provider was unregistered as unconfigured", async () => {
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("main"));
    const resolver = await loadResolver({
      OWC_ROLE_MODEL_PREMIUM: encodeFastModelSelection("main", "premium-m"),
    }, providers);
    expect(resolver.resolve("premium")).toBeDefined();
    providers.unregister("main");
    expect(resolver.resolve("premium")).toBeUndefined();
    expect(resolver.resolveWithFallback("premium", { provider: "other", model: "m" })).toEqual({ provider: "other", model: "m" });
  });

  it("follows settings updates without rewiring (hot)", async () => {
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("main"));
    const root = await tempRoot("owc-model-roles-");
    // 未 bind 时 update 只做编码校验（目录校验需要 deps），足够驱动热更新断言
    const settings = await SettingsService.load({ env: {}, filePath: path.join(root, "server-settings.json") });
    const resolver = new ModelRoleResolver(settings, providers);
    expect(resolver.resolve("cheap")).toBeUndefined();
    await settings.update({ roleModelCheap: encodeFastModelSelection("main", "cheap-m") });
    expect(resolver.resolve("cheap")).toEqual({ provider: "main", model: "cheap-m" });
  });
});

interface SpawnFixture {
  runner: AgentRunner;
  sessionId: string;
  sessions: SessionStore;
  /** provider 名 → 该 provider 收到的请求（主循环与子代理请求混在一起，按 system 区分） */
  requests: Map<string, StreamChatRequest[]>;
  captured: AppEvent[];
  usageLog: UsageLog;
}

/**
 * 角色分发 fixture：main 为主会话 provider（首轮发出 spawn 调用），
 * fm-provider/role-provider 为角色档目标 provider（只应收子代理请求，直接回结论）。
 */
async function setupRoleSpawn(options: {
  env?: NodeJS.ProcessEnv;
  agents?: Record<string, string>;
  spawnTool: "spawn_task" | "spawn_swarm";
  spawnInput: Record<string, unknown>;
}): Promise<SpawnFixture> {
  const root = await tempRoot("owc-model-roles-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "main", model: "main-model" });
  if (options.spawnTool === "spawn_swarm") {
    // spawn_swarm 为会话级开关（默认关）：显式开启
    await sessions.updateConfig(session.id, { provider: "main", model: "main-model", swarmEnabled: true });
  }
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const captured: AppEvent[] = [];
  events.on("event", (event: AppEvent) => captured.push(event));
  const usageLog = new UsageLog(root);
  const requests = new Map<string, StreamChatRequest[]>();
  const record = (name: string, request: StreamChatRequest) => {
    requests.set(name, [...(requests.get(name) ?? []), request]);
  };
  let mainTurn = 0;
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("main", async function* (request) {
    record("main", request);
    if (request.system.includes("exploration sub-agent")) {
      // 角色未配置/回落到会话默认时，子代理请求会落回 main
      yield { type: "text_delta", text: "会话默认模型结论" };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    if (mainTurn++ === 0) {
      yield { type: "tool_call", id: "spawn-1", name: options.spawnTool, input: options.spawnInput };
      yield { type: "done", stopReason: "tool_use" };
    } else {
      yield { type: "text_delta", text: "完成" };
      yield { type: "done", stopReason: "end_turn" };
    }
  }));
  for (const name of ["fm-provider", "role-provider"]) {
    providers.register(makeStubProvider(name, async function* (request) {
      record(name, request);
      yield { type: "usage", inputTokens: 7, outputTokens: 3, cacheRead: 0, cacheWrite: 0 };
      yield { type: "text_delta", text: `${name} 结论` };
      yield { type: "done", stopReason: "end_turn" };
    }));
  }
  const settings = await SettingsService.load({
    env: options.env ?? {},
    filePath: path.join(root, "server-settings.json"),
  });
  let registry: AgentRegistry | undefined;
  if (options.agents) {
    const globalDir = path.join(root, "agents");
    await mkdir(globalDir, { recursive: true });
    for (const [name, text] of Object.entries(options.agents)) {
      await writeFile(path.join(globalDir, `${name}.md`), text, "utf8");
    }
    registry = new AgentRegistry(globalDir);
  }
  const runner = new AgentRunner(
    sessions, providers, makeFakeCore(), events, pricing,
    undefined, "zh-CN", 50, undefined, usageLog,
    undefined, undefined, undefined, undefined, registry,
  );
  runner.setModelRoleResolver(new ModelRoleResolver(settings, providers));
  return { runner, sessionId: session.id, sessions, requests, captured, usageLog };
}

describe("spawn_task role dispatch", () => {
  it("routes the sub-agent to the role provider/model, attributes usage to it, and advertises the mapping", async () => {
    const fixture = await setupRoleSpawn({
      env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model") },
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审", role: "cheap" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");

    // 子代理请求落在角色 provider，model 为角色模型；主 provider 不见子代理请求
    const roleRequests = fixture.requests.get("role-provider") ?? [];
    expect(roleRequests).toHaveLength(1);
    expect(roleRequests[0]?.model).toBe("role-model");
    expect(roleRequests[0]?.system).toContain("exploration sub-agent");
    expect((fixture.requests.get("main") ?? []).every((request) => !request.system.includes("exploration sub-agent"))).toBe(true);
    expect(fixture.requests.has("fm-provider")).toBe(false);

    // 记账 provider/model 归属角色档（readAll 排空写队列，无竞态）
    const usage = await fixture.usageLog.readAll();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: "role-provider", model: "role-model", inputTokens: 7, outputTokens: 3 });

    // 主循环系统提示含角色映射段：cheap 指向配置，其余档标注回落
    const mainSystem = fixture.requests.get("main")?.[0]?.system ?? "";
    expect(mainSystem).toContain("Sub-agent model roles");
    expect(mainSystem).toContain("cheap: lowest cost");
    expect(mainSystem).toContain("role-model [role-provider]");
    expect(mainSystem).toContain("not configured, falls back to balanced");
  });

  it("falls back to balanced and then the session model when the requested role is unconfigured", async () => {
    const balanced = await setupRoleSpawn({
      env: { OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("fm-provider", "bal-model") },
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审", role: "cheap" },
    });
    await balanced.runner.run(balanced.sessionId, "派单");
    expect((balanced.requests.get("fm-provider") ?? [])[0]?.model).toBe("bal-model");

    const sessionDefault = await setupRoleSpawn({
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审", role: "premium" },
    });
    await sessionDefault.runner.run(sessionDefault.sessionId, "派单");
    const mainSub = (sessionDefault.requests.get("main") ?? []).find((request) => request.system.includes("exploration sub-agent"));
    expect(mainSub?.model).toBe("main-model");
  });

  it("rejects an unknown role value before launching anything", async () => {
    const fixture = await setupRoleSpawn({
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审", role: "bogus" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    const detail = await fixture.sessions.get(fixture.sessionId);
    const toolResult = detail?.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "spawn-1");
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as { content: string }).content).toContain("Unknown model role: bogus");
    expect(fixture.requests.has("fm-provider")).toBe(false);
    expect(fixture.requests.has("role-provider")).toBe(false);
  });
});

describe("spawn_task default role (balanced)", () => {
  it("routes an unroled sub-agent to the balanced tier when configured", async () => {
    const fixture = await setupRoleSpawn({
      env: { OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("fm-provider", "bal-model") },
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    const balancedRequests = fixture.requests.get("fm-provider") ?? [];
    expect(balancedRequests).toHaveLength(1);
    expect(balancedRequests[0]?.model).toBe("bal-model");
    expect(balancedRequests[0]?.system).toContain("exploration sub-agent");
    expect((fixture.requests.get("main") ?? []).every((request) => !request.system.includes("exploration sub-agent"))).toBe(true);
  });

  it("falls back to the session model when balanced is not configured", async () => {
    const fixture = await setupRoleSpawn({
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    const mainSub = (fixture.requests.get("main") ?? []).find((request) => request.system.includes("exploration sub-agent"));
    expect(mainSub?.model).toBe("main-model");
    expect(fixture.requests.has("fm-provider")).toBe(false);
    expect(fixture.requests.has("role-provider")).toBe(false);
  });
});

describe("frontmatter provider/model/role precedence", () => {
  it("prefers explicit frontmatter provider:/model: over any role", async () => {
    const fixture = await setupRoleSpawn({
      env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model") },
      agents: { explicit: "---\ndescription: d\nprovider: fm-provider\nmodel: fm-model\n---\nEXPLICIT BODY" },
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审", agent: "explicit", role: "cheap" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    const fm = fixture.requests.get("fm-provider") ?? [];
    expect(fm).toHaveLength(1);
    expect(fm[0]?.model).toBe("fm-model");
    expect(fm[0]?.system).toContain("EXPLICIT BODY");
    expect(fixture.requests.has("role-provider")).toBe(false);
  });

  it("prefers frontmatter role: over the call-level role", async () => {
    const fixture = await setupRoleSpawn({
      env: {
        OWC_ROLE_MODEL_PREMIUM: encodeFastModelSelection("fm-provider", "premium-model"),
        OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model"),
      },
      agents: { roled: "---\ndescription: d\nrole: premium\n---\nROLED BODY" },
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审", agent: "roled", role: "cheap" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    expect((fixture.requests.get("fm-provider") ?? [])[0]?.model).toBe("premium-model");
    expect(fixture.requests.has("role-provider")).toBe(false);
  });

  it("applies the call-level role when the frontmatter sets neither provider/model nor role", async () => {
    const fixture = await setupRoleSpawn({
      env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model") },
      agents: { plain: "---\ndescription: d\n---\nPLAIN BODY" },
      spawnTool: "spawn_task",
      spawnInput: { prompt: "评审", agent: "plain", role: "cheap" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    expect((fixture.requests.get("role-provider") ?? [])[0]?.model).toBe("role-model");
  });
});

describe("spawn_swarm role dispatch", () => {
  it("applies the call-level role and lets an item override it", async () => {
    const fixture = await setupRoleSpawn({
      env: {
        OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("fm-provider", "bal-model"),
        OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "cheap-model"),
      },
      spawnTool: "spawn_swarm",
      spawnInput: {
        prompt_template: "评审 {{item}}",
        items: ["a.ts", { task: "b.ts", role: "cheap" }],
        role: "balanced",
      },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    expect((fixture.requests.get("fm-provider") ?? []).map((request) => request.model)).toEqual(["bal-model"]);
    expect((fixture.requests.get("role-provider") ?? []).map((request) => request.model)).toEqual(["cheap-model"]);
  });
});
