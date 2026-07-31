import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("AgentRunner file tools", () => {
  it("exposes and executes dedicated file tools through CoreClient", async () => {
    const root = await tempRoot("owc-agent-fs-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "files", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "acceptEdits", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const calls: Array<{ sessionId: string; path: string; oldText: string; newText: string }> = [];
    const core = makeFakeCore({
      async editFile(request: { sessionId: string; path: string; oldText: string; newText: string }) { calls.push(request); return { matches: 1 }; },
    });
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

  it("defaults glob/grep path to the session root when omitted", async () => {
    const root = await tempRoot("owc-agent-glob-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "files", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "acceptEdits", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const calls: Array<{ sessionId: string; path: string; pattern: string }> = [];
    const core = makeFakeCore({
      async globFiles(request: { sessionId: string; path: string; pattern: string }) { calls.push(request); return { paths: ["a.ts"], truncated: false }; },
    });
    let turn = 0;
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "files",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          yield { type: "tool_call", id: "glob-1", name: "glob", input: { pattern: "**/*.ts" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "list files");

    // schema 不再要求 path；缺省按会话根（"."）下发 core
    const globSchema = requests[0]?.tools.find((tool) => tool.name === "glob");
    expect(globSchema?.inputSchema.required).toEqual(["pattern"]);
    expect(calls).toEqual([{ sessionId: session.id, path: ".", pattern: "**/*.ts" }]);
  });
});
