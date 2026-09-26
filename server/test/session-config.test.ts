import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";

const PLATFORM_DEFAULT_SANDBOX = process.platform === "win32" ? "appcontainer" : "bubblewrap";

describe("session model config", () => {
  it("append-only 消息血缘落盘，重载后还原父链与活动叶子", async () => {
    const root = await tempRoot("owc-session-lineage-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test" });
    const first = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "first" }]);
    const second = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "second" }], { runId: "run-1", turnId: "run-1:0" });
    const reloaded = new SessionStore(path.join(root, "sessions"));
    await reloaded.initialize();
    const detail = await reloaded.get(session.id); expect(detail?.activeLeafId).toBe(second.id);
    expect(detail?.messages).toMatchObject([{ id: first.id }, { id: second.id, parentId: first.id, runId: "run-1", turnId: "run-1:0" }]);
  });
  describe("PUT /config", () => {
    /** 可变 agent 替身 + 真实 buildServer：沙盒/环境门控与回收只能从这些副作用观测 */
    async function configApp() {
      const root = await tempRoot("owc-session-config-");
      const sessions = new SessionStore(path.join(root, "sessions"));
      await sessions.initialize();
      const providers = new ProviderRegistry();
      providers.register({ name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
      const pricing = new PricingCatalog(path.join(root, "pricing.json"));
      await pricing.initialize();
      const flags = { running: false, shellPending: false, disposedShells: [] as string[] };
      const agent = {
        isRunning: () => flags.running,
        isShellPending: () => flags.shellPending,
        disposePersistentShells: async (sessionId: string) => { flags.disposedShells.push(sessionId); },
        reconcilePermissions: async () => undefined,
        resetModelFallbackOverride: () => undefined,
      } as unknown as AgentRunner;
      const app = await buildServer({ core: {} as CoreClient, sessions, agent, events: new EventBus(), providers, pricing });
      const put = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/sessions/${id}/config`, payload });
      return { app, sessions, flags, put };
    }
    it("空闲会话：模型/思考/权限类字段校验并落盘；未声明枚举全放行，非法值 400", async () => {
      const { app, sessions, put } = await configApp();
      try {
        const session = await sessions.create({ cwd: "/tmp", provider: "anthropic", model: "some-random-model" });
        // 未声明 capabilities（空数组）= 全部兼容：合法枚举含 ultra 放行，非法枚举仍 400
        expect((await put(session.id, { effort: "high" })).statusCode).toBe(200);
        expect(await sessions.get(session.id)).toMatchObject({ effort: "high" });
        expect((await put(session.id, { effort: "ultra" })).statusCode).toBe(200);
        expect((await put(session.id, { effort: "extreme" })).statusCode).toBe(400);
        // 已声明白名单维持 400：gpt-5 只声明 low/medium/high，deepseek 不含 minimal
        expect((await put(session.id, { model: "gpt-5", effort: "xhigh" })).statusCode).toBe(400);
        expect((await put(session.id, { model: "deepseek-chat", effort: "minimal" })).statusCode).toBe(400);
        // 切到不含继承值的已声明模型：原子清除 effort，无需用户先单独关闭
        const switched = await put(session.id, { model: "gpt-5" }); expect(switched.json()).toMatchObject({ model: "gpt-5" });
        expect(switched.json()).not.toHaveProperty("effort"); expect(await sessions.get(session.id)).not.toHaveProperty("effort");
        // thinking 白名单：deepseek-reasoner 声明 enabled/disabled
        expect((await put(session.id, { model: "deepseek-reasoner", thinking: "enabled" })).statusCode).toBe(200);
        expect((await put(session.id, { thinking: "adaptive" })).statusCode).toBe(400);
        // 切回未声明模型：继承的 thinking 保留
        await put(session.id, { model: "deepseek-chat" });
        expect(await sessions.get(session.id)).toMatchObject({ model: "deepseek-chat", thinking: "enabled" });
        // review 权限档与审核模型：无清除语义，后续 PUT 不带 reviewModel 时保留旧值
        expect((await put(session.id, { permissionMode: "review", reviewModel: "fast" })).json()).toMatchObject({ permissionMode: "review", reviewModel: "fast" });
        await put(session.id, { reviewModel: "main" }); expect((await put(session.id, { permissionMode: "ask" })).statusCode).toBe(200);
        expect(await sessions.get(session.id)).toMatchObject({ permissionMode: "ask", reviewModel: "main" });
        const badMode = await put(session.id, { permissionMode: "auto" }); expect(badMode.statusCode).toBe(400);
        expect(badMode.json().error).toContain("review");
        const badReviewModel = await put(session.id, { reviewModel: "slow" }); expect(badReviewModel.statusCode).toBe(400);
        expect(badReviewModel.json().error).toBe('reviewModel must be "fast" or "main"');
      } finally {
        await app.close();
      }
    });

    it("模式与环境字段：合法值落盘、回退本机环境时删键、非法值 400；timeline 暴露 lineage", async () => {
      const { app, sessions, put } = await configApp();
      try {
        const session = await sessions.create({ cwd: "/tmp", provider: "anthropic", model: "deepseek-chat" });
        expect((await put(session.id, { snapshotMode: "sometimes" })).statusCode).toBe(400);
        expect((await put(session.id, { shellBackend: "powershell" })).statusCode).toBe(400);
        expect((await put(session.id, { pythonEnv: "conda" })).statusCode).toBe(400);
        expect((await put(session.id, { nodeEnv: "volta" })).statusCode).toBe(400);
        expect((await put(session.id, { swarmEnabled: "yes" })).statusCode).toBe(400);
        const modes = await put(session.id, { sandboxMode: "off", snapshotMode: "manual", shellBackend: "pwsh", pythonEnv: "uv-workspace" });
        expect(modes.json()).toMatchObject({ sandboxMode: "off", snapshotMode: "manual", shellBackend: "pwsh", pythonEnv: "uv-workspace" });
        expect(await sessions.get(session.id)).toMatchObject({ sandboxMode: "off", snapshotMode: "manual", shellBackend: "pwsh", pythonEnv: "uv-workspace" });
        // 回退本机环境（global）与关闭开关：删键而不是存假值
        expect((await put(session.id, { pythonEnv: "global" })).statusCode).toBe(200);
        expect(await sessions.get(session.id)).not.toHaveProperty("pythonEnv");
        expect((await put(session.id, { nodeEnv: "fnm" })).json()).toMatchObject({ nodeEnv: "fnm" });
        await put(session.id, { nodeEnv: "global" }); expect(await sessions.get(session.id)).not.toHaveProperty("nodeEnv");
        await put(session.id, { swarmEnabled: true }); expect(await sessions.get(session.id)).toMatchObject({ swarmEnabled: true });
        await put(session.id, { swarmEnabled: false }); expect(await sessions.get(session.id)).not.toHaveProperty("swarmEnabled");
        const first = await sessions.appendMessage(session.id, "user", [{ type: "text", text: "timeline" }]);
        const second = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "node" }], { runId: "run-test", turnId: "run-test:0" });
        const timeline = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/timeline` });
        expect(timeline.json().activeLeafId).toBe(second.id);
        expect(timeline.json().entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.id, parentId: first.id, runId: "run-test", turnId: "run-test:0" })]));
      } finally {
        await app.close();
      }
    });

    it("沙盒/网络/环境变更回收持久 shell；在途 shell 时默认 409、force 放行、无关字段不受门控", async () => {
      const { app, sessions, flags, put } = await configApp();
      try {
        const session = await sessions.create({ cwd: "/tmp", provider: "anthropic", model: "deepseek-chat" });
        // 无关变更与同值重复提交都不回收
        await put(session.id, { snapshotMode: "manual" }); expect(flags.disposedShells).toEqual([]);
        // 沙盒模式与网络策略变更：pty 在旧策略下打开，必须回收重建才生效
        await put(session.id, { sandboxMode: "off" });
        await put(session.id, { network: "deny" }); expect(flags.disposedShells).toEqual([session.id, session.id]);
        // 环境激活命令只在建壳时注入一次，切换后必须回收
        await put(session.id, { pythonEnv: "uv-workspace" });
        await put(session.id, { nodeEnv: "fnm" }); expect(flags.disposedShells).toEqual(Array(4).fill(session.id));
        await put(session.id, { pythonEnv: "uv-workspace", nodeEnv: "fnm" }); expect(flags.disposedShells).toHaveLength(4);
        // 在途 shell：409 且不落盘不回收，由前端二次确认后带 force 重发
        const gated = await sessions.create({ cwd: "/tmp", provider: "anthropic", model: "deepseek-chat" });
        flags.shellPending = true;
        const pending = await put(gated.id, { sandboxMode: "off" }); expect(pending.statusCode).toBe(409);
        expect(pending.json().code).toBe("SHELL_PENDING"); expect((await sessions.get(gated.id))?.sandboxMode).toBe(PLATFORM_DEFAULT_SANDBOX);
        expect(flags.disposedShells).toHaveLength(4);
        // force 非 boolean 一律 400
        const badForce = await put(gated.id, { sandboxMode: "off", force: "yes" }); expect(badForce.statusCode).toBe(400);
        expect(badForce.json().error).toBe("force must be a boolean");
        expect((await sessions.get(gated.id))?.sandboxMode).toBe(PLATFORM_DEFAULT_SANDBOX);
        const forced = await put(gated.id, { sandboxMode: "off", force: true }); expect(forced.statusCode).toBe(200);
        expect(await sessions.get(gated.id)).toMatchObject({ sandboxMode: "off" });
        expect(flags.disposedShells).toEqual([session.id, session.id, session.id, session.id, gated.id]);
        // 不触及沙盒/环境的字段即使有在途 shell 也放行
        expect((await put(gated.id, { snapshotMode: "manual" })).statusCode).toBe(200); expect(flags.disposedShells).toHaveLength(5);
      } finally {
        await app.close();
      }
    });

    it("运行中热切：权限/审核/模型/思考落盘，agentMode 与沙盒等仍 409 且不落盘", async () => {
      const { app, sessions, flags, put } = await configApp();
      try {
        const session = await sessions.create({ cwd: "/tmp", provider: "anthropic", model: "deepseek-chat" });
        flags.running = true; expect((await put(session.id, { permissionMode: "yolo" })).statusCode).toBe(200);
        expect(await sessions.get(session.id)).toMatchObject({ permissionMode: "yolo" });
        expect((await put(session.id, { reviewModel: "main" })).statusCode).toBe(200);
        expect((await put(session.id, { model: "gpt-5" })).statusCode).toBe(200);
        expect((await put(session.id, { thinking: "adaptive" })).statusCode).toBe(200);
        expect((await put(session.id, { model: "gpt-5" })).statusCode).toBe(200); // 同值重复提交无害
        expect(await sessions.get(session.id)).toMatchObject({ model: "gpt-5", thinking: "adaptive" });
        // 其余字段运行中仍 409，且 409 不落盘
        expect((await put(session.id, { agentMode: "plan" })).statusCode).toBe(409);
        expect((await put(session.id, { sandboxMode: "off" })).statusCode).toBe(409);
        expect((await put(session.id, { model: "gpt-5-mini", agentMode: "plan" })).statusCode).toBe(409);
        expect(await sessions.get(session.id)).toMatchObject({ permissionMode: "yolo", model: "gpt-5", thinking: "adaptive" });
      } finally {
        await app.close();
      }
    });
  });
  describe("新建会话的全局默认", () => {
    async function createWithDefaults(env: NodeJS.ProcessEnv) {
      const setup = await makeTestApp({
        tempPrefix: "owc-session-defaults-",
        settingsEnv: env,
        configureProviders: (providers) => providers.register(makeStubProvider("stub")),
      });
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      return { setup, response };
    }
    it("effort/snapshotMode 默认值套用且可被会话覆盖；非法枚举静默跳过", async () => {
      const set = await createWithDefaults({ OWC_DEFAULT_EFFORT: "high", OWC_DEFAULT_SNAPSHOT_MODE: "manual" });
      try {
        expect(set.response.statusCode, set.response.body).toBe(201);
        expect(set.response.json()).toMatchObject({ effort: "high", snapshotMode: "manual" });
        const id = set.response.json<{ id: string }>().id;
        expect(await set.setup.sessions.get(id)).toMatchObject({ effort: "high", snapshotMode: "manual" });
        // 会话自身配置优先于全局默认
        const updated = await set.setup.app.inject({ method: "PUT", url: `/api/sessions/${id}/config`, payload: { effort: "low" } });
        expect(updated.statusCode, updated.body).toBe(200); expect(updated.json()).toMatchObject({ effort: "low" });
      } finally {
        await set.setup.app.close();
      }
      // 缺省（none/auto）：不带这两个键
      const unset = await createWithDefaults({});
      try {
        expect(unset.response.statusCode, unset.response.body).toBe(201);
        expect(unset.response.json<Record<string, unknown>>().effort).toBeUndefined();
        expect(unset.response.json<Record<string, unknown>>().snapshotMode).toBeUndefined();
      } finally {
        await unset.setup.app.close();
      }
      // env 直写非法枚举：不阻断创建
      const bogus = await createWithDefaults({ OWC_DEFAULT_EFFORT: "bogus" });
      try {
        expect(bogus.response.statusCode, bogus.response.body).toBe(201);
        expect(bogus.response.json<Record<string, unknown>>().effort).toBeUndefined();
      } finally {
        await bogus.setup.app.close();
      }
    });

    it("快照后端偏好：可用则直接预设，平台不可用回落自动并告警", async () => {
      const preset = await createWithDefaults({ OWC_SNAPSHOT_BACKEND: "git-shadow" });
      try {
        expect(preset.response.json()).toMatchObject({ snapshotBackend: "git-shadow" });
      } finally {
        await preset.setup.app.close();
      }
      // 指定后端在当前平台不可用（如 win32 上的 btrfs）：跳过探测链，回落自动并告警
      const fallback = await createWithDefaults({ OWC_SNAPSHOT_BACKEND: "btrfs" });
      try {
        expect(fallback.response.statusCode, fallback.response.body).toBe(201);
        expect(fallback.response.json<Record<string, unknown>>().snapshotBackend).toBeUndefined();
        expect(fallback.setup.observed.find((item) => item.type === "snapshot.backend_fallback")).toMatchObject({ payload: { preferred: "btrfs" } });
      } finally {
        await fallback.setup.app.close();
      }
    });
  });
  describe("PATCH /api/sessions/:id", () => {
    async function displayApp() {
      return await makeTestApp({ tempPrefix: "owc-session-display-", configureProviders: (providers) => providers.register(makeStubProvider("test")) });
    }
    it("标题覆盖与清除回落、置顶往返、不改 updatedAt；校验错误 400 / 未知会话 404", async () => {
      const setup = await displayApp();
      const { root, sessions, app } = setup;
      const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/sessions/${id}`, payload });
      try {
        const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: "帮我修一个 failing test" }]);
        expect((await patch(session.id, { title: "  我的会话  " })).json()).toMatchObject({ title: "我的会话" });
        expect((await patch(session.id, { pinned: true })).json()).toMatchObject({ pinned: true });
        // 列表响应携带展示字段（向后兼容：未置顶时不带 pinned 键）
        expect((await app.inject({ method: "GET", url: "/api/sessions" })).json()[0]).toMatchObject({ title: "我的会话", pinned: true });
        const reloaded = new SessionStore(path.join(root, "sessions"));
        await reloaded.initialize(); expect(await reloaded.get(session.id)).toMatchObject({ title: "我的会话", pinned: true });
        // 空串清除覆盖 → 回落到首条用户消息派生的标题
        const cleared = await patch(session.id, { title: "", pinned: false }); expect(cleared.json().title).toBe("帮我修一个 failing test");
        expect(cleared.json()).not.toHaveProperty("pinned");
        // 空会话无消息可派生 → 默认标题
        const empty = await sessions.create({ cwd: "/tmp", provider: "test", model: "m", title: "自定义" });
        expect((await patch(empty.id, { title: "   " })).json().title).toBe("New session");
        // 纯展示属性不更新 updatedAt（不应改变列表排序）
        const display = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
        expect((await patch(display.id, { title: "新标题", pinned: true })).json().updatedAt).toBe(display.updatedAt);
        expect((await sessions.get(display.id))?.updatedAt).toBe(display.updatedAt);
        // 校验错误：超长标题、类型错误、空 body、未知会话
        expect((await patch(session.id, { title: "x".repeat(121) })).statusCode).toBe(400);
        expect((await patch(session.id, { title: 42 })).statusCode).toBe(400);
        expect((await patch(session.id, { pinned: "yes" })).statusCode).toBe(400); expect((await patch(session.id, {})).statusCode).toBe(400);
        expect((await patch("00000000-0000-0000-0000-000000000000", { pinned: true })).statusCode).toBe(404);
        expect(await sessions.get(session.id)).not.toHaveProperty("pinned");
      } finally {
        await app.close();
      }
    });

    it("派生标题只发布一次 session.updated 并触发一次 onDerivedTitle", async () => {
      const { sessions, events, app } = await displayApp();
      try {
        const published: AppEvent[] = [];
        events.on("event", (event: AppEvent) => published.push(event));
        const derived: string[] = [];
        const publish = sessions.onDerivedTitle; // buildServer 已接线事件发布，测试回调需串联
        sessions.onDerivedTitle = (meta) => { derived.push(meta.title); publish?.(meta); };
        const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
        // assistant 消息不触发派生
        await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "先说话" }]);
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: "帮我修一个 failing test" }]);
        const updates = published.filter((event) => event.type === "session.updated"); expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({ sessionId: session.id, payload: { title: "帮我修一个 failing test" } });
        expect(derived).toEqual(["帮我修一个 failing test"]);
        // 后续用户消息与已自定义标题的会话都不再触发
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: "再补充一点" }]);
        const titled = await sessions.create({ cwd: "/tmp", provider: "test", model: "m", title: "自定义" });
        await sessions.appendMessage(titled.id, "user", [{ type: "text", text: "hello" }]);
        expect(published.filter((event) => event.type === "session.updated")).toHaveLength(1); expect(derived).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });
});
