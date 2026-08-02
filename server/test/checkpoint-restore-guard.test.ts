import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { Checkpoint, SnapshotBackend } from "../src/snapshots/backend.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * 快照回退互斥：restore（含 truncateMessages/replaceLedger）全程拒绝新消息起跑，
 * 关闭「回退进行中 run 起跑、触发消息随后被截断」的竞态；回退后回收持久 shell。
 */

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeBackend(onRestore?: () => Promise<void>): { backend: SnapshotBackend; checkpoint: Checkpoint } {
  const checkpoint: Checkpoint = { id: "snap-test-1", label: "test", createdAt: new Date().toISOString(), messageCount: 0 };
  const backend: SnapshotBackend = {
    name: "fake",
    async initialize() { /* no-op */ },
    async capability() { return { backend: "fake", costHint: "instant", requiresAdmin: false }; },
    async create(_label: string, messageCount: number, ledger?: unknown) {
      checkpoint.messageCount = messageCount;
      checkpoint.ledger = ledger;
      return checkpoint;
    },
    async list() { return [checkpoint]; },
    async diff() { return ""; },
    async restore() { await onRestore?.(); },
    async delete() { /* no-op */ },
  };
  return { backend, checkpoint };
}

async function setup(backend: SnapshotBackend) {
  const root = await tempRoot("owc-restore-guard-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const observed: AppEvent[] = [];
  events.on("event", (event: AppEvent) => observed.push(event));
  const core = { on() { return core; } } as unknown as CoreClient;
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, resolveSnapshotBackend: async () => backend });
  apps.push(app);
  return { sessions, agent, app, observed };
}

describe("checkpoint restore 互斥与清理", () => {
  it("回退进行中 POST /messages 409；回退完成后截断消息、回收持久 shell、可继续", async () => {
    const restoreStarted = deferred();
    const restoreGate = deferred();
    const { backend, checkpoint } = fakeBackend(() => {
      restoreStarted.resolve();
      return restoreGate.promise;
    });
    const { sessions, agent, app, observed } = await setup(backend);
    const session = await sessions.create({ cwd: await tempRoot("owc-restore-ws-"), title: "Restore guard" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "第一条" }]);

    const created = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkpoints`, payload: { label: "pre" } });
    expect(created.statusCode).toBe(201);
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "第二条" }]);

    const disposeSpy = vi.spyOn(agent, "disposePersistentShells");
    const restorePromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`,
      payload: { confirm: true },
    });
    // 等 restore 真正开始（卡在 fake backend 的闸门里），此时发消息必须被互斥拒绝
    await restoreStarted.promise;
    const during = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "继续" } });
    expect(during.statusCode).toBe(409);
    expect(during.json<{ error: string }>().error).toMatch(/restore/i);
    expect(agent.isRunning(session.id)).toBe(false);

    restoreGate.resolve();
    const restored = await restorePromise;
    expect(restored.statusCode, restored.body).toBe(200);
    // 完整回滚：消息截回检查点时的 1 条；持久 shell 已回收；事件已发布
    expect((await sessions.get(session.id))!.messages).toHaveLength(1);
    expect(disposeSpy).toHaveBeenCalledWith(session.id);
    expect(observed.some((event) => event.type === "checkpoint.restored")).toBe(true);

    // 回退结束后会话可继续（无 provider，run 异步失败不影响路由受理）
    const after = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "继续" } });
    expect(after.statusCode).toBe(202);
  }, 30_000);
});
