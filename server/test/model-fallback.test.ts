import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { AgentRegistry } from "../src/agents.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { FastModelClient } from "../src/fast-model.js";
import { ModelRoleResolver } from "../src/model-roles.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type Provider, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import { DEFAULT_PROVIDER_MAX_ATTEMPTS } from "../src/providers/retry.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { encodeFastModelSelection, SettingsService } from "../src/settings-service.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";
const textEvent = (text: string): ProviderEvent => ({ type: "text_delta", text });
const thinkingEvent = (text: string): ProviderEvent => ({ type: "thinking_delta", text });
const usageEvent = (inputTokens = 1, outputTokens = 1): ProviderEvent => ({ type: "usage", inputTokens, outputTokens, cacheRead: 0, cacheWrite: 0 });
const doneEvent = (stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" | "refusal"): ProviderEvent => ({ type: "done", stopReason });
const callEvent = (id: string, name: string, input: Record<string, unknown>): ProviderEvent => ({ type: "tool_call", id, name, input });
const providerOf = (name: string, streamChat: Provider["streamChat"]): Provider => ({ name, streamChat });
const ids = (list: Array<{ provider: string; model: string }>) => list.map((entry) => `${entry.provider}/${entry.model}`);
/** 会话级 fallback harness：手动快照 + yolo（工具调用不经权限确认），聚焦模型切换路径。 */
async function setup(fallbackModels: Array<{ provider: string; model: string }>) {
  const root = await tempRoot("owc-model-fallback-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "main", model: "m1", fallbackModels });
  // updateConfig 的 undefined=清除语义要求原样透传 fallbackModels
  await sessions.updateConfig(session.id, { provider: "main", model: "m1", snapshotMode: "manual", fallbackModels });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const observed: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event) => observed.push(event));
  const usageLog = new UsageLog(path.join(root, "data"));
  const runner = new AgentRunner(sessions, providers, makeFakeCore(), events, pricing, undefined, "zh-CN", 50, undefined, usageLog);
  return { sessions, providers, observed, usageLog, runner, sessionId: session.id };
}

