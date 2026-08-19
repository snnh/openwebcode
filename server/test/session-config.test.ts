import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("session model config", () => {
  it("persists append-only message lineage and reconstructs legacy parents on reload", async () => {
    const root = await tempRoot("owc-session-lineage-");
    const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test" });
    const first = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "first" }]);
    const second = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "second" }], { runId: "run-1", turnId: "run-1:0" });
    const reloaded = new SessionStore(path.join(root, "sessions")); await reloaded.initialize();
    const detail = await reloaded.get(session.id);
    expect(detail?.activeLeafId).toBe(second.id);
    expect(detail?.messages).toMatchObject([{ id: first.id }, { id: second.id, parentId: first.id, runId: "run-1", turnId: "run-1:0" }]);
  });

  describe("PUT /config", () => {
    let root: string;
    let sessions: SessionStore;
    let app: Awaited<ReturnType<typeof buildServer>>;
    let disposedShells: string[];
    let shellPending: boolean;
    let running: boolean;
    let reconciled: string[];

    beforeEach(async () => {
      root = await tempRoot("owc-session-config-");
      sessions = new SessionStore(path.join(root, "sessions"));
      await sessions.initialize();
      const provider: Provider = { name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } };
      const providers = new ProviderRegistry();
      providers.register(provider);
      const pricing = new PricingCatalog(path.join(root, "pricing.json"));
      await pricing.initialize();
      disposedShells = [];
      shellPending = false;
      running = false;
      reconciled = [];
      const agent = {
        isRunning: () => running,
        isShellPending: () => shellPending,
        disposePersistentShells: async (sessionId: string) => { disposedShells.push(sessionId); },
        reconcilePermissions: async (sessionId: string) => { reconciled.push(sessionId); },
      } as unknown as AgentRunner;
      app = await buildServer({ core: {} as CoreClient, sessions, agent, events: new EventBus(), providers, pricing });
    });

    afterEach(async () => {
      await app.close();
    });

    it("validates and persists idle model thinking and effort updates", async () => {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "deepseek-chat" });
      // 未声明（capabilities 空数组）= 全部可选：合法枚举放行，含 ultra 档；非法枚举仍 400
      const undeclared = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { effort: "high" } });
      expect(undeclared.statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ effort: "high" });
      const ultra = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { effort: "ultra" } });
      expect(ultra.statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ effort: "ultra" });
      const invalidEnum = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { effort: "extreme" } });
      expect(invalidEnum.statusCode).toBe(400);
      // 已声明白名单维持 400：gpt-5 只声明 low/medium/high
      const declaredInvalid = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "gpt-5", effort: "xhigh" } });
      expect(declaredInvalid.statusCode).toBe(400);
      // 切到已声明且不含继承值的模型时原子清除（gpt-5 不含 ultra），而不是要求用户先单独关闭再切模型
      const switched = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "gpt-5" } });
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ model: "gpt-5" });
      expect(switched.json()).not.toHaveProperty("effort");
      expect(await sessions.get(session.id)).not.toHaveProperty("effort");
      // deepseek-reasoner 声明 thinking ["enabled","disabled"]：enabled 通过，adaptive 被拒
      const response = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "deepseek-reasoner", thinking: "enabled" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ model: "deepseek-reasoner", thinking: "enabled" });
      const adaptive = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { thinking: "adaptive" } });
      expect(adaptive.statusCode).toBe(400);
      // 切回未声明模型（deepseek-chat）：继承的 thinking 保留（未声明 = 全部兼容）
      const kept = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "deepseek-chat" } });
      expect(kept.statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ model: "deepseek-chat", thinking: "enabled" });
      const invalidSnapshot = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { snapshotMode: "sometimes" } });
      expect(invalidSnapshot.statusCode).toBe(400);
      const invalidShell = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { shellBackend: "powershell" } });
      expect(invalidShell.statusCode).toBe(400);
      const invalidPythonEnv = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { pythonEnv: "conda" } });
      expect(invalidPythonEnv.statusCode).toBe(400);
      const invalidNodeEnv = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { nodeEnv: "volta" } });
      expect(invalidNodeEnv.statusCode).toBe(400);
      const invalidSwarm = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { swarmEnabled: "yes" } });
      expect(invalidSwarm.statusCode).toBe(400);
      const modes = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { sandboxMode: "off", snapshotMode: "manual", shellBackend: "pwsh", pythonEnv: "uv-workspace" } });
      expect(modes.statusCode).toBe(200);
      expect(modes.json()).toMatchObject({ sandboxMode: "off", snapshotMode: "manual", shellBackend: "pwsh", pythonEnv: "uv-workspace" });
      expect(await sessions.get(session.id)).toMatchObject({ sandboxMode: "off", snapshotMode: "manual", shellBackend: "pwsh", pythonEnv: "uv-workspace" });
      // 回退本机环境：pythonEnv 置回 global 时从会话元数据中清除
      const cleared = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { pythonEnv: "global" } });
      expect(cleared.statusCode).toBe(200);
      expect(await sessions.get(session.id)).not.toHaveProperty("pythonEnv");
      // nodeEnv 与 pythonEnv 同款：合法值持久化，global 置回时从元数据清除
      const nodeSet = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { nodeEnv: "fnm" } });
      expect(nodeSet.statusCode).toBe(200);
      expect(nodeSet.json()).toMatchObject({ nodeEnv: "fnm" });
      expect(await sessions.get(session.id)).toMatchObject({ nodeEnv: "fnm" });
      const nodeCleared = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { nodeEnv: "global" } });
      expect(nodeCleared.statusCode).toBe(200);
      expect(await sessions.get(session.id)).not.toHaveProperty("nodeEnv");
      // 并行子代理开关：true 持久化，false 从元数据清除
      const swarmOn = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { swarmEnabled: true } });
      expect(swarmOn.statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ swarmEnabled: true });
      const swarmOff = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { swarmEnabled: false } });
      expect(swarmOff.statusCode).toBe(200);
      expect(await sessions.get(session.id)).not.toHaveProperty("swarmEnabled");
      const first = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "timeline" }]);
      const second = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "node" }], { runId: "run-test", turnId: "run-test:0" });
      const timeline = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/timeline` });
      expect(timeline.statusCode).toBe(200);
      expect(timeline.json().activeLeafId).toBe(second.id);
      expect(timeline.json().entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.id, parentId: first.id, runId: "run-test", turnId: "run-test:0" })]));
    });

    it("recycles persistent shells when sandbox mode, network, or python/node env changes", async () => {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "deepseek-chat" });
      // 无关配置变更（快照模式）不回收持久 shell
      const unrelated = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { snapshotMode: "manual" } });
      expect(unrelated.statusCode).toBe(200);
      expect(disposedShells).toEqual([]);
      // 沙盒模式切换：持久 shell 的 pty 在旧策略下打开，必须回收重建才生效
      const sandbox = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { sandboxMode: "off" } });
      expect(sandbox.statusCode).toBe(200);
      expect(disposedShells).toEqual([session.id]);
      // 网络策略切换同样改变沙盒策略，回收
      const network = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { network: "deny" } });
      expect(network.statusCode).toBe(200);
      expect(disposedShells).toEqual([session.id, session.id]);
      // pythonEnv / nodeEnv 变更：环境激活命令只在建壳时注入一次，回收后下条 bash 透明重建
      const python = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { pythonEnv: "uv-workspace" } });
      expect(python.statusCode).toBe(200);
      const node = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { nodeEnv: "fnm" } });
      expect(node.statusCode).toBe(200);
      expect(disposedShells).toEqual([session.id, session.id, session.id, session.id]);
      // 同值重复提交（无实际变化）不回收
      const sameEnv = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { pythonEnv: "uv-workspace", nodeEnv: "fnm" } });
      expect(sameEnv.statusCode).toBe(200);
      expect(disposedShells).toHaveLength(4);
    });

    it("在途 shell 命令时沙盒变更默认 409（SHELL_PENDING），force: true 放行并回收", async () => {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "deepseek-chat" });
      shellPending = true;
      // 409：不落盘、不回收，由前端二次确认后带 force 重发
      const pending = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { sandboxMode: "off" } });
      expect(pending.statusCode).toBe(409);
      expect(pending.json().code).toBe("SHELL_PENDING");
      expect(disposedShells).toEqual([]);
      expect(await sessions.get(session.id)).not.toHaveProperty("sandboxMode");
      // force: true 放行：写入新沙盒模式并回收持久 shell
      const forced = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { sandboxMode: "off", force: true } });
      expect(forced.statusCode).toBe(200);
      expect(disposedShells).toEqual([session.id]);
      expect(await sessions.get(session.id)).toMatchObject({ sandboxMode: "off" });
    });

    it("force 非 boolean 一律 400；无关配置变更不受在途 shell 门控", async () => {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "deepseek-chat" });
      const badForce = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { sandboxMode: "off", force: "yes" } });
      expect(badForce.statusCode).toBe(400);
      expect(badForce.json().error).toBe("force must be a boolean");
      expect(await sessions.get(session.id)).not.toHaveProperty("sandboxMode");
      // 快照模式不触及沙盒/环境：即使有在途 shell 也直接放行、不回收
      shellPending = true;
      const unrelated = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { snapshotMode: "manual" } });
      expect(unrelated.statusCode).toBe(200);
      expect(disposedShells).toEqual([]);
    });

    it("accepts review permission mode, persists reviewModel, rejects invalid values", async () => {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "deepseek-chat" });
      const ok = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { permissionMode: "review", reviewModel: "fast" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ permissionMode: "review", reviewModel: "fast" });
      expect(await sessions.get(session.id)).toMatchObject({ permissionMode: "review", reviewModel: "fast" });
      // 无清除语义：后续 PUT 不带 reviewModel 时保留旧值
      const main = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { reviewModel: "main" } });
      expect(main.statusCode).toBe(200);
      const inherit = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { permissionMode: "ask" } });
      expect(inherit.statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ permissionMode: "ask", reviewModel: "main" });
      const badMode = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { permissionMode: "auto" } });
      expect(badMode.statusCode).toBe(400);
      expect(badMode.json().error).toContain("review");
      const badReviewModel = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { reviewModel: "slow" } });
      expect(badReviewModel.statusCode).toBe(400);
      expect(badReviewModel.json().error).toBe('reviewModel must be "fast" or "main"');
    });

    it("运行中仅放行权限类字段：permissionMode/reviewModel 热切并结算挂起审批，其余 409", async () => {
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "deepseek-chat" });
      running = true;
      // 权限档热切：200、落盘、触发挂起审批结算
      const yolo = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { permissionMode: "yolo" } });
      expect(yolo.statusCode).toBe(200);
      expect(yolo.json()).toMatchObject({ permissionMode: "yolo" });
      expect(await sessions.get(session.id)).toMatchObject({ permissionMode: "yolo" });
      expect(reconciled).toEqual([session.id]);
      // reviewModel 同为运行中可热切字段
      const review = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { reviewModel: "main" } });
      expect(review.statusCode).toBe(200);
      expect(reconciled).toEqual([session.id, session.id]);
      // 其余字段运行中仍 409：模型、agentMode、权限字段混合提交；409 不落盘
      const model = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { model: "gpt-5" } });
      expect(model.statusCode).toBe(409);
      const agentMode = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { agentMode: "plan" } });
      expect(agentMode.statusCode).toBe(409);
      const mixed = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { permissionMode: "ask", agentMode: "plan" } });
      expect(mixed.statusCode).toBe(409);
      expect(await sessions.get(session.id)).toMatchObject({ permissionMode: "yolo", model: "deepseek-chat" });
      expect(reconciled).toHaveLength(2);
      // 空闲时改权限档不触发结算（无运行中挂起单）
      running = false;
      const idle = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { permissionMode: "ask" } });
      expect(idle.statusCode).toBe(200);
      expect(reconciled).toHaveLength(2);
    });
  });
});

// ---- session-defaults 组（合并） ----
async function defaultsFixture(env: NodeJS.ProcessEnv = {}) {
  const setup = await makeTestApp({
    tempPrefix: "owc-session-defaults-",
    settingsEnv: env,
    configureProviders: (providers) => providers.register(makeStubProvider("stub")),
  });
  return setup;
}

describe("新建会话套用全局默认（defaultEffort / defaultSnapshotMode）", () => {
  it("设置非缺省时：新会话带上 effort 与 snapshotMode", async () => {
    const setup = await defaultsFixture({ OWC_DEFAULT_EFFORT: "high", OWC_DEFAULT_SNAPSHOT_MODE: "manual" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ effort: "high", snapshotMode: "manual" });
      // 事件与落盘 meta 一致
      const meta = await setup.sessions.get(response.json<{ id: string }>().id);
      expect(meta).toMatchObject({ effort: "high", snapshotMode: "manual" });
    } finally {
      await setup.app.close();
    }
  });

  it("缺省（none/auto）：新会话不带 effort 与 snapshotMode", async () => {
    const setup = await defaultsFixture();
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json<Record<string, unknown>>();
      expect(body.effort).toBeUndefined();
      expect(body.snapshotMode).toBeUndefined();
    } finally {
      await setup.app.close();
    }
  });

  it("非法枚举值（env 直写）：静默跳过，不阻断创建", async () => {
    const setup = await defaultsFixture({ OWC_DEFAULT_EFFORT: "bogus" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<Record<string, unknown>>().effort).toBeUndefined();
    } finally {
      await setup.app.close();
    }
  });

  it("会话自身 PUT config 覆盖优先于全局默认", async () => {
    const setup = await defaultsFixture({ OWC_DEFAULT_EFFORT: "high" });
    try {
      const created = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      const id = created.json<{ id: string }>().id;
      const updated = await setup.app.inject({ method: "PUT", url: `/api/sessions/${id}/config`, payload: { effort: "low" } });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({ effort: "low" });
    } finally {
      await setup.app.close();
    }
  });
});

describe("新建会话套用快照后端偏好（snapshotBackend）", () => {
  it("git-shadow：直接预设，跳过探测链", async () => {
    const setup = await defaultsFixture({ OWC_SNAPSHOT_BACKEND: "git-shadow" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ snapshotBackend: "git-shadow" });
    } finally {
      await setup.app.close();
    }
  });

  it("指定后端在当前平台不可用（win32 指定 btrfs）：回落自动并告警，不阻断创建", async () => {
    const setup = await defaultsFixture({ OWC_SNAPSHOT_BACKEND: "btrfs" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<Record<string, unknown>>().snapshotBackend).toBeUndefined();
      const fallback = setup.observed.find((event) => event.type === "snapshot.backend_fallback");
      expect(fallback).toMatchObject({ payload: { preferred: "btrfs" } });
    } finally {
      await setup.app.close();
    }
  });
});

// ---- session-display 组（合并） ----
async function displaySetup() {
  const root = await tempRoot("owc-session-display-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const providers = new ProviderRegistry();
  providers.register({ name: "test", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const agent = { isRunning: () => false } as AgentRunner;
  const events = new EventBus();
  const app = await buildServer({ core: {} as CoreClient, sessions, agent, events, providers, pricing });
  return { root, sessions, events, app };
}

describe("PATCH /api/sessions/:id（重命名与置顶）", () => {
  it("设置与清除标题覆盖；置顶开关往返；列表响应携带 pinned", async () => {
    const { root, sessions, app } = await displaySetup();
    try {
      const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: "帮我修一个 failing test" }]);

      const renamed = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "  我的会话  " } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ title: "我的会话" });

      const pinned = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { pinned: true } });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toMatchObject({ pinned: true });

      // 列表与详情响应均携带新字段（向后兼容：未置顶时不带 pinned 键）
      const list = await app.inject({ method: "GET", url: "/api/sessions" });
      expect(list.json()[0]).toMatchObject({ title: "我的会话", pinned: true });

      // 重读 manager 验证持久化
      const reloaded = new SessionStore(path.join(root, "sessions"));
      await reloaded.initialize();
      expect(await reloaded.get(session.id)).toMatchObject({ title: "我的会话", pinned: true });

      const cleared = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "", pinned: false } });
      expect(cleared.statusCode).toBe(200);
      // 空串清除覆盖 → 回落到首条用户消息的派生标题
      expect(cleared.json().title).toBe("帮我修一个 failing test");
      expect(cleared.json()).not.toHaveProperty("pinned");
    } finally {
      await app.close();
    }
  });

  it("空会话清除标题回落到默认标题", async () => {
    const { sessions, app } = await displaySetup();
    try {
      const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m", title: "自定义" });
      const response = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "   " } });
      expect(response.statusCode).toBe(200);
      expect(response.json().title).toBe("New session");
    } finally {
      await app.close();
    }
  });

  it("校验错误：超长标题、类型错误、空 body、未知会话", async () => {
    const { sessions, app } = await displaySetup();
    try {
      const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
      const longTitle = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "x".repeat(121) } });
      expect(longTitle.statusCode).toBe(400);
      const badTitle = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: 42 } });
      expect(badTitle.statusCode).toBe(400);
      const badPinned = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { pinned: "yes" } });
      expect(badPinned.statusCode).toBe(400);
      const empty = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: {} });
      expect(empty.statusCode).toBe(400);
      const missing = await app.inject({ method: "PATCH", url: "/api/sessions/00000000-0000-0000-0000-000000000000", payload: { pinned: true } });
      expect(missing.statusCode).toBe(404);
      // 校验失败后原值不变
      expect(await sessions.get(session.id)).not.toHaveProperty("pinned");
    } finally {
      await app.close();
    }
  });

  it("重命名/置顶不更新 updatedAt（纯展示属性不应改变列表排序）", async () => {
    const { sessions, app } = await displaySetup();
    try {
      const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
      const renamed = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "新标题", pinned: true } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().updatedAt).toBe(session.updatedAt);
      const persisted = await sessions.get(session.id);
      expect(persisted?.updatedAt).toBe(session.updatedAt);
    } finally {
      await app.close();
    }
  });
});

describe("派生标题（首条用户消息）", () => {
  it("buildServer 接线后派生标题会发布 session.updated 事件", async () => {
    const { sessions, events, app } = await displaySetup();
    try {
      const published: Array<{ type: string; sessionId?: string; payload: unknown }> = [];
      events.on("event", (event: { type: string; sessionId?: string; payload: unknown }) => published.push(event));
      const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: "帮我修一个 failing test" }]);
      const update = published.find((event) => event.type === "session.updated");
      expect(update).toBeDefined();
      expect(update?.sessionId).toBe(session.id);
      expect(update?.payload).toMatchObject({ title: "帮我修一个 failing test" });
      // 后续消息不再重复发布
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: "再补充一点" }]);
      expect(published.filter((event) => event.type === "session.updated")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("派生标题时触发 onDerivedTitle 回调一次；非首条/非用户消息不触发", async () => {
    const root = await tempRoot("owc-derived-title-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const derived: Array<{ id: string; title: string }> = [];
    sessions.onDerivedTitle = (meta) => derived.push({ id: meta.id, title: meta.title });

    const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
    // assistant 消息不触发
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "先说话" }]);
    expect(derived).toHaveLength(0);
    // 首条用户消息派生标题并触发回调
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "帮我修一个 failing test" }]);
    expect(derived).toEqual([{ id: session.id, title: "帮我修一个 failing test" }]);
    // 后续用户消息标题已非默认值，不再触发
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "再补充一点" }]);
    expect(derived).toHaveLength(1);
    // 用户自定义标题的会话不触发
    const titled = await sessions.create({ cwd: "/tmp", provider: "test", model: "m", title: "自定义" });
    await sessions.appendMessage(titled.id, "user", [{ type: "text", text: "hello" }]);
    expect(derived).toHaveLength(1);
  });
});
