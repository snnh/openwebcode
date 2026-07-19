import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup(input: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-todos-")); roots.push(root);
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