describe("AgentRunner 会话级模型 fallback", () => {
  it("主模型 overloaded/rate_limit 重试耗尽后自动切到备选模型续跑，usage 两模型各归各", async () => {
    const h = await setup([{ provider: "backup", model: "m2" }]);
    let mainCalls = 0;
    let backupCalls = 0;
    h.providers.register(providerOf("main", async function* (request) {
      mainCalls += 1;
      // 首轮主模型正常（工具调用），次轮 429 重试耗尽 → 切 backup 收尾
      if (request.messages.at(-1)?.role === "tool") throw Object.assign(new Error("rate limited"), { status: 429 });
      yield callEvent("call-1", "bash", { cmd: "echo hi" }); yield usageEvent(); yield doneEvent("tool_use");
    }));
    h.providers.register(providerOf("backup", async function* () {
      backupCalls += 1;
      yield textEvent("fallback reply"); yield usageEvent(2, 2); yield doneEvent("end_turn");
    }));
    await h.runner.run(h.sessionId, "跑个命令再回答");
    // 主模型：首轮 1 次 + 次轮默认重试次数耗尽；备选模型只尝试一次
    expect([mainCalls, backupCalls]).toEqual([1 + DEFAULT_PROVIDER_MAX_ATTEMPTS, 1]); expect(h.observed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent.model_fallback", payload: { from: { provider: "main", model: "m1" }, to: { provider: "backup", model: "m2" }, kind: "rate_limit", message: "rate limited" },
    })]));
    expect(h.observed.some((event) => event.type === "agent.error")).toBe(false);
    const detail = await h.sessions.get(h.sessionId); expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]); expect(detail?.messages.at(-1)?.content).toEqual([{ type: "text", text: "fallback reply" }]);
    // usage 按实际 provider/model 逐 turn 记账；切换只影响本 run（会话主模型字段不变）
    expect(ids(await h.usageLog.readAll())).toEqual(["main/m1", "backup/m2"]); expect(await h.sessions.get(h.sessionId)).toMatchObject({ provider: "main", model: "m1" });
  });

  it("不可恢复错误（401 鉴权）不切换直接失败；链穷尽报错结束且每个候选每 run 只尝试一次、未注册候选被跳过", async () => {
    const unauthorized = await setup([{ provider: "backup", model: "m2" }]);
    let mainCalls = 0;
    let backupCalls = 0;
    unauthorized.providers.register(providerOf("main", async function* (): AsyncIterable<ProviderEvent> { mainCalls += 1; throw Object.assign(new Error("invalid api key"), { status: 401 }); }));
    unauthorized.providers.register(providerOf("backup", async function* () { backupCalls += 1; yield doneEvent("end_turn"); }));
    await expect(unauthorized.runner.run(unauthorized.sessionId, "401 不应触发切换")).rejects.toThrow("invalid api key"); expect([mainCalls, backupCalls]).toEqual([1, 0]); expect(unauthorized.observed.some((event) => event.type === "agent.model_fallback")).toBe(false);
    expect(unauthorized.observed).toEqual(expect.arrayContaining([ expect.objectContaining({ type: "agent.error", payload: expect.objectContaining({ kind: "authentication", retryable: false }) })]));
    // ghost 未注册：链上跳过；backup 同样 429 耗尽 → 链走完按原 agent.error 路径失败
    const exhausted = await setup([{ provider: "ghost", model: "g" }, { provider: "backup", model: "m2" }]);
    let mainAttempts = 0;
    let backupAttempts = 0;
    const broken = (name: string, count: () => void) => providerOf(name, async function* (): AsyncIterable<ProviderEvent> { count(); throw Object.assign(new Error("rate limited"), { status: 429 }); });
    exhausted.providers.register(broken("main", () => { mainAttempts += 1; }));
    exhausted.providers.register(broken("backup", () => { backupAttempts += 1; }));
    await expect(exhausted.runner.run(exhausted.sessionId, "链穷尽后报错")).rejects.toThrow("rate limited"); expect([mainAttempts, backupAttempts]).toEqual([DEFAULT_PROVIDER_MAX_ATTEMPTS, DEFAULT_PROVIDER_MAX_ATTEMPTS]);
    const switches = exhausted.observed.filter((event) => event.type === "agent.model_fallback"); expect(switches).toHaveLength(1); expect(switches[0]).toMatchObject({ payload: { from: { provider: "main", model: "m1" }, to: { provider: "backup", model: "m2" } } });
    expect(exhausted.observed).toEqual(expect.arrayContaining([ expect.objectContaining({ type: "agent.error", payload: expect.objectContaining({ kind: "rate_limit", retryable: true }) })]));
  });
});

describe("会话备选模型 REST 透传", () => {
  it("POST 归一化持久化并拒绝非法形状/超上限；PUT 设置/缺省保持/清空，与 toolsAllow 同款语义", async () => {
    const { app, sessions, root } = await makeTestApp({
      tempPrefix: "owc-model-fallback-api-",
      configureProviders: (providers) => providers.register(providerOf("anthropic", async function* () { yield doneEvent("end_turn"); })),
    });
    try {
      const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", ...payload } });
      const created = await post({ fallbackModels: [{ provider: "anthropic", model: "m" }, { provider: "backup", model: "b1" }, { provider: "backup", model: "b1" }, { provider: "backup", model: "b2" }] });
      // 归一化：剔除与主模型重复、彼此重复项
      expect([created.statusCode, created.json()]).toMatchObject([201, { fallbackModels: [{ provider: "backup", model: "b1" }, { provider: "backup", model: "b2" }] }]);
      const invalidPayloads: Array<Record<string, unknown>> = [
        { fallbackModels: "backup/b1" }, { fallbackModels: [{ provider: "backup" }] }, { fallbackModels: [1, 2, 3, 4].map((n) => ({ provider: "backup", model: `b${n}` })) },
      ];
      for (const payload of invalidPayloads) expect((await post(payload)).statusCode).toBe(400);
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "m" });
      const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload }); expect((await put({ fallbackModels: [{ provider: "backup", model: "b" }] })).statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ fallbackModels: [{ provider: "backup", model: "b" }] });
      await put({ model: "m2" }); expect(await sessions.get(session.id)).toMatchObject({ fallbackModels: [{ provider: "backup", model: "b" }] }); expect((await put({ fallbackModels: null })).statusCode).toBe(200); expect(await sessions.get(session.id)).not.toHaveProperty("fallbackModels"); // null 清除 // 缺省保持不变：PUT 不带 fallbackModels 时保留原值
      await put({ fallbackModels: [{ provider: "backup", model: "b" }] }); expect((await put({ fallbackModels: [] })).statusCode).toBe(200); expect(await sessions.get(session.id)).not.toHaveProperty("fallbackModels"); expect((await put({ fallbackModels: "backup/b" })).statusCode).toBe(400); // 空数组同样清除
    } finally { await app.close(); }
  });
});

