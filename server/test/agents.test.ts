import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry, parseAgentMarkdown } from "../src/agents.js";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-agents-"));
  roots.push(root);
  return root;
}

async function writeAgent(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), text, "utf8");
}

const core = {
  on() { return core; },
  async configureSession() { return { sandboxCapability: "advisory" }; },
} as unknown as CoreClientLike;

describe("AgentRegistry", () => {
  it("parses arrays, comma-separated tools and omitted optional fields", () => {
    expect(parseAgentMarkdown("---\ndescription: review\ntools: [read_file, grep]\nmodel: model-x\n---\nBody", "reviewer", "global"))
      .toMatchObject({ name: "reviewer", description: "review", tools: ["read_file", "grep"], model: "model-x", body: "Body" });
    expect(parseAgentMarkdown("---\nname: scout\ndescription: scan\ntools: glob, grep\n---\nPrompt", "file", "project"))
      .toMatchObject({ name: "scout", tools: ["glob", "grep"], source: "project" });
    expect(parseAgentMarkdown("---\ndescription: list\ntools:\n  - read_file\n  - glob\n---\nPrompt", "list", "global"))
      .toMatchObject({ tools: ["read_file", "glob"] });
    expect(parseAgentMarkdown("---\ndescription: plain\n---\nPrompt", "plain", "global"))
      .toEqual({ name: "plain", description: "plain", body: "Prompt", source: "global" });
  });

  it("lets project definitions override global definitions and skips malformed files", async () => {
    const root = await tempRoot();
    const globalDir = path.join(root, "global");
    const projectDir = path.join(root, "workspace", ".owc", "agents");
    await writeAgent(globalDir, "reviewer", "---\ndescription: global\n---\nGlobal body");
    await writeAgent(globalDir, "bad", "---\ndescription: missing close\nBad body");
    await writeAgent(projectDir, "reviewer", "---\ndescription: project\n---\nProject body");

    const agents = await new AgentRegistry(globalDir).listFor(path.join(root, "workspace"));
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "reviewer", description: "project", body: "Project body", source: "project" });
  });
});

describe("custom spawn_task agents", () => {
  it("injects the catalog and applies body, model, tool allowlist and transcript agent", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    const globalDir = path.join(root, "agents");
    await mkdir(workspace, { recursive: true });
    await writeAgent(globalDir, "reviewer", "---\ndescription: Reviews code\ntools: [read_file, bash, grep]\nmodel: reviewer-model\n---\nREVIEWER BODY");
    const registry = new AgentRegistry(globalDir);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: workspace, provider: "fake", model: "main-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    let mainTurns = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (request.system.includes("REVIEWER BODY")) {
          yield { type: "text_delta", text: "review complete" };
          yield { type: "done", stopReason: "end_turn" };
        } else if (mainTurns++ === 0) {
          yield { type: "tool_call", id: "spawn-custom", name: "spawn_task", input: { prompt: "review", agent: "reviewer" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, registry);
    await runner.run(session.id, "review this");

    expect(requests[0]?.system).toContain("Available sub-agents");
    expect(requests[0]?.system).toContain("- reviewer: Reviews code");
    expect(requests[0]?.system).toContain("unsupported tools ignored: bash");
    const sub = requests.find((request) => request.system.includes("REVIEWER BODY"));
    expect(sub?.model).toBe("reviewer-model");
    expect(sub?.tools.map((tool) => tool.name).sort()).toEqual(["grep", "read_file"]);
    const files = await readdir(path.join(sessions.contextRoot(session.id), "subagents"));
    const transcript = JSON.parse(await readFile(path.join(sessions.contextRoot(session.id), "subagents", files[0]!), "utf8")) as { agent?: string };
    expect(transcript.agent).toBe("reviewer");
  });

  it("omits the catalog section when no agents are configured", async () => {
    const root = await tempRoot();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "main-model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let system = "";
    const providers = new ProviderRegistry();
    providers.register({
      name: "fake",
      async *streamChat(request) {
        system = request.system;
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    });
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, new AgentRegistry(path.join(root, "missing")));
    await runner.run(session.id, "hello");
    expect(system).not.toContain("Available sub-agents");
  });
});
