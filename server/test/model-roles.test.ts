import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { AgentRegistry } from "../src/agents.js";
import { filterReasoningByCapabilities, ModelRoleResolver } from "../src/model-roles.js";
import type { EffortLevel, ModelProfile, ThinkingMode } from "../src/context/model-profile.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { encodeFastModelSelection, SettingsService } from "../src/settings-service.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

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

describe("filterReasoningByCapabilities", () => {
  function profileWith(thinking: ThinkingMode[], effort: EffortLevel[]): ModelProfile {
    return {
      id: "m",
      provider: "p",
      contextWindow: 128_000,
      maxOutput: 8_192,
      capabilities: { modalities: ["text"], imageOutput: false, thinking, effort, tools: true },
    };
  }

  it("keeps whitelisted values and drops the rest when capabilities are declared", () => {
    const profile = profileWith(["disabled"], ["low", "high"]);
    expect(filterReasoningByCapabilities(profile, { thinking: "enabled", effort: "low" })).toEqual({ effort: "low" });
    expect(filterReasoningByCapabilities(profile, { thinking: "disabled", effort: "ultra" })).toEqual({ thinking: "disabled" });
    expect(filterReasoningByCapabilities(profile, {})).toEqual({});
  });

  it("passes values through when capabilities are undeclared (empty arrays)", () => {
    const profile = profileWith([], []);
    expect(filterReasoningByCapabilities(profile, { thinking: "enabled", effort: "max" })).toEqual({ thinking: "enabled", effort: "max" });
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
