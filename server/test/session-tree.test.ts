import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage, TextContent } from "../src/sessions/types.js";
import { makeStubProvider, type StubProviderHandler } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

function createFakeCore(): CoreClientLike {
  return {
    on() { return this; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile() { return { content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [] }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 1 }; },
    async run() { return { exitCode: 0, durationMs: 0, truncated: false }; },
    async cleanupSession() { return { ok: true as const }; },
    setRequestTimeoutMs() {},
    start() { return Promise.resolve({ version: "0.0.0", platform: "windows" as const, sandboxCapability: "advisory" }); },
    stop() { return Promise.resolve(); },
    ping() { return Promise.resolve({ version: "0.0.0", platform: "windows" as const, sandboxCapability: "advisory" }); },
    listFiles() { return Promise.resolve({ entries: [], truncated: false }); },
  } as unknown as CoreClientLike;
}

interface Rig {
  root: string;
  sessions: SessionStore;
  agent: AgentRunner;
  app: Awaited<ReturnType<typeof buildServer>>;
}

async function makeRig(handler?: StubProviderHandler): Promise<Rig> {
  const root = await tempRoot("owc-tree-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("test-stub", handler));
  const events = new EventBus();
  const core = createFakeCore();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, agent, app };
}

function appendText(sessions: SessionStore, sessionId: string, role: "user" | "assistant", text: string): Promise<ChatMessage> {
  return sessions.appendMessage(sessionId, role, [{ type: "text", text }]);
}

function messageText(message: ChatMessage): string {
  return message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
}

interface TimelineBody {
  activeLeafId?: string;
  entries: Array<{ id: string; parentId?: string; role: string; createdAt: string; onActivePath: boolean }>;
}

