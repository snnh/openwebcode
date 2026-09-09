import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { normalizeBuiltinToolInput } from "../src/agent/tool-alias.js";
import type { ExecRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { toolResultOf } from "./helpers/agent-harness.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("normalizeBuiltinToolInput", () => {
  it("rewrites well-known alias keys when the canonical key is absent", () => {
    expect(normalizeBuiltinToolInput("bash", { command: "ls" })).toEqual({ cmd: "ls" });
    expect(normalizeBuiltinToolInput("read_file", { file_path: "a.ts" })).toEqual({ path: "a.ts" });
    expect(normalizeBuiltinToolInput("edit_file", { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true }))
      .toEqual({ path: "a.ts", oldText: "a", newText: "b", replaceAll: true });
    expect(normalizeBuiltinToolInput("task_output", { task_id: "task-1", block: true })).toEqual({ taskId: "task-1", block: true });
  });

  it("keeps an explicitly provided canonical key and drops the alias", () => {
    expect(normalizeBuiltinToolInput("bash", { cmd: "ls", command: "pwd" })).toEqual({ cmd: "ls" });
  });

  it("passes input through unchanged (same reference) when nothing matches", () => {
    const input = { cmd: "ls" };
    expect(normalizeBuiltinToolInput("bash", input)).toBe(input);
    expect(normalizeBuiltinToolInput("read_file", { path: "a.ts", offset: 1 })).toEqual({ path: "a.ts", offset: 1 });
  });

  it("leaves tools without an alias table untouched (same reference)", () => {
    const input = { pattern: "*.ts" };
    expect(normalizeBuiltinToolInput("glob", input)).toBe(input);
  });

  it("does not mutate the original input when rewriting", () => {
    const input = { command: "ls" };
    normalizeBuiltinToolInput("bash", input);
    expect(input).toEqual({ command: "ls" });
  });
});

/** 首轮发起一次指定工具调用，次轮结束 turn。 */
function makeAliasStubProvider(toolName: string, input: Record<string, unknown>): Provider {
  let turn = 0;
  return {
    name: "alias-stub",
    async *streamChat() {
      if (turn++ === 0) {
        yield { type: "tool_call", id: "call-1", name: toolName, input };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

async function setupAliasRun(toolName: string, input: Record<string, unknown>, core: ReturnType<typeof makeFakeCore>) {
  const root = await tempRoot("owc-tool-alias-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "alias-stub", model: "claude-opus-4-8" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(makeAliasStubProvider(toolName, input));
  const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);
  return { sessions, session, runner };
}

describe("内置工具异名参数容错（主循环）", () => {
  it("bash 的 command 归一为 cmd 并下发 core 执行", async () => {
    const runCalls: ExecRequest[] = [];
    const core = makeFakeCore({
      async run(request: ExecRequest) {
        runCalls.push(request);
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false };
      },
    });
    const { sessions, session, runner } = await setupAliasRun("bash", { command: "echo hi" }, core);

    await runner.run(session.id, "run it");

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.cmd).toContain("echo hi");
    const result = toolResultOf(await sessions.get(session.id), "call-1");
    expect(result?.isError).toBe(false);
  });

  it("bash 缺 cmd 时返回可诊断错误（点名缺失参数与实收键），不再报 Unsupported", async () => {
    const runCalls: ExecRequest[] = [];
    const core = makeFakeCore({
      async run(request: ExecRequest) {
        runCalls.push(request);
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false };
      },
    });
    const { sessions, session, runner } = await setupAliasRun("bash", { cmdline: "echo hi" }, core);

    await runner.run(session.id, "run it");

    expect(runCalls).toHaveLength(0);
    const result = toolResultOf(await sessions.get(session.id), "call-1");
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("Invalid arguments for bash");
    expect(result?.content).toContain('"cmd"');
    expect(result?.content).toContain("cmdline");
    expect(result?.content).not.toContain("Unsupported or invalid tool call");
  });

  it("bash 空参数时列出 Received keys: (none)", async () => {
    const core = makeFakeCore();
    const root = await tempRoot("owc-tool-alias-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "alias-stub", model: "claude-opus-4-8" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(makeAliasStubProvider("bash", {}));
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing);

    await runner.run(session.id, "run it");

    const result = toolResultOf(await sessions.get(session.id), "call-1");
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("Invalid arguments for bash");
    expect(result?.content).toContain("Received keys: (none)");
  });

  it("edit_file 的 file_path/old_string/new_string 归一为规范参数名", async () => {
    const editCalls: Array<{ path: string; oldText: string; newText: string }> = [];
    const core = makeFakeCore({
      async editFile(request: { sessionId: string; path: string; oldText: string; newText: string }) {
        editCalls.push(request);
        return { matches: 1 };
      },
    });
    const { sessions, session, runner } = await setupAliasRun(
      "edit_file",
      { file_path: "src/a.ts", old_string: "a", new_string: "b" },
      core,
    );

    await runner.run(session.id, "edit it");

    expect(editCalls).toEqual([{ sessionId: session.id, path: "src/a.ts", oldText: "a", newText: "b" }]);
    const result = toolResultOf(await sessions.get(session.id), "call-1");
    expect(result?.isError).toBe(false);
  });
});