describe("FastModelClient", () => {
  const completionRequest = { system: "system", prompt: "prompt", maxTokens: 256 };
  function clientFor(streamChat: Provider["streamChat"], config: Record<string, unknown> = { provider: "shared-provider", model: "fast-1" }) {
    const providers = new ProviderRegistry();
    providers.register({ name: "shared-provider", streamChat });
    return new FastModelClient(providers, config as ConstructorParameters<typeof FastModelClient>[1]);
  }
  it("透传 model/thinking/effort/maxTokens（无全局钳制）；provider 不可用报错；可重试失败重试、不可重试直抛", async () => {
    const requests: StreamChatRequest[] = [];
    const client = clientFor(async function* (request) {
      requests.push(request);
      yield thinkingEvent("hidden"); yield textEvent("快速"); yield textEvent("回答"); yield usageEvent(12, 4); yield doneEvent("end_turn");
    }, { provider: "shared-provider", model: "fast-1", thinking: "enabled", effort: "high" });
    await expect(client.complete({ system: "system", prompt: "prompt", maxTokens: 512 })).resolves.toEqual({ text: "快速回答", usage: { inputTokens: 12, outputTokens: 4 } }); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "fast-1", thinking: "enabled", effort: "high", system: "system", tools: [], maxTokens: 512, messages: [{ role: "user", content: [{ type: "text", text: "prompt" }] }] });
    const unlimited = clientFor(async function* (request) { requests.push(request); yield textEvent("ok"); yield doneEvent("end_turn"); });
    await unlimited.complete({ ...completionRequest, maxTokens: 8_192 }); expect(requests.at(-1)?.maxTokens).toBe(8_192); // 无全局钳制：调用方给多少透传多少
    unlimited.setConfig({ provider: "disabled-provider", model: "fast-2" });
    await expect(unlimited.complete(completionRequest)).rejects.toThrow("快速模型服务商不可用");
    let attempts = 0;
    const flaky = clientFor(async function* () {
      attempts += 1;
      if (attempts === 1) throw new ProviderError("overloaded", "瞬时限流", true);
      yield textEvent("重试成功"); yield doneEvent("end_turn");
    });
    await expect(flaky.complete(completionRequest)).resolves.toMatchObject({ text: "重试成功" }); expect(attempts).toBe(2);
    let authAttempts = 0;
    const nonRetryable = clientFor(async function* (): AsyncIterable<ProviderEvent> { authAttempts += 1; throw new ProviderError("authentication", "bad key", false); });
    await expect(nonRetryable.complete(completionRequest)).rejects.toThrow("快速模型请求失败"); expect(authAttempts).toBe(1);
  });

  it("空 text 兜底：max_tokens 翻倍重试一次并合并 usage、thinking 兜底、end_turn+thinking 不重试、无素材与 refusal 报错", async () => {
    const requests: StreamChatRequest[] = [];
    const budgetClient = clientFor(async function* (request) {
      requests.push(request);
      if (requests.length === 1) { yield thinkingEvent("推理占满预算"); yield usageEvent(100, 50); yield doneEvent("max_tokens"); } else { yield textEvent("兜底成功"); yield usageEvent(10, 8); yield doneEvent("end_turn"); }
    });
    await expect(budgetClient.complete(completionRequest)).resolves.toEqual({ text: "兜底成功", usage: { inputTokens: 110, outputTokens: 58 } }); expect(requests.map((request) => request.maxTokens)).toEqual([256, 512]);
    // 重试仍空但有 thinking_delta：返回 thinking 文本
    const thinkingRequests: StreamChatRequest[] = [];
    const thinkingClient = clientFor(async function* (request) { thinkingRequests.push(request); yield thinkingEvent("思考结论"); yield doneEvent("max_tokens"); });
    await expect(thinkingClient.complete(completionRequest)).resolves.toMatchObject({ text: "思考结论" }); expect(thinkingRequests[1]?.maxTokens).toBe(512);
    // 空 text + end_turn 但有 thinking：不重试，直接返回 thinking
    let attempts = 0;
    const noRetry = clientFor(async function* () { attempts += 1; yield thinkingEvent("结论"); yield doneEvent("end_turn"); });
    await expect(noRetry.complete(completionRequest)).resolves.toMatchObject({ text: "结论" }); expect(attempts).toBe(1);
    const empty = clientFor(async function* () { yield doneEvent("end_turn"); });
    await expect(empty.complete(completionRequest)).rejects.toThrow("快速模型返回为空");
    const refusal = clientFor(async function* () { yield thinkingEvent("被拒绝前的思考"); yield doneEvent("refusal"); });
    await expect(refusal.complete(completionRequest)).rejects.toThrow("模型停止原因：refusal");
  });
});

