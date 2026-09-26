import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { InteractionCoordinator } from "../src/agent/interaction-coordinator.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import { EventBus } from "../src/events/event-bus.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("待决计数协调器", () => {
  it("PermissionCoordinator：request 计入、abort 解除，按会话分组", async () => {
    const coordinator = new PermissionCoordinator(new EventBus());
    const first = new AbortController();
    const second = new AbortController();
    void coordinator.request("s1", "bash", { cmd: "npm test" }, first.signal);
    void coordinator.request("s1", "bash", { cmd: "rm -rf build" }, second.signal);
    void coordinator.request("s2", "write_file", { path: "a.ts" }, new AbortController().signal);
    expect([...coordinator.pendingCountsBySession()]).toEqual([["s1", 2], ["s2", 1]]);

    first.abort();
    second.abort();
    await Promise.resolve();
    expect([...coordinator.pendingCountsBySession()]).toEqual([["s2", 1]]);
  });

  it("InteractionCoordinator：create 计入、答完归零删条目、forgetSession 清理", async () => {
    const root = await tempRoot("owc-interaction-counts-");
    // coordinator 只负责 <会话目录>/interactions.json，会话目录手工建立
    await mkdir(path.join(root, "s1"), { recursive: true });
    await mkdir(path.join(root, "s2"), { recursive: true });
    const coordinator = new InteractionCoordinator((sessionId) => path.join(root, sessionId));
    expect(coordinator.pendingCountsBySession().size).toBe(0);

    const created = await coordinator.create("s1", { runId: "r1", kind: "single_select", title: "选一个", prompt: "选哪个", options: [{ id: "a", label: "A" }] });
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
  it("有待办的会话带 attention（含零值之外的计数），其余会话不带该字段", async () => {
    // 可写的 attention 表：只有出现在表里且计数非零的会话才该带字段
    const attention: Record<string, { permissions: number; interactions: number }> = {};
    const setup = await makeTestApp({
      tempPrefix: "owc-attention-",
      configureProviders: (providers) => providers.register(makeStubProvider("test-stub")),
      agent: { isRunning: () => false, attentionBySession: () => attention } as unknown as AgentRunner,
    });
    try {
      const create = async () => (await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "test-stub", model: "m" } })).json().id as string;
      const firstId = await create();
      const secondId = await create();
      attention[secondId] = { permissions: 1, interactions: 2 };
      attention[firstId] = { permissions: 0, interactions: 0 };

      const list = (await setup.app.inject({ method: "GET", url: "/api/sessions" })).json() as Array<{ id: string; attention?: unknown }>;
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.find((item) => item.id === secondId)?.attention).toEqual({ permissions: 1, interactions: 2 });
      // 零值不算待办，未登记与全零的会话都不带字段
      expect(list.every((item) => item.id === secondId || item.attention === undefined)).toBe(true);
    } finally {
      await setup.app.close();
    }
  });
});
