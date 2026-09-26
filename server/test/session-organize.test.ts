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

/**
 * 会话组织：手工标签组（group）与归档（archived）。
 * 守则：有活动（运行中 run / 后台任务 / 终端 PTY）就拒绝归档；归档即释放空闲常驻资源。
 */
async function setup() {
  const root = await tempRoot("owc-session-organize-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const providers = new ProviderRegistry();
  providers.register({ name: "test", async *streamChat() { yield { type: "done" as const, stopReason: "end_turn" as const }; } });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  // 可变的活动状态：测试按需打开（运行中 / 后台任务 / 终端），归档守则据此拒绝
  const flags = { running: false, backgroundRunning: false, pty: new Set<string>() };
  const discarded: Array<{ id: string; cwd?: string }> = [];
  const released: string[] = [];
  const agent = {
    isRunning: () => flags.running,
    discardSession: (id: string, cwd?: string) => { discarded.push({ id, ...(cwd ? { cwd } : {}) }); },
  } as unknown as AgentRunner;
  const core = { activePtySessions: () => new Set(flags.pty) } as unknown as CoreClient;
  const app = await buildServer({
    core,
    sessions,
    agent,
    events: new EventBus(),
    providers,
    pricing,
    backgroundTasks: { hasRunningForSession: () => flags.backgroundRunning } as never,
    indexManager: { release: async (cwd: string) => { released.push(cwd); return true; } } as never,
  });
  return { root, sessions, app, flags, discarded, released };
}

describe("PATCH /api/sessions/:id：标签组与归档", () => {
  it("分组往返：设置、覆盖、空串移出分组；重读持久化", async () => {
    const { root, sessions, app } = await setup();
    const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });

    const grouped = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { group: " 前端  " } });
    expect(grouped.statusCode).toBe(200);
    expect(grouped.json()).toMatchObject({ group: "前端" });

    const renamed = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { group: "产品线 A" } });
    expect(renamed.json()).toMatchObject({ group: "产品线 A" });

    const reloaded = new SessionStore(path.join(root, "sessions"));
    await reloaded.initialize();
    expect(await reloaded.get(session.id)).toMatchObject({ group: "产品线 A" });

    // 空串 = 移出分组：删键而不是存空串
    const cleared = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { group: "" } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).not.toHaveProperty("group");
  });

  it("分组名校验：超过 40 字符 / 类型错误 → 400", async () => {
    const { sessions, app } = await setup();
    const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
    const tooLong = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { group: "x".repeat(41) } });
    expect(tooLong.statusCode).toBe(400);
    const wrongType = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { group: 7 } });
    expect(wrongType.statusCode).toBe(400);
    const emptyBody = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: {} });
    expect(emptyBody.statusCode).toBe(400);
  });

  it("归档与撤销归档：列表携带 archived，撤销后键被删除", async () => {
    const { sessions, app } = await setup();
    const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });

    const archived = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ archived: true });
    const list = (await app.inject({ method: "GET", url: "/api/sessions" })).json() as Array<{ id: string; archived?: boolean }>;
    expect(list.find((item) => item.id === session.id)?.archived).toBe(true);

    const restored = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { archived: false } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).not.toHaveProperty("archived");
  });

  it("归档释放空闲常驻资源：丢弃会话缓存并释放索引工作区（索引文件留磁盘）", async () => {
    const { sessions, app, discarded, released } = await setup();
    const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
    const archived = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    expect(discarded).toEqual([{ id: session.id, cwd: "/tmp" }]);
    expect(released).toEqual(["/tmp"]);
    // 重复归档（已归档）不再重复释放
    await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { archived: true } });
    expect(released).toEqual(["/tmp"]);
  });

  it("有活动的会话拒绝归档（运行中 / 后台任务 / 终端）→ 409，会话保持未归档", async () => {
    for (const kind of ["running", "background", "pty"] as const) {
      const { sessions, app, flags, released } = await setup();
      const session = await sessions.create({ cwd: "/tmp", provider: "test", model: "m" });
      if (kind === "running") flags.running = true;
      if (kind === "background") flags.backgroundRunning = true;
      if (kind === "pty") flags.pty.add(session.id);

      const response = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { archived: true } });
      expect(response.statusCode, kind).toBe(409);
      expect((response.json() as { error: string }).error, kind).toMatch(/stop|close/i);
      // 拒绝归档时不做释放，会话仍是未归档
      expect(released, kind).toEqual([]);
      expect(await sessions.getMeta(session.id)).not.toMatchObject({ archived: true });
    }
  });
});
