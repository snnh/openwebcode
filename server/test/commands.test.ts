import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { CommandRegistry, renderCommand } from "../src/commands.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { SkillRegistry } from "../src/skills.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function writeDefinition(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), text, "utf8");
}

const core = {
  on() { return core; },
  async configureSession() { return { sandboxCapability: "advisory" }; },
} as unknown as CoreClientLike;

describe("renderCommand", () => {
  it("renders whole and positional arguments", () => {
    expect(renderCommand("all=$ARGUMENTS first=$1 third=$3 ninth=$9", "src/ test extra"))
      .toBe("all=src/ test extra first=src/ third=extra ninth=");
  });

  it("does not reinterpret placeholders contained in user arguments", () => {
    expect(renderCommand("all=$ARGUMENTS first=$1", "$2 literal")).toBe("all=$2 literal first=$2");
  });

  it("renders missing arguments as empty and ignores extra arguments", () => {
    expect(renderCommand("$1/$2", "one two three four")).toBe("one/two");
    expect(renderCommand("[$1][$2][$ARGUMENTS]", "")).toBe("[][][]");
  });
});

describe("CommandRegistry", () => {
  it("parses definitions and lets project commands override global commands", async () => {
    const root = await tempRoot("owc-commands-");
    const globalDir = path.join(root, "global");
    const workspace = path.join(root, "workspace");
    await writeDefinition(globalDir, "review", "---\ndescription: global\n---\nGlobal $ARGUMENTS");
    await writeDefinition(path.join(workspace, ".owc", "commands"), "review", "---\ndescription: project\n---\nProject $1");
    await writeDefinition(globalDir, "plain", "Plain command");
    const commands = await new CommandRegistry(globalDir).listFor(workspace);
    expect(commands).toEqual([
      { name: "plain", body: "Plain command", source: "global" },
      { name: "review", description: "project", body: "Project $1", source: "project" },
    ]);
  });
});

describe("custom slash commands", () => {
  async function runWithDefinitions(options: { command?: string; skill?: string; text: string }): Promise<string> {
    const root = await tempRoot("owc-commands-");
    const workspace = path.join(root, "workspace");
    const commandDir = path.join(root, "commands");
    const skillDir = path.join(root, "skills");
    await mkdir(workspace, { recursive: true });
    if (options.command) await writeDefinition(commandDir, "review", options.command);
    if (options.skill) {
      await mkdir(path.join(skillDir, "review"), { recursive: true });
      await writeFile(path.join(skillDir, "review", "SKILL.md"), options.skill, "utf8");
    }
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: workspace, provider: "fake", model: "model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    let userText = "";
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        const user = request.messages.findLast((message) => message.role === "user");
        const block = user?.content.find((item) => item.type === "text");
        userText = block?.type === "text" ? block.text : "";
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(
      sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined,
      new SkillRegistry(skillDir), undefined, undefined, undefined, undefined, new CommandRegistry(commandDir),
    );
    await runner.run(session.id, options.text);
    return userText;
  }

  it("renders a custom command before sending it to the provider", async () => {
    expect(await runWithDefinitions({ command: "Review target=$1 all=$ARGUMENTS", text: "/review src/ deep" }))
      .toBe("Review target=src/ all=src/ deep");
  });

  it("gives custom commands precedence over same-named skills", async () => {
    expect(await runWithDefinitions({ command: "COMMAND $1", skill: "---\ndescription: skill\n---\nSKILL BODY", text: "/review src/" }))
      .toBe("COMMAND src/");
  });

  it("keeps unknown slash commands unchanged", async () => {
    expect(await runWithDefinitions({ text: "/unknown src/" })).toBe("/unknown src/");
  });
});
