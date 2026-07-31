import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompts/prompt-builder.js";
import { PI_BASE_SYSTEM_PROMPT } from "../src/agent/prompts/pi-base.js";
import { loadPromptOverride, writeGlobalPromptOverride } from "../src/agent/prompts/prompt-overrides.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("loadPromptOverride", () => {
  it("returns empty when no override files exist", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    const override = await loadPromptOverride(dataDir, cwd);
    expect(override.baseOverride).toBeUndefined();
    expect(override.customAppend).toBeUndefined();
  });

  it("loads the global base override and append", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeFile(path.join(dataDir, "system-prompt.md"), "custom base body\n", "utf8");
    await writeFile(path.join(dataDir, "system-prompt-append.md"), "always be terse\n", "utf8");
    const override = await loadPromptOverride(dataDir, cwd);
    expect(override.baseOverride).toBe("custom base body");
    expect(override.customAppend).toBe("always be terse");
  });

  it("project-level files override global ones", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeFile(path.join(dataDir, "system-prompt.md"), "global base\n", "utf8");
    await mkdir(path.join(cwd, ".owc"), { recursive: true });
    await writeFile(path.join(cwd, ".owc", "system-prompt.md"), "project base\n", "utf8");
    const override = await loadPromptOverride(dataDir, cwd);
    expect(override.baseOverride).toBe("project base");
  });
});

describe("writeGlobalPromptOverride", () => {
  it("writes base and append files, and removes them when emptied", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeGlobalPromptOverride(dataDir, { baseOverride: "my base", customAppend: "my append" });
    let override = await loadPromptOverride(dataDir, cwd);
    expect(override.baseOverride).toBe("my base");
    expect(override.customAppend).toBe("my append");

    await writeGlobalPromptOverride(dataDir, { baseOverride: "", customAppend: "" });
    override = await loadPromptOverride(dataDir, cwd);
    expect(override.baseOverride).toBeUndefined();
    expect(override.customAppend).toBeUndefined();
  });
});

describe("buildSystemPrompt with overrides", () => {
  it("falls back to the built-in baseline without an override", () => {
    const system = buildSystemPrompt({ cwd: "/work", tools: [] });
    expect(system).toContain(PI_BASE_SYSTEM_PROMPT);
    expect(system).not.toContain("<custom_instructions>");
  });

  it("uses the base override and appends custom instructions after constraints", () => {
    const system = buildSystemPrompt({
      cwd: "/work",
      tools: [],
      basePromptOverride: "You are a pirate coder.",
      customAppend: "Reply in rhymes.",
      finalConstraints: ["Stay within the workspace."],
    });
    expect(system).toContain("You are a pirate coder.");
    expect(system).not.toContain(PI_BASE_SYSTEM_PROMPT);
    expect(system).toContain("<custom_instructions>");
    expect(system).toContain("Reply in rhymes.");
    // 自定义指令位于安全约束之后
    expect(system.indexOf("Stay within the workspace.")).toBeLessThan(system.indexOf("<custom_instructions>"));
  });
});
