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
  // 已知别名键表；末例覆盖「规范键已存在时丢弃别名」
  const ALIAS_CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["bash", { command: "ls" }, { cmd: "ls" }],
    ["read_file", { file_path: "a.ts" }, { path: "a.ts" }],
    ["edit_file", { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true }, { path: "a.ts", oldText: "a", newText: "b", replaceAll: true }],
    ["task_output", { task_id: "task-1", block: true }, { taskId: "task-1", block: true }],
    ["bash", { cmd: "ls", command: "pwd" }, { cmd: "ls" }],
  ];
  it("重写已知别名键；无匹配 / 无别名表时原样返回同一引用且不改动入参", () => {
    for (const [tool, input, expected] of ALIAS_CASES) {
      expect(normalizeBuiltinToolInput(tool, input), `${tool} ${JSON.stringify(input)}`).toEqual(expected);
    }
    const passthrough = { cmd: "ls" };
    expect(normalizeBuiltinToolInput("bash", passthrough)).toBe(passthrough);
    expect(normalizeBuiltinToolInput("read_file", { path: "a.ts", offset: 1 })).toEqual({ path: "a.ts", offset: 1 });
    const noAlias = { pattern: "*.ts" };
    expect(normalizeBuiltinToolInput("glob", noAlias)).toBe(noAlias);
    const original = { command: "ls" };
    normalizeBuiltinToolInput("bash", original);
    expect(original).toEqual({ command: "ls" });
  });
});

const OK_EXEC = { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false };

/** 首轮发起一次指定工具调用，次轮结束 turn；yolo 跳过权限确认。 */
async function setupAliasRun(toolName: string, input: Record<string, unknown>, core: ReturnType<typeof makeFakeCore>) {
  let turn = 0;
  const provider: Provider = {
    name: "alias-stub",
    async *streamChat() {
      if (turn++ === 0) {
        yield { type: "tool_call", id: "call-1", name: toolName, input };
        yield { type: "done", stopReason: "tool_use" };
        return;
      }
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  const root = await tempRoot("owc-tool-alias-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "alias-stub", model: "claude-opus-4-8" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const providers = new ProviderRegistry();
  providers.register(provider);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  await new AgentRunner(sessions, providers, core, new EventBus(), pricing).run(session.id, "run it");
  return { session, result: toolResultOf(await sessions.get(session.id), "call-1") };
}

describe("内置工具异名参数容错（主循环）", () => {
  it("bash/edit_file 异名键归一后下发 core；参数缺失时返回可诊断错误", async () => {
    const runCalls: ExecRequest[] = [];
    const bash = await setupAliasRun("bash", { command: "echo hi" }, makeFakeCore({
      async run(request: ExecRequest) { runCalls.push(request); return OK_EXEC; },
    }));
    expect(runCalls[0]?.cmd).toContain("echo hi");
    expect(bash.result?.isError).toBe(false);
    const editCalls: Array<{ sessionId: string; path: string; oldText: string; newText: string }> = [];
    const edit = await setupAliasRun("edit_file", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, makeFakeCore({
      async editFile(request: { sessionId: string; path: string; oldText: string; newText: string }) { editCalls.push(request); return { matches: 1 }; },
    }));
    expect(editCalls).toEqual([{ sessionId: edit.session.id, path: "src/a.ts", oldText: "a", newText: "b" }]);
    expect(edit.result?.isError).toBe(false);
    // 缺 cmd：不再报笼统的 Unsupported，而是点名缺失参数与实收键
    for (const [input, receivedKeys] of [[{ cmdline: "echo hi" }, "cmdline"], [{}, "Received keys: (none)"]] as const) {
      const calls: ExecRequest[] = [];
      const { result } = await setupAliasRun("bash", input, makeFakeCore({
        async run(request: ExecRequest) { calls.push(request); return OK_EXEC; },
      }));
      expect(calls, JSON.stringify(input)).toHaveLength(0);
      expect(result?.isError).toBe(true);
      expect(result?.content).toContain("Invalid arguments for bash");
      expect(result?.content).toContain('"cmd"');
      expect(result?.content).toContain(receivedKeys);
      expect(result?.content).not.toContain("Unsupported or invalid tool call");
    }
  });
});
