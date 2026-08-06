import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import type { CoreClient } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeCore } from "./helpers/fake-core.js";
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

    // 主模型：首轮 1 次 + 次轮 3 次重试耗尽；备选模型只尝试一次
    expect(mainCalls).toBe(4);
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

    // 每个候选恰好一次 turn 的重试集（3 次 attempt），不二次尝试
    expect(mainCalls).toBe(3);
    expect(backupCalls).toBe(3);
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
