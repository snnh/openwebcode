import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { InteractionCoordinator } from "../src/agent/interaction-coordinator.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("PermissionCoordinator 待决计数", () => {
  it("request 计入、abort 解除；按会话分组", async () => {
    const coordinator = new PermissionCoordinator(new EventBus());
    const first = new AbortController();
    const second = new AbortController();
    void coordinator.request("s1", "bash", { cmd: "npm test" }, first.signal);
    void coordinator.request("s1", "bash", { cmd: "rm -rf build" }, second.signal);
    void coordinator.request("s2", "write_file", { path: "a.ts" }, new AbortController().signal);
    expect([...coordinator.pendingCountsBySession()]).toEqual([["s1", 2], ["s2", 1]]);

    first.abort();
    expect([...coordinator.pendingCountsBySession()]).toEqual([["s1", 1], ["s2", 1]]);
    second.abort();
    await Promise.resolve();
    expect([...coordinator.pendingCountsBySession()]).toEqual([["s2", 1]]);
  });
});

describe("InteractionCoordinator 待决计数", () => {
  it("create 计入、answer 归零、forgetSession 清理（唯一写路径维护内存计数）", async () => {
    const root = await tempRoot("owc-interaction-counts-");
    // 会话目录由 SessionStore 建立，这里手工建两个（coordinator 只负责 <会话目录>/interactions.json）
    await mkdir(path.join(root, "s1"), { recursive: true });
    await mkdir(path.join(root, "s2"), { recursive: true });
    const coordinator = new InteractionCoordinator((sessionId) => path.join(root, sessionId));
    expect(coordinator.pendingCountsBySession().size).toBe(0);

    const created = await coordinator.create("s1", {
      runId: "r1", kind: "single_select", title: "选一个", prompt: "选哪个",
      options: [{ id: "a", label: "A" }],
    });
    expect(coordinator.pendingCountsBySession().get("s1")).toBe(1);

    await coordinator.create("s1", { runId: "r1", kind: "confirm", title: "确认", prompt: "继续？" });
    expect(coordinator.pendingCountsBySession().get("s1")).toBe(2);

    await coordinator.answer("s1", created.id, "a");
    expect(coordinator.pendingCountsBySession().get("s1")).toBe(1);

    // 逐条答完 → 计数条目整体移除（会话列表不再带 attention）
    const remaining = (await coordinator.list("s1")).find((item) => item.status === "pending")!;
    await coordinator.answer("s1", remaining.id, true);
    expect(coordinator.pendingCountsBySession().has("s1")).toBe(false);

    await coordinator.create("s2", { runId: "r2", kind: "confirm", title: "确认", prompt: "继续？" });
    coordinator.forgetSession("s2");
    expect(coordinator.pendingCountsBySession().has("s2")).toBe(false);
  });
});

describe("GET /api/sessions 的 attention 字段", () => {
  /** 两个会话 + 一个可写的 attention 表：只有出现在表里的会话才该带 attention 字段 */
  async function fixture() {
    const root = await tempRoot("owc-attention-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* () {
      yield { type: "done", stopReason: "end_turn" };
    }));
    const events = new EventBus();
    const attention: Record<string, { permissions: number; interactions: number }> = {};
    const agent = {
      isRunning: () => false,
      attentionBySession: () => attention,
    } as unknown as AgentRunner;
    const app = await buildServer({ core: makeFakeCore({}), sessions, agent, events, providers, pricing });
    const create = async (): Promise<string> => {
      const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "test-stub", model: "m" } });
      return response.json().id as string;
    };
    return { app, attention, create };
  }

  it("有待办的会话带 attention，其余不带该字段", async () => {
    const { app, attention, create } = await fixture();
    const firstId = await create();
    const secondId = await create();
    attention[secondId] = { permissions: 1, interactions: 2 };

    const list = (await app.inject({ method: "GET", url: "/api/sessions" })).json() as Array<{ id: string; attention?: unknown }>;
    expect(list.find((item) => item.id === secondId)?.attention).toEqual({ permissions: 1, interactions: 2 });
    expect(list.find((item) => item.id === firstId)).not.toHaveProperty("attention");
  });

  it("零值不算待办：计数全为 0 的会话也不带 attention 字段", async () => {
    const { app, attention, create } = await fixture();
    const id = await create();
    attention[id] = { permissions: 0, interactions: 0 };

    const list = (await app.inject({ method: "GET", url: "/api/sessions" })).json() as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((item) => item.attention === undefined)).toBe(true);
  });
});
