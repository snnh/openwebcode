/** Agent 预设：数据目录迁移与旧路径兼容链接、预设 CRUD/工具名校验、精简模式的提示词与工具形态、会话级覆盖。 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, getPreset, listPresets, resolvePreset } from "../src/extensions/agent-presets/index.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { applyToolShaping } from "../src/agent/tool-schemas.js";
import { buildSystemPrompt } from "../src/agent/prompts/prompt-builder.js";
import { buildServer } from "../src/app.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function root(): Promise<string> {
  return tempRoot("owc-agent-presets-");
}

describe("Agent 预设：数据目录迁移与旧路径兼容", () => {
  it("env-sim/personas 迁到 agent-presets/presets，旧路径留符号链接；旧配置键 persona 迁移为 preset", async () => {
    const dataDir = await root();
    await mkdir(path.join(dataDir, "env-sim", "personas"), { recursive: true });
    await writeFile(path.join(dataDir, "env-sim", "personas", "shared.json"), JSON.stringify({
      id: "shared", name: "Shared", identity: "You are shared.", basePrompt: "Shared baseline.",
    }));
    await mkdir(path.join(dataDir, "extensions"), { recursive: true });
    await writeFile(path.join(dataDir, "extensions", "extensions.json"), JSON.stringify({
      version: 1,
      extensions: {
        "env-sim": { enabled: true, config: { persona: "shared" } },
        // 其余默认启用的扩展需要扩展宿主；只留 agent-presets 验证 hostless
        "context-saver": { enabled: false },
        "attention-optimizer": { enabled: false },
        "pdf-to-image": { enabled: false },
      },
    }));

    const presets = await listPresets(dataDir);
    expect(presets.map((preset) => preset.id)).toEqual(expect.arrayContaining(["minimal", "shared"]));
    expect(await readFile(path.join(dataDir, "agent-presets", "presets", "shared.json"), "utf8")).toContain("Shared baseline");
    // 旧路径保留目录链接，短期兼容外部脚本与分享路径
    expect((await stat(path.join(dataDir, "env-sim"))).isDirectory()).toBe(true);
    expect((await stat(path.join(dataDir, "env-sim", "personas", "shared.json"))).isFile()).toBe(true);

    const manager = new ExtensionManager(dataDir);
    await manager.initialize();
    try {
      const extension = manager.list().find((item) => item.id === "agent-presets");
      expect(extension).toMatchObject({ enabled: true, status: "running", config: { preset: "shared" } });
      // 旧键必须清掉：configSchema 是 additionalProperties:false，留着会让配置表单回存被 400 拒绝
      expect(extension?.config).not.toHaveProperty("persona");
      // 默认启用但 server 侧执行：不拉起扩展宿主
      expect(await manager.hostMemory()).toBeNull();
    } finally {
      await manager.close();
    }
  });
});

describe("Agent 预设：精简模式", () => {
  it("内置 minimal 走白名单与精简提示词；未知名与 classic 不启用任何形态", async () => {
    const dataDir = await root();
    const minimal = BUILTIN_PRESETS.find((preset) => preset.id === "minimal");
    expect(minimal).toMatchObject({ promptStyle: "minimal", projectContext: "paths", externalTools: false });
    expect(minimal?.allowedBuiltIns).toEqual(expect.arrayContaining(["bash", "read_file", "edit_file"]));
    expect(minimal?.allowedBuiltIns).not.toEqual(expect.arrayContaining(["write_file", "glob", "grep"]));

    await expect(listPresets(dataDir)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "minimal", name: "精简模式", category: "minimal", builtin: true }),
    ]));
    await expect(resolvePreset(dataDir, { preset: "minimal" })).resolves.toMatchObject({ id: "minimal" });
    // 会话级 classic 覆盖全局预设
    await expect(resolvePreset(dataDir, { preset: "minimal" }, () => undefined, "classic")).resolves.toBeNull();
    await expect(resolvePreset(dataDir, { preset: "nope" })).resolves.toBeNull();
  });

  it("工具形态按白名单裁剪并关闭扩展/MCP 工具；精简提示词不渲染经典框架", () => {
    const tools = [
      { name: "bash", description: "Run a command.", inputSchema: { type: "object" } },
      { name: "read_file", description: "Read a file.", inputSchema: { type: "object" } },
      { name: "write_file", description: "Write a file.", inputSchema: { type: "object" } },
      { name: "glob", description: "List files.", inputSchema: { type: "object" } },
    ];
    const shaped = applyToolShaping(tools, {
      allowedBuiltIns: new Set(["bash", "read_file"]),
      hideBuiltIns: new Set(),
      toolDescriptions: new Map([["bash", "Execute a shell command."]]),
      aliases: new Map(),
      externalTools: false,
    });
    expect(shaped.tools.map((tool) => tool.name)).toEqual(["bash", "read_file"]);
    expect(shaped.tools[0]?.description).toBe("Execute a shell command.");

    const prompt = buildSystemPrompt({
      cwd: "/work/demo",
      tools: shaped.tools,
      minimal: true,
      identity: "You are a coding assistant.",
      basePromptOverride: "You are an expert coding assistant.",
      finalConstraints: ["## Safety boundary\n- Stay within the workspace."],
    });
    expect(prompt.startsWith("You are a coding assistant.")).toBe(true);
    expect(prompt).toContain("Work discipline");
    // 安全边界由核心追加：精简形态也带，预设不可移除
    expect(prompt).toContain("## Safety boundary");
    expect(prompt).toContain("Current working directory: /work/demo");
    // 精简形态：经典框架的段落与版本尾注都不出现
    expect(prompt).not.toContain("## Work discipline");
    expect(prompt).not.toContain("Prompt version:");
    // 预设的额外段落（productSections / 技能目录）在精简形态仍然生效
    const withSections = buildSystemPrompt({
      cwd: "/work/demo",
      tools: shaped.tools,
      minimal: true,
      productSections: ["## Extra guidance\n- Keep it."],
      skillsSection: "Available skills:\n- demo: Demo skill",
    });
    expect(withSections).toContain("## Extra guidance");
    expect(withSections).toContain("Available skills");
  });
});

describe("Agent 预设 REST", () => {
  it("清单/详情/保存/删除与工具目录；非法工具名 400；会话级 preset 校验与生效标识", async () => {
    const dataDir = await root();
    const sessions = new SessionStore(path.join(dataDir, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(dataDir, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register({ name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
    const extensions = new ExtensionManager(dataDir);
    await extensions.initialize();
    const app = await buildServer({
      core: {} as CoreClient,
      sessions,
      agent: { isRunning: () => false } as unknown as AgentRunner,
      events: new EventBus(),
      providers,
      pricing,
      extensions,
    });
    try {
      const list = await app.inject({ method: "GET", url: "/api/extensions/agent-presets/presets" });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ directory: path.join(dataDir, "agent-presets", "presets"), enabled: true });
      const detail = await app.inject({ method: "GET", url: "/api/extensions/agent-presets/presets/minimal" });
      expect(detail.json()).toMatchObject({ id: "minimal", builtin: true, promptStyle: "minimal" });
      const tools = await app.inject({ method: "GET", url: "/api/extensions/agent-presets/tools" });
      expect(tools.json().tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["bash", "edit_file"]));

      const saved = await app.inject({ method: "POST", url: "/api/extensions/agent-presets/presets", payload: {
        id: "mine", name: "Mine", identity: "You are mine.", basePrompt: "Baseline.", promptStyle: "minimal", allowedBuiltIns: ["bash", "read_file"],
      } });
      expect(saved.statusCode).toBe(201);
      expect(saved.json()).toMatchObject({ id: "mine", category: "custom", builtin: false });
      expect(await getPreset(dataDir, "mine")).toMatchObject({ allowedBuiltIns: ["bash", "read_file"] });
      const bad = await app.inject({ method: "POST", url: "/api/extensions/agent-presets/presets", payload: {
        id: "bad", name: "Bad", identity: "x", basePrompt: "y", allowedBuiltIns: ["not_a_tool"],
      } });
      expect(bad.statusCode).toBe(400);
      const noBash = await app.inject({ method: "POST", url: "/api/extensions/agent-presets/presets", payload: {
        id: "nobash", name: "No bash", identity: "x", basePrompt: "y", promptStyle: "minimal", allowedBuiltIns: ["read_file"],
      } });
      expect(noBash.statusCode).toBe(400);
      expect((await app.inject({ method: "DELETE", url: "/api/extensions/agent-presets/presets/mine" })).statusCode).toBe(200);

      const session = await sessions.create({ cwd: dataDir, provider: "anthropic", model: "m" });
      const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload });
      expect((await put({ preset: "minimal" })).statusCode).toBe(200);
      expect(await sessions.getMeta(session.id)).toMatchObject({ preset: "minimal" });
      expect((await put({ preset: "nope" })).statusCode).toBe(400);
      expect((await put({ preset: "classic" })).statusCode).toBe(200);
      expect(await sessions.getMeta(session.id)).toMatchObject({ preset: "classic" });
      const detailResponse = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      expect(detailResponse.json()).toMatchObject({ preset: "classic", activePreset: null });
      await put({ preset: "minimal" });
      const active = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      expect(active.json()).toMatchObject({ activePreset: { id: "minimal", name: "精简模式", category: "minimal" } });
      // 会话头走 limit 分页分支，同样要带生效预设
      const tail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}?limit=10` });
      expect(tail.json()).toMatchObject({ activePreset: { id: "minimal" } });
      // 清空回到跟随全局默认
      await put({ preset: "" });
      expect(await sessions.getMeta(session.id)).not.toHaveProperty("preset");
    } finally {
      await app.close();
      await extensions.close();
    }
  });
});