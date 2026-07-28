import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-session-display-"));
  roots.push(root);
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
    const { root, sessions, app } = await setup();
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
    const { sessions, app } = await setup();
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
    const { sessions, app } = await setup();
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
    const { sessions, app } = await setup();
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
    const { sessions, events, app } = await setup();
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
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-derived-title-"));
    roots.push(root);
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