describe("ModelRoleResolver", () => {
  const loadResolver = async (env: NodeJS.ProcessEnv, providers: ProviderRegistry) => {
    const settings = await SettingsService.load({ env, filePath: path.join(await tempRoot("owc-model-roles-"), "server-settings.json") });
    return { settings, resolver: new ModelRoleResolver(settings, providers) }; };
  it("解析已配置角色（fast 读既有 fastModel 设置）、回落链、provider 未注册视为未配置、设置热更新即时生效", async () => {
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("main"));
    const { settings, resolver } = await loadResolver({ OWC_ROLE_MODEL_PREMIUM: encodeFastModelSelection("main", "premium-m"), OWC_FAST_MODEL: encodeFastModelSelection("main", "fast-m") }, providers);
    expect([resolver.resolve("premium"), resolver.resolve("fast"), resolver.resolve("balanced"), resolver.resolve("cheap")]).toEqual([{ provider: "main", model: "premium-m" }, { provider: "main", model: "fast-m" }, undefined, undefined]);
    // 热更新：不重新接线即生效（未 bind 时 update 只做编码校验）
    await settings.update({ roleModelCheap: encodeFastModelSelection("main", "cheap-m") }); expect(resolver.resolve("cheap")).toEqual({ provider: "main", model: "cheap-m" });
    // provider 未注册 → 角色视为未配置，回落到调用方 fallback
    providers.unregister("main"); expect(resolver.resolve("premium")).toBeUndefined(); expect(resolver.resolveWithFallback("premium", { provider: "other", model: "m" })).toEqual({ provider: "other", model: "m" });
    // 回落链：角色 → balanced → 调用方 fallback
    const providers2 = new ProviderRegistry();
    providers2.register(makeStubProvider("main"));
    const sessionDefault = { provider: "main", model: "session-m" };
    const { resolver: balanced } = await loadResolver({ OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("main", "bal-m") }, providers2);
    expect([balanced.resolveWithFallback("cheap", sessionDefault), balanced.resolveWithFallback("balanced", sessionDefault)]).toEqual([{ provider: "main", model: "bal-m" }, { provider: "main", model: "bal-m" }]);
    const bare = await loadResolver({}, providers2); expect([bare.resolver.resolveWithFallback("premium", sessionDefault), bare.resolver.resolveWithFallback("balanced", sessionDefault)]).toEqual([sessionDefault, sessionDefault]); // balanced 自身未配置时不绕圈
  });
});
/** 角色分发 fixture：main 首轮发出 spawn 调用；fm-provider/role-provider 只应收子代理请求（requests 按 provider 名收集主循环与子代理请求，靠 system 区分）。 */
async function setupRoleSpawn(options: {
  env?: NodeJS.ProcessEnv;
  agents?: Record<string, string>;
  spawnTool: "spawn_task" | "spawn_swarm";
  spawnInput: Record<string, unknown>;
}) {
  const root = await tempRoot("owc-model-roles-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "main", model: "main-model" });
  if (options.spawnTool === "spawn_swarm") await sessions.updateConfig(session.id, { provider: "main", model: "main-model", swarmEnabled: true }); // 会话级开关默认关
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const usageLog = new UsageLog(root);
  const requests = new Map<string, StreamChatRequest[]>();
  const record = (name: string, request: StreamChatRequest) => requests.set(name, [...(requests.get(name) ?? []), request]);
  let mainTurn = 0;
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("main", async function* (request) {
    record("main", request);
    // 角色未配置/回落会话默认时，子代理请求会落回 main
    if (request.system.includes("exploration sub-agent")) { yield textEvent("会话默认模型结论"); yield doneEvent("end_turn"); return; }
    if (mainTurn++ === 0) { yield callEvent("spawn-1", options.spawnTool, options.spawnInput); yield doneEvent("tool_use"); }
    else { yield textEvent("完成"); yield doneEvent("end_turn"); }
  }));
  for (const name of ["fm-provider", "role-provider"]) {
    providers.register(makeStubProvider(name, async function* (request) {
      record(name, request);
      yield usageEvent(7, 3); yield textEvent(`${name} 结论`); yield doneEvent("end_turn");
    }));
  }
  const settings = await SettingsService.load({ env: options.env ?? {}, filePath: path.join(root, "server-settings.json") });
  let registry: AgentRegistry | undefined;
  if (options.agents) {
    const globalDir = path.join(root, "agents");
    await mkdir(globalDir, { recursive: true });
    for (const [name, text] of Object.entries(options.agents)) await writeFile(path.join(globalDir, `${name}.md`), text, "utf8");
    registry = new AgentRegistry(globalDir);
  }
  const runner = new AgentRunner(sessions, providers, makeFakeCore(), new EventBus(), pricing, undefined, "zh-CN", 50, undefined, usageLog, undefined, undefined, undefined, undefined, registry);
  runner.setModelRoleResolver(new ModelRoleResolver(settings, providers));
  return { runner, sessionId: session.id, sessions, requests, usageLog };
}

