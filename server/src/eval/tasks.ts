import type { EvalTask } from "./types.js";
import { usage } from "./mock-provider.js";

/**
 * Built-in evaluation task set. Each task pairs a workspace fixture with a
 * scripted mock-provider replay and declarative assertions.
 *
 * Tasks are designed to run without an API key: the script defines the
 * exact tool-call sequence the "model" produces, and assertions check the
 * resulting workspace and message state.
 */
export const EVAL_TASKS: EvalTask[] = [
  {
    id: "create-file",
    name: "创建文件",
    description: "Mock provider 调用 write_file 创建 src/hello.ts，断言文件存在且包含 console.log。",
    workspace: "create-file",
    instruction: "创建 src/hello.ts 文件，写入 console.log('hi')",
    assertions: {
      toolUsed: ["write_file"],
      fileExists: ["src/hello.ts"],
      fileContains: { "src/hello.ts": "console.log" },
      messageContains: "done",
      maxTurns: 5,
    },
    script: [
      [
        { type: "tool_call", id: "cf-1", name: "write_file", input: { path: "src/hello.ts", content: "console.log('hi')\n", createDirs: true } },
        usage(),
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        usage(),
        { type: "done", stopReason: "end_turn" },
      ],
    ],
  },
  {
    id: "use-grep",
    name: "使用 grep 搜索",
    description: "Mock provider 调用 grep 搜索 TODO，断言工具被调用。",
    workspace: "use-grep",
    instruction: "用 grep 工具搜索工作区中的 TODO 标记",
    assertions: {
      toolUsed: ["grep"],
      maxTurns: 5,
    },
    script: [
      [
        { type: "tool_call", id: "ug-1", name: "grep", input: { path: ".", pattern: "TODO" } },
        usage(),
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Found 1 TODO marker." },
        usage(),
        { type: "done", stopReason: "end_turn" },
      ],
    ],
  },
  {
    id: "multi-step",
    name: "多步文件操作",
    description: "Mock provider 先 write_file 创建文件，再 edit_file 编辑，断言多个工具调用且文件内容更新。",
    workspace: "multi-step",
    instruction: "创建 src/hello.ts 写入 hello，然后编辑为 hello world",
    assertions: {
      toolUsed: ["write_file", "edit_file"],
      fileExists: ["src/hello.ts"],
      fileContains: { "src/hello.ts": "hello world" },
      maxTurns: 5,
    },
    script: [
      [
        { type: "tool_call", id: "ms-1", name: "write_file", input: { path: "src/hello.ts", content: "hello\n", createDirs: true } },
        usage(),
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "ms-2", name: "edit_file", input: { path: "src/hello.ts", oldText: "hello", newText: "hello world" } },
        usage(),
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        usage(),
        { type: "done", stopReason: "end_turn" },
      ],
    ],
  },
  {
    id: "harness-0.4-regression",
    name: "0.4 Harness 回归",
    description: "覆盖符号索引、结构化诊断与 SCM 工具的 AgentRunner 分发和结果契约。",
    workspace: "use-grep",
    instruction: "定位 greet 符号，运行测试，然后检查 Git 状态和 diff。",
    features: ["index", "diagnostics", "scm"],
    permissionMode: "yolo",
    assertions: {
      toolUsed: ["code_search", "test_runner", "git_status", "git_diff"],
      toolOrder: ["code_search", "test_runner", "git_status", "git_diff"],
      toolResultContains: {
        code_search: "src/hello.ts:1",
        test_runner: "2 passed",
        git_status: "Branch: main",
        git_diff: "hello.ts",
      },
      messageContains: "Regression checks complete",
      maxTurns: 8,
    },
    script: [
      [
        { type: "tool_call", id: "hr-1", name: "code_search", input: { query: "greet", kind: "function" } },
        usage(),
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "hr-2", name: "test_runner", input: { command: "npm test" } },
        usage(),
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "hr-3", name: "git_status", input: {} },
        { type: "tool_call", id: "hr-4", name: "git_diff", input: { file: "src/hello.ts" } },
        usage(),
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Regression checks complete." },
        usage(),
        { type: "done", stopReason: "end_turn" },
      ],
    ],
  },
];

export function getEvalTasks(): EvalTask[] {
  return EVAL_TASKS;
}

export function getEvalTask(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((task) => task.id === id);
}
