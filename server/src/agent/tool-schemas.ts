import type { ProviderTool } from "../providers/provider.js";
import type { PythonEnv, ShellBackend } from "../sessions/types.js";

/**
 * 主循环与子代理共用的内置工具 schema（单一来源，避免两处字面量漂移）。
 * 子代理（sub-agent.ts）按内置名过滤本表生成自己的工具集；执行/权限始终在 agent-runner。
 */
export function bashTool(backgroundTasksEnabled: boolean, shellBackend: ShellBackend, pythonEnv: PythonEnv = "global"): ProviderTool {
  const shellGuidance = shellBackend === "pwsh"
    ? "Commands run under PowerShell 7 (pwsh): use PowerShell syntax and cmdlets (for example Get-ChildItem, Get-Content, Get-Command, and ;). "
    : "On Windows sandbox sessions commands run under cmd.exe: use cmd syntax (for example dir, type, where, and &&), and do not use PowerShell cmdlets or POSIX commands unless explicitly invoking an available shell. ";
  const envGuidance = pythonEnv === "global"
    ? "Python and Node.js run from the host environment. "
    : "Python runs in an isolated uv-managed virtual environment that is created on demand (its directory is prepended to PATH); install packages with 'uv pip install'. Node.js still uses the host environment. ";
  return {
    name: "bash",
    description: "Execute a shell command in the session workspace. Call this when command-line execution is required (build, test, package managers, git, running programs). " +
      "For reading, writing, editing, listing or searching files, prefer the dedicated file tools (read_file/write_file/edit_file/glob/grep) over shell equivalents " +
      "(dir, type, findstr, cat, echo-redirects): they are sandbox-native, return structured results, and do not depend on shell quirks. " +
      "A non-zero exit code is a normal signal, not a tool failure: read the stderr/stdout in the result and adjust the command instead of retrying it unchanged. " +
      "The shell is persistent: the working directory and environment variables set by one call carry over to later calls in the same session. " + shellGuidance + envGuidance +
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

/** glob/grep 的 path：可选，缺省从会话根开始。 */
const OPTIONAL_PATH_SCHEMA = {
  type: "string",
  description: "Start directory inside the workspace; omit to use the session root.",
} as const;

export const FILE_TOOLS: ProviderTool[] = [
  { name: "read_file", description: "Read UTF-8 lines from a workspace file. offset is the 1-based start line (default 1) and limit the max line count; long or binary content is truncated into an artifact reference you can page with read_artifact.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false } },
  { name: "write_file", description: "Atomically write a UTF-8 workspace file.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, content: { type: "string" }, createDirs: { type: "boolean" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "edit_file", description: "Replace exact text in a UTF-8 workspace file. oldText must match the file content byte-for-byte (including indentation and line endings) and occur exactly once unless replaceAll is true; include enough surrounding context to make it unique.", inputSchema: { type: "object", properties: { path: PATH_SCHEMA, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldText", "newText"], additionalProperties: false } },
  { name: "glob", description: "List workspace files matching a wildcard pattern (* within one level, ** spans levels, e.g. \"**/*.ts\" or \"src/*.json\"). Returns matching paths, newest first; use it instead of shell dir/ls to explore the workspace.", inputSchema: { type: "object", properties: { path: OPTIONAL_PATH_SCHEMA, pattern: { type: "string", description: "Wildcard pattern, e.g. \"**/*.py\" or \"*\" (top level only)." } }, required: ["pattern"], additionalProperties: false } },
  { name: "grep", description: "Recursively search UTF-8 workspace files for literal text (not regex). Returns matching lines with file:line locations; use code_search for symbol-level queries.", inputSchema: { type: "object", properties: { path: OPTIONAL_PATH_SCHEMA, pattern: { type: "string", description: "Literal text to search for." } }, required: ["pattern"], additionalProperties: false } },
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

/** plan 模式专属：提交完整实施计划请求用户批准（仅主 agent、仅 plan 模式下发；子代理不可见）。 */
export const EXIT_PLAN_MODE_TOOL: ProviderTool = {
  name: "exit_plan_mode",
  description:
    "Submit the finished implementation plan for user approval and exit plan mode. Call exactly once when the plan is complete. " +
    "The user may approve it, approve an edited version, or reject it with feedback; the tool result carries the decision. " +
    "Do not call any write tool before the plan is approved.",
  inputSchema: {
    type: "object",
    properties: { plan: { type: "string", description: "The full implementation plan in Markdown." } },
    required: ["plan"],
    additionalProperties: false,
  },
};

/** cron 定时任务（提交⑫）：到点经 follow-up 队列向本会话注入提示词。仅主 agent 下发；子代理不下发。 */
export const CRON_CREATE_TOOL: ProviderTool = {
  name: "cron_create",
  description:
    "Schedule a prompt to be injected into this session as a follow-up message on a cron schedule. " +
    "The expression has 5 fields (minute hour day-of-month month day-of-week, server local timezone) and supports " +
    "*, */n, ranges a-b, lists a,b and single values, e.g. \"*/30 * * * *\" or \"0 9 * * 1-5\". " +
    "Recurring jobs (the default) expire 7 days after creation with one final run and are then deleted; " +
    "recurring=false creates a one-shot job that deletes itself after firing. At most 50 jobs per session.",
  inputSchema: {
    type: "object",
    properties: {
      cron: { type: "string", description: "5-field cron expression (minute hour day-of-month month day-of-week)." },
      prompt: { type: "string", description: "The prompt injected into the session when the job fires." },
      recurring: { type: "boolean", description: "Defaults to true. false = fire once, then auto-delete." },
    },
    required: ["cron", "prompt"],
    additionalProperties: false,
  },
};

export const CRON_LIST_TOOL: ProviderTool = {
  name: "cron_list",
  description: "List this session's scheduled cron jobs with their next fire time and stale (final-run) marker.",
  inputSchema: { type: "object", additionalProperties: false },
};

export const CRON_DELETE_TOOL: ProviderTool = {
  name: "cron_delete",
  description: "Delete one of this session's cron jobs by id (ids come from cron_create/cron_list).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The cron job id to delete." } },
    required: ["id"],
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

/** swarm 成员专属：向本次 spawn_swarm 的共享讨论板追加一条发现/问题。仅 swarm 子代理可见。 */
export const SWARM_BOARD_POST_TOOL: ProviderTool = {
  name: "swarm_board_post",
  description:
    "Post a finding or question to this swarm's shared discussion board so other members can see it. " +
    "Keep it short (truncated at 500 characters).",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "The finding or question to share with the swarm." } },
    required: ["text"],
    additionalProperties: false,
  },
};

/** swarm 成员专属：读共享讨论板（可选 since 行偏移增量读）。仅 swarm 子代理可见。 */
export const SWARM_BOARD_READ_TOOL: ProviderTool = {
  name: "swarm_board_read",
  description:
    "Read this swarm's shared discussion board (entries posted by all members, bounded to the most recent ones). " +
    "Pass since=<offset from a previous read> to get only new entries.",
  inputSchema: {
    type: "object",
    properties: { since: { type: "integer", minimum: 0, description: "Line offset from a previous read; only entries after it are returned." } },
    additionalProperties: false,
  },
};
