import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("AgentRunner file tools", () => {
  it("exposes and executes dedicated file tools through CoreClient", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-agent-fs-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "files", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "acceptEdits", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const calls: Array<{ sessionId: string; path: string; oldText: string; newText: string }> = [];
    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
      async editFile(request: { sessionId: string; path: string; oldText: string; newText: string }) { calls.push(request); return { matches: 1 }; },
    } as unknown as CoreClient;
    let turn = 0;
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "files",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          yield { type: "tool_call", id: "edit-1", name: "edit_file", input: { path: "src/a.ts", oldText: "a", newText: "b" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "edit it");

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "glob", "grep"]));
    expect(calls).toEqual([{ sessionId: session.id, path: "src/a.ts", oldText: "a", newText: "b" }]);
    const detail = await sessions.get(session.id);
    expect(await new GitShadowSnapshots(sessions.contextRoot(session.id), root).list()).toHaveLength(1);
    expect(detail?.messages.some((message) => message.role === "tool" && message.content.some((block) => block.type === "tool_result" && block.content.includes('"matches":1')))).toBe(true);
  });
});