describe("spawn 角色派发", () => {
  it("子代理走角色 provider/model 并记账到角色档、主循环系统提示标出映射；未配置或未指定时回落 balanced 再会话默认", async () => {
    const fixture = await setupRoleSpawn({ env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model") }, spawnTool: "spawn_task", spawnInput: { prompt: "评审", role: "cheap" } });
    await fixture.runner.run(fixture.sessionId, "派单");
    const roleRequests = fixture.requests.get("role-provider") ?? [];
    // 主 provider 不见子代理请求；子代理请求落角色 provider 且 system 为子代理提示
    expect([roleRequests.length, roleRequests[0]?.model, roleRequests[0]?.system.includes("exploration sub-agent"), (fixture.requests.get("main") ?? []).every((request) => !request.system.includes("exploration sub-agent")), fixture.requests.has("fm-provider")]).toEqual([1, "role-model", true, true, false]);
    const usage = await fixture.usageLog.readAll(); expect(usage).toHaveLength(1); expect(usage[0]).toMatchObject({ provider: "role-provider", model: "role-model", inputTokens: 7, outputTokens: 3 });
    // 主循环系统提示含角色映射段：cheap 指向配置，其余档标注回落
    const mainSystem = fixture.requests.get("main")?.[0]?.system ?? ""; expect([mainSystem.includes("Sub-agent model roles"), mainSystem.includes("cheap: lowest cost"), mainSystem.includes("role-model [role-provider]"), mainSystem.includes("not configured, falls back to balanced")]).toEqual([true, true, true, true]);
    // 未指定 role 的子代理默认走 balanced
    const unroled = await setupRoleSpawn({ env: { OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("fm-provider", "bal-model") }, spawnTool: "spawn_task", spawnInput: { prompt: "评审" } });
    await unroled.runner.run(unroled.sessionId, "派单"); expect([(unroled.requests.get("fm-provider") ?? [])[0]?.model, (unroled.requests.get("main") ?? []).every((request) => !request.system.includes("exploration sub-agent"))]).toEqual(["bal-model", true]);
    // 角色未配置 → balanced；balanced 也未配置 → 会话默认模型
    const balanced = await setupRoleSpawn({ env: { OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("fm-provider", "bal-model") }, spawnTool: "spawn_task", spawnInput: { prompt: "评审", role: "cheap" } });
    await balanced.runner.run(balanced.sessionId, "派单"); expect((balanced.requests.get("fm-provider") ?? [])[0]?.model).toBe("bal-model");
    const sessionDefault = await setupRoleSpawn({ spawnTool: "spawn_task", spawnInput: { prompt: "评审", role: "premium" } });
    await sessionDefault.runner.run(sessionDefault.sessionId, "派单"); expect((sessionDefault.requests.get("main") ?? []).find((request) => request.system.includes("exploration sub-agent"))?.model).toBe("main-model");
  });

  it("未知 role 在派单前拒绝；frontmatter provider/model 与 role 优先于调用级 role，调用级 role 兜底", async () => {
    const bogus = await setupRoleSpawn({ spawnTool: "spawn_task", spawnInput: { prompt: "评审", role: "bogus" } });
    await bogus.runner.run(bogus.sessionId, "派单");
    const toolResult = (await bogus.sessions.get(bogus.sessionId))?.messages.filter((message) => message.role === "tool")
      .flatMap((message) => message.content).find((block) => block.type === "tool_result" && block.toolCallId === "spawn-1");
    expect(toolResult).toMatchObject({ isError: true }); expect((toolResult as { content: string }).content).toContain("Unknown model role: bogus"); expect([bogus.requests.has("fm-provider"), bogus.requests.has("role-provider")]).toEqual([false, false]);
    // frontmatter provider:/model: 优先于任何角色
    const explicit = await setupRoleSpawn({ env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model") }, agents: { explicit: "---\ndescription: d\nprovider: fm-provider\nmodel: fm-model\n---\nEXPLICIT BODY" }, spawnTool: "spawn_task", spawnInput: { prompt: "评审", agent: "explicit", role: "cheap" } });
    await explicit.runner.run(explicit.sessionId, "派单"); expect([(explicit.requests.get("fm-provider") ?? [])[0]?.model, (explicit.requests.get("fm-provider") ?? [])[0]?.system.includes("EXPLICIT BODY"), explicit.requests.has("role-provider")]).toEqual(["fm-model", true, false]);
    // frontmatter role: 优先于调用级 role
    const roled = await setupRoleSpawn({ env: { OWC_ROLE_MODEL_PREMIUM: encodeFastModelSelection("fm-provider", "premium-model"), OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model") }, agents: { roled: "---\ndescription: d\nrole: premium\n---\nROLED BODY" }, spawnTool: "spawn_task", spawnInput: { prompt: "评审", agent: "roled", role: "cheap" } });
    await roled.runner.run(roled.sessionId, "派单"); expect([(roled.requests.get("fm-provider") ?? [])[0]?.model, roled.requests.has("role-provider")]).toEqual(["premium-model", false]);
    // frontmatter 既无 provider/model 也无 role：套用调用级 role
    const plain = await setupRoleSpawn({ env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "role-model") }, agents: { plain: "---\ndescription: d\n---\nPLAIN BODY" }, spawnTool: "spawn_task", spawnInput: { prompt: "评审", agent: "plain", role: "cheap" } });
    await plain.runner.run(plain.sessionId, "派单"); expect((plain.requests.get("role-provider") ?? [])[0]?.model).toBe("role-model");
  });

  it("spawn_swarm 套用调用级 role 且允许 item 级覆盖", async () => {
    const fixture = await setupRoleSpawn({
      env: { OWC_ROLE_MODEL_BALANCED: encodeFastModelSelection("fm-provider", "bal-model"), OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("role-provider", "cheap-model") },
      spawnTool: "spawn_swarm",
      spawnInput: { prompt_template: "评审 {{item}}", items: ["a.ts", { task: "b.ts", role: "cheap" }], role: "balanced" },
    });
    await fixture.runner.run(fixture.sessionId, "派单"); expect((fixture.requests.get("fm-provider") ?? []).map((request) => request.model)).toEqual(["bal-model"]); expect((fixture.requests.get("role-provider") ?? []).map((request) => request.model)).toEqual(["cheap-model"]);
  });
});

describe("AgentRunner 运行中热切主模型", () => {
  it("运行中热切主模型：下一 turn 用新模型并按新模型记账；在途 fallback 覆盖被丢弃，回到新主模型", async () => {
    const direct = await setup([]);
    const seen: string[] = [];
    direct.providers.register(providerOf("main", async function* (request) {
      seen.push(request.model);
      // 第一轮流式期间用户切了模型（等价于 PUT /config 热切：落盘 + 打标丢弃 fallback 覆盖）
      if (request.messages.at(-1)?.role === "user") {
        await direct.sessions.updateConfig(direct.sessionId, { provider: "main", model: "m2" });
        direct.runner.resetModelFallbackOverride(direct.sessionId);
      }
      if (request.model === "m2") { yield textEvent("switched reply"); yield usageEvent(3, 4); yield doneEvent("end_turn"); return; }
      yield callEvent("call-1", "bash", { cmd: "echo one" }); yield usageEvent(); yield doneEvent("tool_use");
    }));
    await direct.runner.run(direct.sessionId, "先跑命令，随后切模型"); expect(seen).toEqual(["m1", "m2"]); expect(ids(await direct.usageLog.readAll())).toEqual(["main/m1", "main/m2"]); expect(await direct.sessions.get(direct.sessionId)).toMatchObject({ provider: "main", model: "m2" }); // usage 按新模型记账
    // fallback 在途时切主模型：覆盖被丢弃，下一 turn 回到新主模型而非继续 backup
    const viaFallback = await setup([{ provider: "backup", model: "m2" }]);
    const order: string[] = [];
    viaFallback.providers.register(providerOf("main", async function* (request) {
      order.push(`main/${request.model}`);
      if (request.model === "m3") { yield textEvent("switched reply"); yield usageEvent(); yield doneEvent("end_turn"); return; }
      // 主模型 m2 在工具回合持续 429：重试耗尽后进入 fallback 链
      if (request.messages.at(-1)?.role === "tool") throw Object.assign(new Error("rate limited"), { status: 429 });
      yield callEvent("call-1", "bash", { cmd: "echo one" }); yield usageEvent(); yield doneEvent("tool_use");
    }));
    viaFallback.providers.register(providerOf("backup", async function* () {
      order.push("backup/m2");
      await viaFallback.sessions.updateConfig(viaFallback.sessionId, { provider: "main", model: "m3" });
      viaFallback.runner.resetModelFallbackOverride(viaFallback.sessionId);
      yield callEvent("call-2", "bash", { cmd: "echo two" }); yield usageEvent(); yield doneEvent("tool_use");
    }));
    await viaFallback.runner.run(viaFallback.sessionId, "触发 fallback 后切模型"); expect([order[0], order.filter((entry) => entry === "backup/m2").length, order.at(-1)]).toEqual(["main/m1", 1, "main/m3"]);
  });
});
