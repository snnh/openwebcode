import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function setup(input: Record<string, unknown>) {
  const root = await tempRoot("owc-todos-");
  const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
  const events = new EventBus(); const observed: AppEvent[] = [];
  events.on("event", (event: AppEvent) => observed.push(event));
  const requests: StreamChatRequest[] = []; let turn = 0;
  const provider: Provider = { name: "fake", async *streamChat(request) {
    requests.push(request);
    if (turn++ === 0) {
      yield { type: "tool_call", id: "todo-1", name: "todo_write", input };
      yield { type: "done", stopReason: "tool_use" };
    } else { yield { type: "done", stopReason: "end_turn" }; }
  } };
  const providers = new ProviderRegistry(); providers.register(provider);
  const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClientLike;
  const runner = new AgentRunner(sessions, providers, core, events, pricing);
  await runner.run(session.id, "track work");
  return { runner, session, sessions, requests, observed };
}

describe("todo_write", () => {
  it("replaces the task list, publishes snapshots, and clears it after the run", async () => {
    const items = [
      { content: "First", status: "in_progress", activeForm: "Doing first" },
      { content: "Second", status: "pending" },
    ];
    const result = await setup({ items });
    expect(result.requests[0]?.tools.map((tool) => tool.name)).toContain("todo_write");
    const updates = result.observed.filter((event) => event.type === "todos.updated");
    expect(updates.map((event) => event.payload)).toEqual([{ items }, { items: [] }]);
    expect(result.runner.listTodos(result.session.id)).toEqual([]);
    expect(result.observed.some((event) => event.type === "permission.request")).toBe(false);
  });

  it("returns an error for invalid status without updating the task list", async () => {
    const result = await setup({ items: [{ content: "Bad", status: "blocked" }] });
    const detail = await result.sessions.get(result.session.id);
    const toolResult = detail?.messages.flatMap((message) => message.content).find((block) => block.type === "tool_result" && block.toolCallId === "todo-1");
    expect(toolResult).toMatchObject({ isError: true });
    expect(result.observed.filter((event) => event.type === "todos.updated").map((event) => event.payload)).toEqual([{ items: [] }]);
  });
});

// A3 验收补：REST 路由 GET /api/sessions/:id/todos 行为（含 404）
describe("GET /api/sessions/:id/todos", () => {
  it("返回当前快照（与 agent.listTodos 一致）；404 on missing session", async () => {
    const root = await tempRoot("owc-todos-rest-");
    const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* () { yield { type: "done", stopReason: "end_turn" }; }));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClientLike;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    try {
      // 空 -> []
      const empty = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/todos` });
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.json()).toEqual([]);
      // 会话不存在 -> 404
      const missing = await app.inject({ method: "GET", url: `/api/sessions/00000000-0000-0000-0000-000000000000/todos` });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
