import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

// 会话组织：手工标签组（group）与归档（archived）。
// 守则：有活动（运行中 run / 后台任务 / 终端 PTY）就拒绝归档；归档即释放空闲常驻资源。
async function setup() {
  const root = await tempRoot("owc-session-organize-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const providers = new ProviderRegistry();
  providers.register({ name: "test", async *streamChat() { yield { type: "done" as const, stopReason: "end_turn" as const }; } });
  const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
  const flags = { running: false, backgroundRunning: false, pty: new Set<string>() }; // 可变活动状态，测试按需打开
  const discarded: Array<{ id: string; cwd?: string }> = [], released: string[] = [];
  const agent = { isRunning: () => flags.running, discardSession: (id: string, cwd?: string) => { discarded.push({ id, ...(cwd ? { cwd } : {}) }); } } as unknown as AgentRunner;
  const core = { activePtySessions: () => new Set(flags.pty) } as unknown as CoreClient;
  const app = await buildServer({
    core, sessions, agent, events: new EventBus(), providers, pricing,
    backgroundTasks: { hasRunningForSession: () => flags.backgroundRunning } as never,
    indexManager: { release: async (cwd: string) => { released.push(cwd); return true; } } as never,
  });
  return {
    root, sessions, app, flags, discarded, released,
    create: () => sessions.create({ cwd: "/tmp", provider: "test", model: "m" }),
    patch: (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/sessions/${id}`, payload }),
  };
}

/** 装配 → 执行 → 关服，避免每个用例重复 try/finally */
async function withRig<T>(body: (rig: Awaited<ReturnType<typeof setup>>) => Promise<T>): Promise<T> {
  const rig = await setup();
  try { return await body(rig); } finally { await rig.app.close(); }
}

describe("PATCH /api/sessions/:id：标签组与归档", () => {
  it("分组往返并持久化；归档与撤销归档；非法值 400", async () => withRig(async ({ root, sessions, app, create, patch }) => {
    const session = await create();
    expect((await patch(session.id, { group: " 前端 " })).json()).toMatchObject({ group: "前端" });
    expect((await patch(session.id, { group: "产品线 A" })).json()).toMatchObject({ group: "产品线 A" });
    const reloaded = new SessionStore(path.join(root, "sessions"));
    await reloaded.initialize();
    expect(await reloaded.get(session.id)).toMatchObject({ group: "产品线 A" });
    // 空串 = 移出分组：删键而不是存空串
    const cleared = await patch(session.id, { group: "" });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).not.toHaveProperty("group");
    const invalid = await Promise.all([{ group: "x".repeat(41) }, { group: 7 }, {}].map((payload) => patch(session.id, payload)));
    expect(invalid.map((response) => response.statusCode)).toEqual([400, 400, 400]);
    // 归档：列表携带 archived；撤销归档后删键
    const archived = await patch(session.id, { archived: true });
    expect(archived.json()).toMatchObject({ archived: true });
    const list = (await app.inject({ method: "GET", url: "/api/sessions" })).json() as Array<{ id: string; archived?: boolean }>;
    expect(list.find((item) => item.id === session.id)?.archived).toBe(true);
    const restored = await patch(session.id, { archived: false });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).not.toHaveProperty("archived");
    expect(await sessions.getMeta(session.id)).not.toMatchObject({ archived: true });
  }));

  it("归档释放空闲常驻资源且幂等；有活动（运行中/后台任务/终端）时 409 且不释放", async () => {
    await withRig(async ({ discarded, released, flags, sessions, create, patch }) => {
      const session = await create();
      expect((await patch(session.id, { archived: true })).statusCode).toBe(200);
      expect(discarded).toEqual([{ id: session.id, cwd: "/tmp" }]);
      expect(released).toEqual(["/tmp"]);
      await patch(session.id, { archived: true }); // 已归档再归档不再重复释放
      expect(released).toEqual(["/tmp"]);
      for (const kind of ["running", "background", "pty"] as const) {
        flags.running = false; flags.backgroundRunning = false; flags.pty.clear();
        const busy = await create();
        if (kind === "running") flags.running = true;
        if (kind === "background") flags.backgroundRunning = true;
        if (kind === "pty") flags.pty.add(busy.id);
        const response = await patch(busy.id, { archived: true });
        expect(response.statusCode, kind).toBe(409);
        expect((response.json() as { error: string }).error, kind).toMatch(/stop|close/i);
        expect(released, kind).toEqual(["/tmp"]);
        expect(await sessions.getMeta(busy.id), kind).not.toMatchObject({ archived: true });
      }
    });
  });
});