describe("POST /api/sessions/:id/checkout", () => {
  it("moves the active leaf; later appends parent to it; old branch stays visible in timeline", async () => {
    const rig = await makeRig();
    try {
      const session = await rig.sessions.create({ cwd: rig.root, provider: "test-stub", model: "deterministic-tool-loop", title: "Tree" });
      const u1 = await appendText(rig.sessions, session.id, "user", "u1");
      const a1 = await appendText(rig.sessions, session.id, "assistant", "a1");
      const u2 = await appendText(rig.sessions, session.id, "user", "u2");
      const a2 = await appendText(rig.sessions, session.id, "assistant", "a2");

      const res = await rig.app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkout`, payload: { messageId: a1.id } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, activeLeafId: a1.id });

      const u3 = await appendText(rig.sessions, session.id, "user", "u3");
      expect(u3.parentId).toBe(a1.id);

      const timeline = await rig.app.inject({ method: "GET", url: `/api/sessions/${session.id}/timeline` });
      expect(timeline.statusCode, timeline.body).toBe(200);
      const body = timeline.json<TimelineBody>();
      expect(body.activeLeafId).toBe(u3.id);
      // 全部 5 个树节点都在投影中（含旧分支 u2/a2）
      expect(body.entries).toHaveLength(5);
      const flags = new Map(body.entries.map((entry) => [entry.id, entry.onActivePath]));
      expect(flags.get(u1.id)).toBe(true);
      expect(flags.get(a1.id)).toBe(true);
      expect(flags.get(u3.id)).toBe(true);
      expect(flags.get(u2.id)).toBe(false);
      expect(flags.get(a2.id)).toBe(false);
      for (let i = 1; i < body.entries.length; i++) {
        expect(body.entries[i]!.createdAt >= body.entries[i - 1]!.createdAt).toBe(true);
      }
    } finally {
      await rig.app.close();
    }
  });
});

describe("POST /api/sessions/:id/fork", () => {
  it("copies the full active path plus session config into a new same-cwd session", async () => {
    const rig = await makeRig();
    try {
      const source = await rig.sessions.create({ cwd: rig.root, provider: "test-stub", model: "deterministic-tool-loop", title: "Origin" });
      await appendText(rig.sessions, source.id, "user", "u1");
      await appendText(rig.sessions, source.id, "assistant", "a1");
      await appendText(rig.sessions, source.id, "user", "u2");
      const a2 = await appendText(rig.sessions, source.id, "assistant", "a2");
      await rig.sessions.updateConfig(source.id, { provider: "test-stub", model: "deterministic-tool-loop", thinking: "enabled", effort: "high", snapshotMode: "manual", shellBackend: "pwsh" });

      const res = await rig.app.inject({ method: "POST", url: `/api/sessions/${source.id}/fork`, payload: {} });
      expect(res.statusCode, res.body).toBe(201);
      const { sessionId } = res.json<{ sessionId: string }>();
      expect(sessionId).not.toBe(source.id);

      const forked = await rig.sessions.get(sessionId);
      expect(forked).toBeDefined();
      expect(forked!.cwd).toBe(source.cwd);
      expect(forked!.provider).toBe("test-stub");
      expect(forked!.model).toBe("deterministic-tool-loop");
      expect(forked!.title).toBe("Origin (分支)");
      expect(forked!.thinking).toBe("enabled");
      expect(forked!.effort).toBe("high");
      expect(forked!.snapshotMode).toBe("manual");
      expect(forked!.shellBackend).toBe("pwsh");

      expect(forked!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(forked!.messages.map(messageText)).toEqual(["u1", "a1", "u2", "a2"]);
      // 复制获得新 id，父链沿路径线性重建，活动叶子落在最后一条
      expect(forked!.messages[0]!.parentId).toBeUndefined();
      for (let i = 1; i < forked!.messages.length; i++) {
        expect(forked!.messages[i]!.parentId).toBe(forked!.messages[i - 1]!.id);
      }
      expect(forked!.activeLeafId).toBe(forked!.messages.at(-1)!.id);

      // 源会话不受影响
      const after = await rig.sessions.get(source.id);
      expect(after!.messages).toHaveLength(4);
      expect(after!.activeLeafId).toBe(a2.id);
    } finally {
      await rig.app.close();
    }
  });

  it("truncates the copied path at messageId when provided", async () => {
    const rig = await makeRig();
    try {
      const source = await rig.sessions.create({ cwd: rig.root, provider: "test-stub", model: "deterministic-tool-loop", title: "Origin" });
      await appendText(rig.sessions, source.id, "user", "u1");
      const a1 = await appendText(rig.sessions, source.id, "assistant", "a1");
      await appendText(rig.sessions, source.id, "user", "u2");
      await appendText(rig.sessions, source.id, "assistant", "a2");

      const res = await rig.app.inject({ method: "POST", url: `/api/sessions/${source.id}/fork`, payload: { messageId: a1.id } });
      expect(res.statusCode, res.body).toBe(201);
      const { sessionId } = res.json<{ sessionId: string }>();
      const forked = await rig.sessions.get(sessionId);
      expect(forked!.messages.map(messageText)).toEqual(["u1", "a1"]);
      expect(forked!.activeLeafId).toBe(forked!.messages.at(-1)!.id);
    } finally {
      await rig.app.close();
    }
  });
});

describe("POST /api/sessions/:id/messages/:messageId/retry", () => {
  async function runTwoTurns(rig: Rig, _captured: ChatMessage[][]): Promise<{ sessionId: string; secondUser: ChatMessage; secondAssistant: ChatMessage }> {
    const session = await rig.sessions.create({ cwd: rig.root, provider: "test-stub", model: "deterministic-tool-loop", title: "Retry" });
    for (const content of ["first question", "second question"]) {
      const res = await rig.app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content } });
      expect(res.statusCode, res.body).toBe(202);
      await vi.waitFor(() => expect(rig.agent.isRunning(session.id)).toBe(false), { timeout: 10000 });
    }
    const detail = await rig.sessions.get(session.id);
    const users = detail!.messages.filter((message) => message.role === "user");
    const assistants = detail!.messages.filter((message) => message.role === "assistant");
    expect(users).toHaveLength(2);
    expect(assistants).toHaveLength(2);
    return { sessionId: session.id, secondUser: users[1]!, secondAssistant: assistants[1]! };
  }

  it("re-runs from the target user message: provider history ends at that message", async () => {
    const captured: ChatMessage[][] = [];
    const rig = await makeRig(async function* (request) {
      captured.push(request.messages.map((message) => ({ ...message, content: [...message.content] })));
      yield { type: "text_delta", text: "stub reply" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
    });
    try {
      const { sessionId, secondUser, secondAssistant } = await runTwoTurns(rig, captured);
      expect(captured).toHaveLength(2);

      const res = await rig.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages/${secondUser.id}/retry`, payload: {} });
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({ ok: true });
      await vi.waitFor(() => expect(rig.agent.isRunning(sessionId)).toBe(false), { timeout: 10000 });

      expect(captured).toHaveLength(3);
      const retryHistory = captured[2]!;
      expect(retryHistory.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(messageText(retryHistory.at(-1)!)).toBe("second question");
      // 旧分支的 assistant 回复不再进入 provider 历史
      expect(retryHistory.some((message) => message.id === secondAssistant.id)).toBe(false);

      // 树中保留旧分支，活动路径切到新分支
      const timeline = await rig.app.inject({ method: "GET", url: `/api/sessions/${sessionId}/timeline` });
      const body = timeline.json<TimelineBody>();
      expect(body.entries).toHaveLength(6);
      const flags = new Map(body.entries.map((entry) => [entry.id, entry.onActivePath]));
      expect(flags.get(secondUser.id)).toBe(false);
      expect(flags.get(secondAssistant.id)).toBe(false);
      expect([...flags.values()].filter(Boolean)).toHaveLength(4);
    } finally {
      await rig.app.close();
    }
  });

  it("appends the edited user message first when editedContent is provided", async () => {
    const captured: ChatMessage[][] = [];
    const rig = await makeRig(async function* (request) {
      captured.push(request.messages.map((message) => ({ ...message, content: [...message.content] })));
      yield { type: "text_delta", text: "stub reply" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
    });
    try {
      const { sessionId, secondUser } = await runTwoTurns(rig, captured);
      const parentId = secondUser.parentId;
      expect(parentId).toBeDefined();

      const res = await rig.app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/messages/${secondUser.id}/retry`,
        payload: { editedContent: "  edited second question  " },
      });
      expect(res.statusCode, res.body).toBe(202);
      await vi.waitFor(() => expect(rig.agent.isRunning(sessionId)).toBe(false), { timeout: 10000 });

      const retryHistory = captured.at(-1)!;
      expect(messageText(retryHistory.at(-1)!)).toBe("  edited second question  ");

      const detail = await rig.sessions.get(sessionId);
      const edited = detail!.messages.find((message) => messageText(message).includes("edited second question"));
      expect(edited).toBeDefined();
      expect(edited!.role).toBe("user");
      expect(edited!.parentId).toBe(parentId);
      expect(detail!.activeLeafId).not.toBe(secondUser.id);
    } finally {
      await rig.app.close();
    }
  });

  it("returns 409 for checkout and retry while the session is running", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const rig = await makeRig(async function* () {
      await gate;
      yield { type: "text_delta", text: "stub reply" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
    });
    try {
      const session = await rig.sessions.create({ cwd: rig.root, provider: "test-stub", model: "deterministic-tool-loop", title: "Busy" });
      const u1 = await appendText(rig.sessions, session.id, "user", "u1");
      const u2 = await appendText(rig.sessions, session.id, "user", "u2");

      const start = await rig.app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "blocking run" } });
      expect(start.statusCode, start.body).toBe(202);
      expect(rig.agent.isRunning(session.id)).toBe(true);

      const checkout = await rig.app.inject({ method: "POST", url: `/api/sessions/${session.id}/checkout`, payload: { messageId: u1.id } });
      expect(checkout.statusCode, checkout.body).toBe(409);

      const retry = await rig.app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages/${u2.id}/retry`, payload: {} });
      expect(retry.statusCode, retry.body).toBe(409);

      releaseGate();
      await vi.waitFor(() => expect(rig.agent.isRunning(session.id)).toBe(false), { timeout: 10000 });
    } finally {
      await rig.app.close();
    }
  });
});


