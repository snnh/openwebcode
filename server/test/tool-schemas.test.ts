import { describe, expect, it } from "vitest";
import { applyToolShaping } from "../src/agent/tool-schemas.js";
import type { ActiveToolShaping } from "../src/extensions/extension-manager.js";
import type { ProviderTool } from "../src/providers/provider.js";
import { BUILTIN_PERSONAS } from "../src/extensions/env-sim/builtin-personas.js";

const tool = (name: string): ProviderTool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
});

interface AliasSpec {
  from: string;
  as: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  argMap?: Record<string, string>;
}

const shapingOf = (hideBuiltIns: string[] = [], aliases: AliasSpec[] = []): ActiveToolShaping => ({
  hideBuiltIns: new Set(hideBuiltIns),
  aliases: new Map(aliases.map((alias) => [alias.as, alias])),
});

describe("applyToolShaping", () => {
  it("renames a built-in in place, overriding description/schema and recording dispatch mappings", () => {
    const result = applyToolShaping(
      [tool("bash"), tool("read_file")],
      shapingOf([], [
        {
          from: "bash", as: "Bash",
          description: "Runs a command.",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
          argMap: { command: "cmd" },
        },
      ]),
    );
    expect(result.tools.map((t) => t.name)).toEqual(["Bash", "read_file"]);
    expect(result.tools[0]!.description).toBe("Runs a command.");
    expect(result.tools[0]!.inputSchema).toEqual({ type: "object", properties: { command: { type: "string" } } });
    expect(result.aliasMap.get("Bash")).toBe("bash");
    expect(result.aliasArgMaps.get("Bash")).toEqual({ command: "cmd" });
  });

  it("keeps the built-in description/schema when the alias does not override them", () => {
    const result = applyToolShaping([tool("cron_list")], shapingOf([], [{ from: "cron_list", as: "CronList" }]));
    expect(result.tools[0]).toMatchObject({ name: "CronList", description: "cron_list description" });
    expect(result.aliasArgMaps.has("CronList")).toBe(false);
  });

  it("exposes multiple aliases of the same built-in: first renames in place, rest are cloned and appended", () => {
    const result = applyToolShaping(
      [tool("spawn_task"), tool("bash")],
      shapingOf([], [
        { from: "spawn_task", as: "Agent" },
        { from: "spawn_task", as: "Task" },
      ]),
    );
    // 首个别名占据 spawn_task 原位；第二个克隆追加到末尾；原始名不再出现。
    expect(result.tools.map((t) => t.name)).toEqual(["Agent", "bash", "Task"]);
    expect(result.aliasMap.get("Agent")).toBe("spawn_task");
    expect(result.aliasMap.get("Task")).toBe("spawn_task");
  });

  it("hides built-ins and skips aliases whose from is hidden or unknown", () => {
    const result = applyToolShaping(
      [tool("grep"), tool("bash")],
      shapingOf(["grep"], [
        { from: "grep", as: "Grep" },
        { from: "nonexistent", as: "Nope" },
        { from: "bash", as: "Bash" },
      ]),
    );
    expect(result.tools.map((t) => t.name)).toEqual(["Bash"]);
    expect(result.aliasMap.has("Grep")).toBe(false);
    expect(result.aliasMap.has("Nope")).toBe(false);
  });

  it("every alias declared by a builtin persona survives application (zcode Agent/Task included)", () => {
    // 与 agent-runner builtInTools 对齐的内置工具名全集（persona 引用范围为子集）。
    const builtInNames = [
      "bash", "read_file", "write_file", "edit_file", "glob", "grep",
      "read_artifact", "repo_map", "code_search", "test_runner",
      "git_status", "git_diff", "git_commit",
      "git_worktree_create", "git_worktree_remove", "git_worktree_merge",
      "load_skill", "spawn_task", "spawn_swarm", "todo_write", "remember",
      "ask_user", "web_fetch", "task_output", "task_stop", "web_search",
      "cron_create", "cron_list", "cron_delete",
    ];
    for (const persona of BUILTIN_PERSONAS) {
      const result = applyToolShaping(
        builtInNames.map(tool),
        shapingOf([...(persona.hideBuiltIns ?? [])], [...(persona.aliases ?? [])]),
      );
      const exposed = new Set(result.tools.map((t) => t.name));
      for (const alias of persona.aliases ?? []) {
        expect(exposed.has(alias.as), `${persona.id}: alias "${alias.as}" (from ${alias.from}) must be exposed`).toBe(true);
        expect(result.aliasMap.get(alias.as), `${persona.id}: alias "${alias.as}" must dispatch to ${alias.from}`).toBe(alias.from);
      }
      for (const hidden of persona.hideBuiltIns ?? []) {
        expect(exposed.has(hidden), `${persona.id}: hidden tool "${hidden}" must not be exposed`).toBe(false);
      }
    }
  });
});
