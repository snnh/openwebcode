import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { parseSkillCommand, parseSkillMarkdown, SkillRegistry } from "../src/skills.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function writeSkill(dir: string, name: string, markdown: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), markdown, "utf8");
}

describe("skill markdown parsing", () => {
  it("parses frontmatter and body, falling back to the directory name", () => {
    const parsed = parseSkillMarkdown("---\nname: greet\ndescription: 问候技能\n---\n# 正文\n步骤一\n", "dir-name", "global", "/x/SKILL.md");
    expect(parsed).toMatchObject({ name: "greet", description: "问候技能", body: "# 正文\n步骤一", source: "global" });

    const noMeta = parseSkillMarkdown("# 只有正文\n", "dir-name", "project", "/x/SKILL.md");
    expect(noMeta).toMatchObject({ name: "dir-name", description: "", body: "# 只有正文" });

    expect(parseSkillMarkdown("---\nname: x\n---\n   \n", "d", "global", "/x")).toBeUndefined();
  });

  it("parses /skill composer commands", () => {
    expect(parseSkillCommand("/greet 你好")).toEqual({ name: "greet", rest: "你好" });
    expect(parseSkillCommand("/greet")).toEqual({ name: "greet", rest: "" });
    expect(parseSkillCommand("hello /greet")).toBeUndefined();
    expect(parseSkillCommand("/")).toBeUndefined();
  });
});

describe("SkillRegistry", () => {
  it("merges global and project skills, project wins on name collision", async () => {
    const root = await tempRoot("owc-skills-");
    const globalDir = path.join(root, "global-skills");
    const cwd = path.join(root, "work");
    await writeSkill(globalDir, "alpha", "---\ndescription: 全局 alpha\n---\nalpha body\n");
    await writeSkill(globalDir, "shared", "---\ndescription: 全局 shared\n---\nglobal body\n");
    await writeSkill(path.join(cwd, ".owc", "skills"), "shared", "---\ndescription: 项目 shared\n---\nproject body\n");

    const registry = new SkillRegistry(globalDir);
    const skills = await registry.listFor(cwd);
    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "shared"]);
    expect(skills.find((skill) => skill.name === "shared")).toMatchObject({ description: "项目 shared", source: "project" });
    expect(await registry.find(cwd, "missing")).toBeUndefined();
    expect((await registry.listFor(undefined)).map((skill) => skill.name)).toEqual(["alpha", "shared"]);
  });

  it("invalidates a cached scan when a skill file changes", async () => {
    const root = await tempRoot("owc-skills-");
    const globalDir = path.join(root, "global-skills");
    await writeSkill(globalDir, "alpha", "first");
    const registry = new SkillRegistry(globalDir);
    expect((await registry.listFor()).find((skill) => skill.name === "alpha")?.body).toBe("first");
    await writeSkill(globalDir, "alpha", "second value");
    expect((await registry.listFor()).find((skill) => skill.name === "alpha")?.body).toBe("second value");
  });
});

describe("skills in agent runs", () => {
  async function harness(cwd: string, registry: SkillRegistry) {
    const sessions = new SessionStore(path.join(cwd, "store", "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(cwd, "store", "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "anthropic",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1 && request.tools?.some((tool) => tool.name === "load_skill")) {
          yield { type: "tool_call", id: "call-1", name: "load_skill", input: { name: "greet" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined, registry);
    return { sessions, requests, runner };
  }

  it("injects the skill catalog into the system prompt and serves load_skill", async () => {
    const root = await tempRoot("owc-skills-");
    const cwd = path.join(root, "work");
    const registry = new SkillRegistry(path.join(root, "global-skills"));
    await writeSkill(path.join(cwd, ".owc", "skills"), "greet", "---\ndescription: 问候技能\n---\n用中文问候用户。\n");
    const { sessions, requests, runner } = await harness(root, registry);
    const session = await sessions.create({ cwd, provider: "anthropic", model: "claude-haiku-4-5" });

    await runner.run(session.id, "打个招呼");

    expect(requests[0]!.system).toContain("- greet: 问候技能");
    expect(requests[0]!.system).toContain("load_skill");
    const stored = await sessions.get(session.id);
    const toolMessage = stored?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content[0]).toMatchObject({ type: "tool_result", content: expect.stringContaining("用中文问候用户") });
  });

  it("expands a /skill composer command into skill body plus user input", async () => {
    const root = await tempRoot("owc-skills-");
    const cwd = path.join(root, "work");
    const registry = new SkillRegistry(path.join(root, "global-skills"));
    await writeSkill(path.join(cwd, ".owc", "skills"), "greet", "用中文问候用户。\n");
    const { sessions, runner } = await harness(root, registry);
    const session = await sessions.create({ cwd, provider: "anthropic", model: "claude-haiku-4-5" });

    await runner.run(session.id, "/greet 对项目组");

    const stored = await sessions.get(session.id);
    const first = stored?.messages[0];
    expect(first?.role).toBe("user");
    expect(first?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('[Skill "greet" — full text]\n用中文问候用户。\n\n[User request]\n对项目组'),
    });

    await runner.run(session.id, "/unknown-skill");
    const after = await sessions.get(session.id);
    const lastUser = [...(after?.messages ?? [])].reverse().find((message) => message.role === "user");
    expect(lastUser?.content[0]).toMatchObject({ type: "text", text: "/unknown-skill" });
  });
});

describe("skills HTTP routes", () => {
  it("lists global skills and session-scoped skills", async () => {
    const root = await tempRoot("owc-skills-");
    const globalDir = path.join(root, "global-skills");
    const cwd = path.join(root, "work");
    await writeSkill(globalDir, "alpha", "---\ndescription: 全局 alpha\n---\nalpha body\n");
    await writeSkill(path.join(cwd, ".owc", "skills"), "beta", "---\ndescription: 项目 beta\n---\nbeta body\n");

    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const core = { on() { return core; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, skills: new SkillRegistry(globalDir) });
    try {
      const session = await sessions.create({ cwd, title: "技能样例" });
      const globalList = await app.inject({ method: "GET", url: "/api/skills" });
      expect(globalList.statusCode).toBe(200);
      expect(globalList.json<{ skills: Array<{ name: string; source: string }> }>().skills).toEqual([
        { name: "alpha", description: "全局 alpha", source: "global", path: path.join(globalDir, "alpha", "SKILL.md") },
      ]);

      const sessionList = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/skills` });
      expect(sessionList.json<{ skills: Array<{ name: string }> }>().skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);

      const missing = await app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/skills" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