describe("session tree routes reject invalid parameters", () => {
  interface RejectCase {
    name: string;
    url: (sessionId: string, ids: { u1: string; a1: string }) => string;
    payload: Record<string, unknown>;
    status: number;
  }
  const cases: RejectCase[] = [
    { name: "checkout: missing messageId", url: (id) => `/api/sessions/${id}/checkout`, payload: {}, status: 400 },
    { name: "checkout: unknown messageId", url: (id) => `/api/sessions/${id}/checkout`, payload: { messageId: randomUUID() }, status: 400 },
    { name: "checkout: unknown session", url: () => `/api/sessions/${randomUUID()}/checkout`, payload: { messageId: randomUUID() }, status: 404 },
    { name: "fork: unknown session", url: () => `/api/sessions/${randomUUID()}/fork`, payload: {}, status: 404 },
    { name: "fork: unknown messageId", url: (id) => `/api/sessions/${id}/fork`, payload: { messageId: randomUUID() }, status: 400 },
    { name: "retry: unknown message", url: (id) => `/api/sessions/${id}/messages/${randomUUID()}/retry`, payload: {}, status: 400 },
    { name: "retry: non-user target", url: (id, ids) => `/api/sessions/${id}/messages/${ids.a1}/retry`, payload: {}, status: 400 },
    { name: "retry: root user message", url: (id, ids) => `/api/sessions/${id}/messages/${ids.u1}/retry`, payload: {}, status: 400 },
    { name: "retry: unknown session", url: (_id, ids) => `/api/sessions/${randomUUID()}/messages/${ids.u1}/retry`, payload: {}, status: 404 },
  ];

  it.each(cases)("$name -> $status", async ({ url, payload, status }) => {
    const rig = await makeRig();
    try {
      const session = await rig.sessions.create({ cwd: rig.root, provider: "test-stub", model: "deterministic-tool-loop", title: "Reject" });
      const u1 = await appendText(rig.sessions, session.id, "user", "u1");
      const a1 = await appendText(rig.sessions, session.id, "assistant", "a1");
      const res = await rig.app.inject({ method: "POST", url: url(session.id, { u1: u1.id, a1: a1.id }), payload });
      expect(res.statusCode, res.body).toBe(status);
    } finally {
      await rig.app.close();
    }
  });
});
