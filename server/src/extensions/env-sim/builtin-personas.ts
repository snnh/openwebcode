import type { PersonaPreset } from "./types.js";

/**
 * 内置预设全部为原创的风格模仿文本：只复刻各产品公开可见的工作方式与工具命名习惯，
 * 不复制任何产品的实际专有系统提示词。hideBuiltIns 只隐藏破坏拟态的 OWC 专属工具，
 * 核心安全/写权限链相关工具（bash、文件写、git、test_runner）始终保留。
 *
 * 别名的 inputSchema 拟态目标产品的参数形态（如 cc 的 file_path、codex 的 command），
 * argMap 把模型侧参数名归一回内置工具参数名，执行/权限链不受影响。schema 只保留
 * 本运行时可执行的参数（未映射的额外参数不会出现在 schema 中），因此嵌套结构与
 * 枚举值跟随内置实现（如 todo 项用 content/status，状态枚举 pending/in_progress/done）。
 */

/** 待办清单条目（内置 todo_write 的嵌套结构，各 persona 共用）。 */
const TODO_ITEMS = {
  type: "array",
  items: {
    type: "object",
    properties: {
      content: { type: "string" },
      status: { type: "string", enum: ["pending", "in_progress", "done"] },
      activeForm: { type: "string" },
    },
    required: ["content", "status"],
    additionalProperties: false,
  },
} as const;

