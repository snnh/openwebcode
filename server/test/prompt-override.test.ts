import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompts/prompt-builder.js";
import { PI_BASE_SYSTEM_PROMPT } from "../src/agent/prompts/pi-base.js";
import { loadPromptOverride, loadScopedPromptOverride, writeGlobalPromptOverride, writeProjectPromptOverride } from "../src/agent/prompts/prompt-overrides.js";
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

describe("四个配置面与项目级读写", () => {
  it("旧格式（仅 base/append 文件）不引入新面字段", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeFile(path.join(dataDir, "system-prompt.md"), "legacy base\n", "utf8");
    await writeFile(path.join(dataDir, "system-prompt-append.md"), "legacy append\n", "utf8");
    const override = await loadPromptOverride(dataDir, cwd);
    expect(override.baseOverride).toBe("legacy base");
    expect(override.customAppend).toBe("legacy append");
    expect(override.identityOverride).toBeUndefined();
    expect(override.subAgentAppend).toBeUndefined();
  });

  it("loads identity and subAgentAppend faces from global files", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeFile(path.join(dataDir, "system-prompt-identity.md"), "You are a careful reviewer.\n", "utf8");
    await writeFile(path.join(dataDir, "system-prompt-subagent.md"), "Sub-agents stay terse.\n", "utf8");
    const override = await loadPromptOverride(dataDir, cwd);
    expect(override.identityOverride).toBe("You are a careful reviewer.");
    expect(override.subAgentAppend).toBe("Sub-agents stay terse.");
  });

  it("逐面独立合并：项目级某面覆盖全局同面，其余面仍取全局", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeFile(path.join(dataDir, "system-prompt-identity.md"), "global identity\n", "utf8");
    await writeFile(path.join(dataDir, "system-prompt-subagent.md"), "global subagent\n", "utf8");
    await mkdir(path.join(cwd, ".owc"), { recursive: true });
    await writeFile(path.join(cwd, ".owc", "system-prompt-subagent.md"), "project subagent\n", "utf8");
    const override = await loadPromptOverride(dataDir, cwd);
    expect(override.identityOverride).toBe("global identity");
    expect(override.subAgentAppend).toBe("project subagent");
  });

  it("writeProjectPromptOverride 写入 <cwd>/.owc 并在置空时删除对应文件", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeProjectPromptOverride(cwd, { identityOverride: "project identity", subAgentAppend: "project subagent" });
    let override = await loadPromptOverride(dataDir, cwd);
    expect(override.identityOverride).toBe("project identity");
    expect(override.subAgentAppend).toBe("project subagent");
    // 全局不受影响
    expect((await loadScopedPromptOverride(dataDir)).identityOverride).toBeUndefined();

    await writeProjectPromptOverride(cwd, {});
    override = await loadPromptOverride(dataDir, cwd);
    expect(override.identityOverride).toBeUndefined();
    expect(override.subAgentAppend).toBeUndefined();
  });

  it("loadScopedPromptOverride 只读单级目录，不做两级合并", async () => {
    const dataDir = await tempRoot("owc-prompt-");
    const cwd = await tempRoot("owc-prompt-");
    await writeFile(path.join(dataDir, "system-prompt.md"), "global base\n", "utf8");
    await mkdir(path.join(cwd, ".owc"), { recursive: true });
    await writeFile(path.join(cwd, ".owc", "system-prompt-append.md"), "project append\n", "utf8");
    const global = await loadScopedPromptOverride(dataDir);
    expect(global.baseOverride).toBe("global base");
    expect(global.customAppend).toBeUndefined();
    const project = await loadScopedPromptOverride(path.join(cwd, ".owc"));
    expect(project.customAppend).toBe("project append");
    expect(project.baseOverride).toBeUndefined();
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
