import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { INIT_COMMAND_PROMPT } from "../src/agent/prompts/init-prompt.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRootRetry } from "./helpers/temp-dir.js";

const tempRoot = (): Promise<string> => tempRootRetry("owc-init-");

async function waitForUserMessage(sessions: SessionStore, id: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await sessions.get(id);
    if (detail && detail.messages.some((m) => m.role === "user")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("/init composer command", () => {
  it("expands to the built-in init prompt and runs the agent with it", async () => {
    const root = await tempRoot();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const seen: string[] = [];
    providers.register(makeStubProvider("test-stub", async function* (request) {
      const last = request.messages.at(-1);
      const text = last?.content.find((block) => block.type === "text");
      if (text?.type === "text") seen.push(text.text);
      yield { type: "text_delta", text: "已生成 AGENTS.md" };
      yield { type: "done", stopReason: "end_turn" };
    }));
    const events = new EventBus();
    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
      async cleanupSession() { return { ok: true }; },
      async ping() { return { version: "0.0.0", platform: "windows", sandboxCapability: "advisory" }; },
      setRequestTimeoutMs() {},
    } as unknown as CoreClientLike;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    try {
      const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: "Init route" });
      const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/init" } });
      expect(response.statusCode, response.body).toBe(202);
      await waitForUserMessage(sessions, session.id);
      // provider 调用在用户消息落盘之后，轮询等待首轮请求到达
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 5_000 });
      const detail = await sessions.get(session.id);
      const userMsg = detail?.messages.find((m) => m.role === "user");
      const text = userMsg?.content.find((block) => block.type === "text");
      expect(text).toMatchObject({ type: "text", text: INIT_COMMAND_PROMPT });
      expect(seen).toContain(INIT_COMMAND_PROMPT);

      vi.spyOn(agent, "isRunning").mockReturnValue(true);
      const running = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/init" } });
      expect(running.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