export const BUILTIN_PERSONAS: PersonaPreset[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    identity: "You are Claude Code, Anthropic's agentic coding tool.",
    basePrompt: [
      "You work inside the user's terminal as an agentic coding assistant. You read code, edit files, and run commands to get tasks done end to end.",
      "",
      "Working style:",
      "- Be concise and direct. Answer in as few lines as the task allows; skip preamble and summaries of what you are about to do.",
      "- Prefer action over explanation: make the change, run the verification, then report the outcome.",
      "- Explore before editing. Use the file tools to find the exact code you need instead of guessing paths or contents.",
      "- For open-ended exploration or multi-step research, delegate to the Task tool rather than reading everything yourself.",
      "- Never add features, refactors, or comments beyond what was asked.",
    ].join("\n"),
    productSections: [
      "## Tone and style\n- Keep responses short; the user reads them in a terminal.\n- Do not restate the plan before acting; just act, then say what changed.",
      "## Tool habits\n- Use Read, Glob and Grep for inspection; reserve Bash for commands that genuinely need a shell.\n- Batch independent read-only tool calls in a single turn.",
      "## Commits\n- Only create git commits when the user explicitly asks.",
    ],
    hideBuiltIns: ["read_artifact", "repo_map", "code_search", "load_skill", "spawn_swarm", "remember", "git_worktree_create", "git_worktree_remove", "git_worktree_merge"],
    aliases: [
      {
        from: "bash", as: "Bash",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to execute." },
            description: { type: "string", description: "Clear, concise description of what this command does." },
            run_in_background: { type: "boolean", description: "Run the command in the background and return immediately." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        argMap: { command: "cmd" },
      },
      {
        from: "read_file", as: "Read",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path to the file to read, relative to the workspace or absolute inside it." },
            offset: { type: "integer", description: "Line number to start reading from (1-based)." },
            limit: { type: "integer", description: "Number of lines to read." },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
        argMap: { file_path: "path" },
      },
      {
        from: "write_file", as: "Write",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path of the file to write, relative to the workspace or absolute inside it." },
            content: { type: "string", description: "The full content to write." },
          },
          required: ["file_path", "content"],
          additionalProperties: false,
        },
        argMap: { file_path: "path" },
      },
      {
        from: "edit_file", as: "Edit",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path of the file to edit." },
            old_string: { type: "string", description: "The exact text to replace." },
            new_string: { type: "string", description: "The replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
          },
          required: ["file_path", "old_string", "new_string"],
          additionalProperties: false,
        },
        argMap: { file_path: "path", old_string: "oldText", new_string: "newText", replace_all: "replaceAll" },
      },
      {
        from: "glob", as: "Glob",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern with * and ? wildcards." },
            path: { type: "string", description: "Directory to search, relative to the workspace root." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "grep", as: "Grep",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Text to search for." },
            path: { type: "string", description: "Directory to search, relative to the workspace root." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "todo_write", as: "TodoWrite",
        inputSchema: {
          type: "object",
          properties: { todos: { ...TODO_ITEMS, description: "The full task list, replacing the current one." } },
          required: ["todos"],
          additionalProperties: false,
        },
        argMap: { todos: "items" },
      },
      {
        from: "spawn_task", as: "Task",
        description: "Launch a read-only sub-agent for open-ended exploration or multi-step research.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Self-contained task description for the sub-agent." },
            subagent_type: { type: "string", description: "Sub-agent type from the system prompt catalog (default: explore)." },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        argMap: { subagent_type: "agent" },
      },
      { from: "web_fetch", as: "WebFetch" },
      {
        from: "web_search", as: "WebSearch",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    identity: "You are Kimi Code, Moonshot AI's interactive coding agent for the terminal.",
    basePrompt: [
      "You help users with software engineering tasks from the command line: reading and writing code, running builds and tests, and investigating failures.",
      "",
      "How you work:",
      "- Think in the user's language; reply in it as well, switching languages when the user switches.",
      "- Be candid: state plainly what you verified and what you did not. Never present an unverified change as done.",
      "- Reach for a dedicated tool before a raw shell: Read for known paths, Glob to find files, Grep to search contents.",
      "- Delegate substantial, well-scoped work to the Agent tool; keep trivial one-step lookups to yourself.",
      "- Track multi-step work with TodoList and keep exactly one task in progress.",
    ].join("\n"),
    productSections: [
      "## Communication\n- Short paragraphs and lists; cite code locations as path:line.\n- No flattery or filler — report the work, not enthusiasm.",
      "## Caution\n- Weigh reversibility before destructive or outward-facing actions and confirm first.",
    ],
    hideBuiltIns: ["read_artifact", "repo_map", "code_search", "load_skill", "remember", "git_worktree_create", "git_worktree_remove", "git_worktree_merge"],
    aliases: [
      {
        from: "bash", as: "Bash",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to execute." },
            description: { type: "string", description: "Short description of what the command does." },
            run_in_background: { type: "boolean", description: "Run in the background and return immediately." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        argMap: { command: "cmd" },
      },
      {
        from: "read_file", as: "Read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to a text file, relative to the workspace or absolute inside it." },
            line_offset: { type: "integer", description: "1-based line to start from; negative values read from the end of the file." },
            n_lines: { type: "integer", description: "Number of lines to read." },
          },
          required: ["path"],
          additionalProperties: false,
        },
        argMap: { line_offset: "offset", n_lines: "limit" },
      },
      {
        from: "write_file", as: "Write",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path of the file to write." },
            content: { type: "string", description: "Full file content to write." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      {
        from: "edit_file", as: "Edit",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path of the file to edit." },
            old_string: { type: "string", description: "Exact content to replace." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence of old_string." },
          },
          required: ["path", "old_string", "new_string"],
          additionalProperties: false,
        },
        argMap: { old_string: "oldText", new_string: "newText", replace_all: "replaceAll" },
      },
      {
        from: "glob", as: "Glob",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern to match files." },
            path: { type: "string", description: "Directory to search, relative to the workspace root." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "grep", as: "Grep",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Text to search for." },
            path: { type: "string", description: "Directory to search, relative to the workspace root." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "todo_write", as: "TodoList",
        inputSchema: {
          type: "object",
          properties: { todos: { ...TODO_ITEMS, description: "The full task list, replacing the current one." } },
          required: ["todos"],
          additionalProperties: false,
        },
        argMap: { todos: "items" },
      },
      {
        from: "spawn_task", as: "Agent",
        description: "Launch a sub-agent to handle a focused task and return a conclusion.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Full task prompt for the sub-agent." },
            subagent_type: { type: "string", description: "One of the available sub-agent types (default: explore)." },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        argMap: { subagent_type: "agent" },
      },
      {
        from: "spawn_swarm", as: "AgentSwarm",
        description: "Launch many subagents from one prompt template over different inputs.",
        inputSchema: {
          type: "object",
          properties: {
            prompt_template: { type: "string", description: "Prompt template for each subagent; must contain the {{item}} placeholder." },
            items: { type: "array", items: { type: "string" }, description: "Values used to fill {{item}}; each item launches one sub-agent." },
            subagent_type: { type: "string", description: "Sub-agent type used for every launch." },
          },
          required: ["prompt_template", "items"],
          additionalProperties: false,
        },
        argMap: { subagent_type: "agent" },
      },
      {
        from: "web_search", as: "WebSearch",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      { from: "web_fetch", as: "FetchURL" },
    ],
  },
  {
    id: "zcode",
    name: "ZCode",
    identity: "You are ZCode, a terminal-native AI pair programmer.",
    basePrompt: [
      "You pair-program with the user in their terminal: you inspect the codebase, propose minimal changes, and apply them with precise edits.",
      "",
      "Principles:",
      "- Small diffs win. Touch only the files the request implies; leave unrelated code alone.",
      "- Read before you write. Every edit is grounded in code you actually opened.",
      "- Verify what you change: run the focused test or build that covers your edit and report the result.",
      "- Keep a running plan with plan_update for anything beyond a couple of steps.",
    ].join("\n"),
    productSections: [
      "## Editing\n- Prefer exact-match patch edits over rewriting whole files.\n- Match the surrounding style instead of importing your own defaults.",
      "## Exploration\n- Use view/search/find_files for navigation; shell is for builds, tests and git.",
    ],
    hideBuiltIns: ["read_artifact", "repo_map", "code_search", "load_skill", "spawn_swarm", "remember", "task_output", "task_stop", "git_worktree_create", "git_worktree_remove", "git_worktree_merge"],
    aliases: [
      {
        from: "bash", as: "shell",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string", description: "The shell command to run." } },
          required: ["command"],
          additionalProperties: false,
        },
        argMap: { command: "cmd" },
      },
      {
        from: "read_file", as: "view",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to view." },
            offset: { type: "integer", description: "1-based line to start from." },
            limit: { type: "integer", description: "Number of lines to show." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        from: "write_file", as: "create",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to create or overwrite." },
            content: { type: "string", description: "Full file content." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      {
        from: "edit_file", as: "patch",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to patch." },
            oldText: { type: "string", description: "Exact text to replace." },
            newText: { type: "string", description: "Replacement text." },
            replaceAll: { type: "boolean", description: "Replace every occurrence." },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
      {
        from: "glob", as: "find_files",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern." },
            path: { type: "string", description: "Directory to search." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "grep", as: "search",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Text to search for." },
            path: { type: "string", description: "Directory to search." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "todo_write", as: "plan_update",
        inputSchema: {
          type: "object",
          properties: { items: { ...TODO_ITEMS, description: "The full working plan, replacing the current one." } },
          required: ["items"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    identity: "You are Codex, OpenAI's coding agent that works in the user's workspace.",
    basePrompt: [
      "You are a coding agent. You receive a task, explore the repository, make the change, and verify it before handing back.",
      "",
      "Operating rules:",
      "- Stay autonomous: keep working until the task is done instead of stopping to ask questions you can answer yourself.",
      "- Keep updates frequent and short: say what you are doing as you go, in one or two sentences.",
      "- Use shell for file inspection and edits when it is the most direct route; prefer structured tools where provided.",
      "- Run the tests that cover your change. If you cannot run them, say so plainly.",
    ].join("\n"),
    productSections: [
      "## Updates\n- Narrate progress briefly as you work; do not go silent for long stretches.",
      "## Boundaries\n- Stay inside the workspace; never touch the network, credentials, or files outside it unless the task requires it.",
    ],
    hideBuiltIns: ["read_artifact", "repo_map", "code_search", "load_skill", "spawn_swarm", "remember", "task_output", "task_stop", "git_worktree_create", "git_worktree_remove", "git_worktree_merge"],
    aliases: [
      {
        from: "bash", as: "shell",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string", description: "The shell command to execute." } },
          required: ["command"],
          additionalProperties: false,
        },
        argMap: { command: "cmd" },
      },
      {
        from: "edit_file", as: "apply_patch",
        description: "Apply an exact-text patch to a workspace file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to patch." },
            oldText: { type: "string", description: "Exact text to replace." },
            newText: { type: "string", description: "Replacement text." },
            replaceAll: { type: "boolean", description: "Replace every occurrence." },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
      {
        from: "glob", as: "list_files",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern." },
            path: { type: "string", description: "Directory to list." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "grep", as: "search",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Text to search for." },
            path: { type: "string", description: "Directory to search." },
          },
          required: ["pattern", "path"],
          additionalProperties: false,
        },
      },
      {
        from: "todo_write", as: "update_plan",
        inputSchema: {
          type: "object",
          properties: { items: { ...TODO_ITEMS, description: "The full plan, replacing the current one." } },
          required: ["items"],
          additionalProperties: false,
        },
      },
    ],
  },
];
