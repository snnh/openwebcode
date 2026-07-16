import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
const roots: string[] = [];
const clients: CoreClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stage 3 vertical acceptance", () => {
  it.skipIf(!existsSync(corePath))(
    "runs a real-Core coding task through permission, cost, checkpoint, and rollback APIs",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "owc-stage3-e2e-"));
      roots.push(root);
      const sessions = new SessionStore(path.join(root, ".sessions"));
      await sessions.initialize();
      const pricing = new PricingCatalog(path.join(root, "pricing.json"));
      await pricing.initialize();
      const events = new EventBus();
      const captured: AppEvent[] = [];
      events.on("event", (event: AppEvent) => captured.push(event));
      const providers = new ProviderRegistry();
      let request = 0;
      const provider: Provider = {
        name: "anthropic",
        async *streamChat() {
          request++;
          if (request === 1) {
            yield { type: "tool_call", id: "write-allowed", name: "write_file", input: { path: "src/result.txt", content: "stage-three\n", createDirs: true } };
            yield { type: "usage", inputTokens: 100, outputTokens: 20, cacheRead: 10, cacheWrite: 5 };
            yield { type: "done", stopReason: "tool_use" };
          } else if (request === 2) {
            yield { type: "text_delta", text: "编码任务完成" };
            yield { type: "usage", inputTokens: 50, outputTokens: 10, cacheRead: 0, cacheWrite: 0 };
            yield { type: "done", stopReason: "end_turn" };
          } else if (request === 3) {
            yield { type: "tool_call", id: "write-denied", name: "write_file", input: { path: "denied.txt", content: "must-not-exist" } };
            yield { type: "done", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", text: "已遵守拒绝决定" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      };
      providers.register(provider);
      const core = new CoreClient(corePath);
      clients.push(core);
      await core.start();
      const agent = new AgentRunner(sessions, providers, core, events, pricing);
      const app = await buildServer({ core, sessions, agent, events, providers, pricing });

      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { cwd: root, provider: "anthropic", model: "claude-opus-4-8" },
        });
        expect(created.statusCode).toBe(201);
        const sessionId = created.json<{ id: string }>().id;

        const firstIdle = waitForEvent(events, sessionId, "agent.state", (event) =>
          (event.payload as { state?: string }).state === "idle");
        const firstPermission = waitForEvent(events, sessionId, "permission.request");
        const accepted = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "创建阶段三验收文件" } });
        expect(accepted.statusCode).toBe(202);
        const permission = await firstPermission;
        const requestId = (permission.payload as { requestId: string }).requestId;
        const allowed = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/permissions/respond`, payload: { requestId, decision: "allow" } });
        expect(allowed.statusCode).toBe(200);
        await firstIdle;

        expect(await readFile(path.join(root, "src/result.txt"), "utf8")).toBe("stage-three\n");
        const context = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/context` });
        expect(context.statusCode).toBe(200);
        const contextBody = context.json<{
          ledger: {
            usage: { inputTokens: number; outputTokens: number };
            cost: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
          };
        }>();
        expect(contextBody.ledger).toMatchObject({
          usage: { inputTokens: 150, outputTokens: 30 },
        });
        expect(BigInt(contextBody.ledger.cost.usdMicroUnits)).toBeGreaterThan(0n);
        expect(contextBody.ledger.cost.unpricedTokens).toBe(0);
        expect(captured.some((event) => event.type === "context.usage" && event.sessionId === sessionId)).toBe(true);
        expect(captured.some((event) => event.type === "tool.end" && event.sessionId === sessionId)).toBe(true);

        const checkpoints = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/checkpoints` });
        const checkpoint = checkpoints.json<Array<{ id: string }>>()[0];
        expect(checkpoint).toBeDefined();
        const restored = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/checkpoints/${checkpoint!.id}/restore`,
          payload: { confirm: true },
        });
        expect(restored.statusCode, restored.body).toBe(200);
        await expect(readFile(path.join(root, "src/result.txt"), "utf8")).rejects.toThrow();
        expect((await sessions.get(sessionId))?.messages).toHaveLength(0);

        const secondIdle = waitForEvent(events, sessionId, "agent.state", (event) =>
          (event.payload as { state?: string }).state === "idle");
        const secondPermission = waitForEvent(events, sessionId, "permission.request");
        expect((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "尝试写入但等待拒绝" } })).statusCode).toBe(202);
        const deniedRequestId = ((await secondPermission).payload as { requestId: string }).requestId;
        expect((await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/permissions/respond`,
          payload: { requestId: deniedRequestId, decision: "deny", reason: "验收拒绝" },
        })).statusCode).toBe(200);
        await secondIdle;
        await expect(readFile(path.join(root, "denied.txt"), "utf8")).rejects.toThrow();
        const detail = await sessions.get(sessionId);
        expect(detail?.messages.some((message) => message.role === "tool" && message.content.some((block) =>
          block.type === "tool_result" && block.isError && block.content === "验收拒绝"))).toBe(true);
      } finally {
        await app.close();
      }
    },
    30_000,
  );
});

function waitForEvent(
  events: EventBus,
  sessionId: string,
  type: string,
  predicate: (event: AppEvent) => boolean = () => true,
): Promise<AppEvent> {
  return new Promise((resolve) => {
    const listener = (event: AppEvent): void => {
      if (event.sessionId !== sessionId || event.type !== type || !predicate(event)) return;
      events.off("event", listener);
      resolve(event);
    };
    events.on("event", listener);
  });
}
