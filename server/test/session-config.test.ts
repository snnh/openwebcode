import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
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

    beforeEach(async () => {
      root = await tempRoot("owc-session-config-");
      sessions = new SessionStore(path.join(root, "sessions"));
      await sessions.initialize();
      const provider: Provider = { name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } };
      const providers = new ProviderRegistry();
      providers.register(provider);
      const pricing = new PricingCatalog(path.join(root, "pricing.json"));
      await pricing.initialize();
      const agent = { isRunning: () => false } as AgentRunner;
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
  });
});
