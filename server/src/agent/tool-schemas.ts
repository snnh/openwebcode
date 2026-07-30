import type { ProviderTool } from "../providers/provider.js";
import type { ShellBackend } from "../sessions/types.js";

/**
 * 主循环与子代理共用的内置工具 schema（单一来源，避免两处字面量漂移）。
 * 子代理（sub-agent.ts）按内置名过滤本表生成自己的工具集；执行/权限始终在 agent-runner。
 */
export function bashTool(backgroundTasksEnabled: boolean, shellBackend: ShellBackend): ProviderTool {
  const shellGuidance = shellBackend === "pwsh"
    ? "Commands run under PowerShell 7 (pwsh): use PowerShell syntax and cmdlets (for example Get-ChildItem, Get-Content, Get-Command, and ;). "
    : "On Windows sandbox sessions commands run under cmd.exe: use cmd syntax (for example dir, type, where, and &&), and do not use PowerShell cmdlets or POSIX commands unless explicitly invoking an available shell. ";
  return {
    name: "bash",
    description: "Execute a shell command in the session workspace. Call this when command-line execution is required. " + shellGuidance +
      (backgroundTasksEnabled
        ? " Set run_in_background=true to run the command asynchronously; the agent loop continues immediately and you can check " +
          "the result later with task_output (or wait with block=true)."
        : ""),
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        ...(backgroundTasksEnabled
          ? { run_in_background: { type: "boolean", description: "Run the command in the background and return immediately." } }
          : {}),
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  };
}

export const READ_ARTIFACT_TOOL: ProviderTool = {
  name: "read_artifact",
  description: "Read a bounded slice of a tool-output artifact when an evicted or truncated result points to an artifact ID.",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
    required: ["artifactId", "offset", "limit"],
    additionalProperties: false,
  },
};

/** 文件工具的 path 参数：模型可传相对会话根的路径或根内绝对路径（含 .、..
 * 点分量与两种分隔符），归一化与路径策略校验全部由执行层（core C）完成，
 * 模型无需自行解析或判断权限。 */
const PATH_SCHEMA = {
  type: "string",
  description: "Workspace path: relative to the session root, or absolute inside it (dot segments and either separator accepted). Normalization and path policy are enforced by the executor; pass the path as-is.",
} as const;

export const FILE_TOOLS: ProviderTool[] = [
  { name: "read_file", description: "Read UTF-8 lines from a workspace file.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false } },
  { name: "write_file", description: "Atomically write a UTF-8 workspace file.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, content: { type: "string" }, createDirs: { type: "boolean" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "edit_file", description: "Replace exact text in a UTF-8 workspace file.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldText", "newText"], additionalProperties: false } },
  { name: "glob", description: "Recursively match workspace paths using * and ? wildcards.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
  { name: "grep", description: "Recursively search UTF-8 workspace files for literal text.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
];

export const REPO_MAP_TOOL: ProviderTool = {
  name: "repo_map",
  description:
    "Summarize the workspace repository structure as a bounded directory tree plus key-file hints, " +
    "fit within a token budget (default 2048). Read-only; truncated output is annotated as such.",
  inputSchema: {
    type: "object",
    properties: { budget: { type: "integer", minimum: 64, description: "Token budget for the map; defaults to the session repo map budget (2048)." } },
    additionalProperties: false,
  },
};

export const CODE_SEARCH_TOOL: ProviderTool = {
  name: "code_search",
  description:
    "Search the workspace symbol index with a fuzzy symbol-name query and optional kind filter " +
    "(function/method/class/interface/type/struct/enum/trait/impl/constant). Returns definition " +
    "locations (file:line) with signature summaries. Read-only. If the index is unavailable, " +
    "fall back to grep/glob; rebuilding is an explicit user action, do not retry in a loop.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Symbol name to fuzzy-match (exact > prefix > substring > subsequence)." },
      kind: { type: "string", description: "Optional symbol kind filter, e.g. function, class, method." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results; default 50." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const TEST_RUNNER_TOOL: ProviderTool = {
  name: "test_runner",
  description:
    "Run the project test suite and return a bounded failure summary. The test command is auto-detected " +
    "(package.json/npm test or vitest, pyproject.toml/pytest, go.mod/go test, *.sln/dotnet test); pass command to override. " +
    "Vitest/jest/pytest/go/dotnet output is parsed into structured diagnostics; at most 20 failures are returned inline, " +
    "full diagnostics are persisted to a session diagnostics artifact referenced in the result.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Optional custom test command overriding auto-detection." },
    },
    additionalProperties: false,
  },
};

export const ASK_USER_TOOL: ProviderTool = {
  name: "ask_user",
  description:
    "Ask the user structured questions mid-run and wait for the answers. Use when a decision or missing detail " +
    "materially changes the work. 1-4 questions, asked sequentially; select types require 2-4 options. " +
    "Returns an array of { question, type, answer } (answer: boolean for confirm, selected option labels for select types, string for text), or { cancelled: true }.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string", description: "Short label shown on the question card." },
            type: { type: "string", enum: ["confirm", "single_select", "multi_select", "text"] },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
                additionalProperties: false,
              },
            },
          },
          required: ["question", "type"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export const WEB_FETCH_TOOL: ProviderTool = {
  name: "web_fetch",
  description: "Fetch a public http/https URL and return bounded readable text.",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
};

export const WEB_SEARCH_TOOL: ProviderTool = {
  name: "web_search",
  description: "Search the web using the configured search provider.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
    required: ["query"],
    additionalProperties: false,
  },
};
