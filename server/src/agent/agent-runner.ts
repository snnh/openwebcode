import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CoreClientLike, CoreEvent } from "../core-client.js";
import { CoreGateway } from "../core-gateway.js";
import type { EventBus } from "../events/event-bus.js";
import { ContextManager, selectCacheBreakpoints } from "../context/context-manager.js";
import type { Compactor } from "../context/compactor.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { RepoMapGenerator, DEFAULT_REPO_MAP_BUDGET } from "../context/repo-map.js";
import { IndexManager, IndexUnavailableError } from "../index/index-manager.js";
import type { DiagnosticsService } from "../diagnostics/service.js";
import type { ScmService } from "../scm/service.js";
import { getModelProfile, type ModelProfile } from "../context/model-profile.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { ExchangeRateService } from "../cost/exchange-rate.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import type { ProviderRegistry, ProviderTool, ProviderEvent } from "../providers/provider.js";
import { collectProviderTurn } from "../providers/retry.js";
import { PermissionCoordinator, permissionRule, type PermissionDecision } from "./permission-coordinator.js";
import { runSubAgent, SUB_AGENT_TOOL_NAMES } from "./sub-agent.js";
import { getSnapshotBackend } from "../snapshots/index.js";
import type { MessageContent, ShellBackend } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import { parseSkillCommand, type SkillRegistry } from "../skills.js";
import type { AgentDefinition, AgentRegistry } from "../agents.js";
import { renderCommand, type CommandRegistry } from "../commands.js";
import type { McpManager } from "../mcp/manager.js";
import { appendMemory, readGlobalMemory, readProjectMemory } from "../memory.js";
import type { UsageLog } from "../usage-log.js";
import type { SearchProvider, WebFetchProvider } from "../web-tools.js";
import type { BackgroundTaskRegistry } from "./background-tasks.js";
import type { HookEvent, HookPayload, HookRunner } from "../hooks.js";
import type { ExtensionManager } from "../extensions/extension-manager.js";
import { decodeProcessOutputChunks } from "./output-decoder.js";
import { buildSystemPrompt } from "./prompts/prompt-builder.js";
import { loadPromptOverride, type PromptOverride } from "./prompts/prompt-overrides.js";
import { RunStore, type AgentRunSnapshot, type AgentRunState } from "./run-store.js";
import { MessageQueue, type QueueItem } from "./message-queue.js";
import { InteractionCoordinator, type InteractionKind, type InteractionRequest } from "./interaction-coordinator.js";

interface ExecutionContext {
  sessionId: string;
  output: Array<{ stream: string; data: string; seq: number }>;
}

const TOOL_EVENT_PREVIEW_CHARS = 1_024;

/** Event replay is not the tool-result store. Keep payloads bounded and point
 * clients at the artifact/session detail path for complete output. */
function toolEventResult(bounded: Awaited<ReturnType<typeof boundToolResult>>) {
  return {
    preview: bounded.content.slice(0, TOOL_EVENT_PREVIEW_CHARS),
    originalTokens: bounded.originalTokens,
    truncated: bounded.truncated,
    ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}),
  };
}

function bashTool(backgroundTasksEnabled: boolean, shellBackend: ShellBackend): ProviderTool {
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

const READ_ARTIFACT_TOOL: ProviderTool = {
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

const FILE_TOOLS: ProviderTool[] = [
  { name: "read_file", description: "Read UTF-8 lines from a workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false } },
  { name: "write_file", description: "Atomically write a UTF-8 workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, createDirs: { type: "boolean" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "edit_file", description: "Replace exact text in a UTF-8 workspace file.", inputSchema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldText", "newText"], additionalProperties: false } },
  { name: "glob", description: "Recursively match workspace paths using * and ? wildcards.", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
  { name: "grep", description: "Recursively search UTF-8 workspace files for literal text.", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"], additionalProperties: false } },
];

const REPO_MAP_TOOL: ProviderTool = {
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

const CODE_SEARCH_TOOL: ProviderTool = {
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

const TEST_RUNNER_TOOL: ProviderTool = {
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

const GIT_STATUS_TOOL: ProviderTool = {
  name: "git_status",
  description:
    "Show the git working-tree status of the session workspace (porcelain): current branch, ahead/behind, " +
    "and staged/unstaged/untracked change groups. Read-only; large repositories are truncated per group with true totals kept.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const GIT_DIFF_TOOL: ProviderTool = {
  name: "git_diff",
  description:
    "Show the git diff of the session workspace. Defaults to unstaged changes; pass staged=true for the index, " +
    "base for a commit range (e.g. HEAD~1 or main...HEAD), file to limit to one path. Read-only; when the diff " +
    "exceeds the inline limit only the stat summary is returned and the full diff is stored in an artifact.",
  inputSchema: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Diff the staged index instead of the working tree." },
      base: { type: "string", description: "Commit range or baseline ref, e.g. HEAD~1 or main...HEAD (mutually exclusive with staged)." },
      file: { type: "string", description: "Limit the diff to one relative path." },
    },
    additionalProperties: false,
  },
};

const GIT_COMMIT_TOOL: ProviderTool = {
  name: "git_commit",
  description:
    "Create a git commit in the session workspace. Always requires explicit user confirmation. " +
    "Optionally stages changes first (stageAll or an explicit files list); arbitrary git flags are not accepted. " +
    "The result includes the new commit hash and a fresh git status summary.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message (required, <= 2000 chars)." },
      stageAll: { type: "boolean", description: "Stage all changes (git add -A) before committing." },
      files: { type: "array", items: { type: "string" }, description: "Stage only these relative paths before committing (mutually exclusive with stageAll)." },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

const GIT_WORKTREE_CREATE_TOOL: ProviderTool = {
  name: "git_worktree_create",
  description:
    "Create an isolated git worktree for this session (stored in the server data directory, outside the repo) " +
    "on a new branch, for parallel isolated work. Merging back is an explicit git_worktree_merge call; " +
    "worktrees are never auto-deleted — the user removes them via git_worktree_remove or the REST API.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Worktree name ([a-zA-Z0-9._-]); auto-generated when omitted." },
      branch: { type: "string", description: "Branch to create; defaults to owc/<name>." },
    },
    additionalProperties: false,
  },
};

const GIT_WORKTREE_REMOVE_TOOL: ProviderTool = {
  name: "git_worktree_remove",
  description: "Remove a session worktree by name. Fails on uncommitted changes unless force=true.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      force: { type: "boolean", description: "Discard uncommitted changes in the worktree." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const GIT_WORKTREE_MERGE_TOOL: ProviderTool = {
  name: "git_worktree_merge",
  description:
    "Merge a session worktree's branch back into the session workspace (merge or cherry-pick). " +
    "Conflicts are reported as a file list and the merge is aborted — never auto-resolved.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      strategy: { type: "string", enum: ["merge", "cherry-pick"], description: "Defaults to merge (--no-ff)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const LOAD_SKILL_TOOL: ProviderTool = {
  name: "load_skill",
  description: "Load the full text of a skill listed in the system prompt skill catalog.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
};

const SPAWN_TASK_TOOL: ProviderTool = {
  name: "spawn_task",
  description:
    "Launch a read-only sub-agent with an isolated context to explore or research a task. " +
    "The sub-agent does not share this session's context; only its final conclusion (at most 2000 characters) is returned. " +
    "It can only use the read-only tools read_file, glob, grep and read_artifact.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Self-contained task description for the sub-agent." },
      agent: { type: "string", description: "Optional custom sub-agent name from the system prompt catalog." },
      tools: {
        type: "array",
        items: { type: "string", enum: [...SUB_AGENT_TOOL_NAMES] },
        description: "Subset of read_file/glob/grep/read_artifact the sub-agent may use; defaults to all four.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

/** swarm 单项数上限：低于 Kimi Code AgentSwarm 的 128，作为自托管部署的成本护栏。 */
export const SPAWN_SWARM_MAX_ITEMS = 16;
/** 同时运行的子代理数；超出排队，与"launch 自动排队"语义一致。 */
export const SPAWN_SWARM_CONCURRENCY = 4;

const SPAWN_SWARM_TOOL: ProviderTool = {
  name: "spawn_swarm",
  description:
    "Launch multiple read-only sub-agents from one prompt template over different inputs, running in parallel (launches beyond the concurrency limit are queued). " +
    "The {{item}} placeholder in prompt_template is replaced with each item's task value; each item launches one independent sub-agent with an isolated context. " +
    "Use when many independent tasks of the same kind should run in parallel (e.g. reviewing several files or endpoints). " +
    "For a single task use spawn_task instead. Each sub-agent can only use the read-only tools read_file, glob, grep and read_artifact; " +
    "only its final conclusion (at most 2000 characters) is returned, aggregated as numbered results.",
  inputSchema: {
    type: "object",
    properties: {
      prompt_template: { type: "string", description: "Prompt template for every sub-agent; must contain the {{item}} placeholder where each item's task value is substituted." },
      items: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                task: { type: "string", description: "Value used to fill {{item}} for this item." },
                agent: { type: "string", description: "Optional custom sub-agent name overriding the call-level agent for this item only." },
              },
              required: ["task"],
              additionalProperties: false,
            },
          ],
        },
        description: "Values used to fill {{item}}. Each item launches one sub-agent; 2-16 items, and the filled-in prompts must be distinct. An item may be a plain string or an object { task, agent? } to override the agent for that item.",
      },
      agent: { type: "string", description: "Optional custom sub-agent name from the system prompt catalog, applied to every launch unless an item overrides it." },
    },
    required: ["prompt_template", "items"],
    additionalProperties: false,
  },
};

const TODO_WRITE_TOOL: ProviderTool = {
  name: "todo_write",
  description: "Replace the session task list. Use it to track multi-step work; keep exactly one item in_progress.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
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
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
  activeForm?: string;
}

const REMEMBER_TOOL: ProviderTool = {
  name: "remember",
  description:
    "Save a durable fact to long-term memory; remembered facts are injected into the system prompt on every turn. " +
    "Scope \"project\" (default) writes the workspace .owc/memory.md; scope \"global\" writes the server data-root memory.md shared by all sessions. " +
    "Use it for stable user preferences, project conventions, and key decisions worth keeping across compactions and sessions.",
  inputSchema: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The fact to remember, stored as a single bullet." },
      scope: { type: "string", enum: ["project", "global"], description: "Where to store the fact; defaults to project." },
    },
    required: ["fact"],
    additionalProperties: false,
  },
};

const WEB_FETCH_TOOL: ProviderTool = {
  name: "web_fetch",
  description: "Fetch a public http/https URL and return bounded readable text.",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
};

const WEB_SEARCH_TOOL: ProviderTool = {
  name: "web_search",
  description: "Search the web using the configured search provider.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
    required: ["query"],
    additionalProperties: false,
  },
};

const TASK_OUTPUT_TOOL: ProviderTool = {
  name: "task_output",
  description: "Read the output of a background task started with bash run_in_background=true. " +
    "Set block=true to wait until the task finishes (up to timeoutMs, default 30s).",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The taskId returned from a background bash call." },
      block: { type: "boolean", description: "Whether to wait for the task to complete." },
      timeoutMs: { type: "integer", description: "Maximum time to wait in ms when block=true (max 30000)." },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
};

const TASK_STOP_TOOL: ProviderTool = {
  name: "task_stop",
  description: "Stop a running background task by killing its core process.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string", description: "The taskId returned from a background bash call." } },
    required: ["taskId"],
    additionalProperties: false,
  },
};

function builtInTools(options: {
  skillsAvailable: boolean;
  backgroundTasksEnabled: boolean;
  fetchAvailable: boolean;
  searchAvailable: boolean;
  shellBackend: ShellBackend;
}): ProviderTool[] {
  return [
    bashTool(options.backgroundTasksEnabled, options.shellBackend),
    ...FILE_TOOLS,
    READ_ARTIFACT_TOOL,
    REPO_MAP_TOOL,
    CODE_SEARCH_TOOL,
    TEST_RUNNER_TOOL,
    GIT_STATUS_TOOL,
    GIT_DIFF_TOOL,
    GIT_COMMIT_TOOL,
    GIT_WORKTREE_CREATE_TOOL,
    GIT_WORKTREE_REMOVE_TOOL,
    GIT_WORKTREE_MERGE_TOOL,
    ...(options.skillsAvailable ? [LOAD_SKILL_TOOL] : []),
    SPAWN_TASK_TOOL,
    SPAWN_SWARM_TOOL,
    TODO_WRITE_TOOL,
    REMEMBER_TOOL,
    ...(options.fetchAvailable ? [WEB_FETCH_TOOL] : []),
    ...(options.backgroundTasksEnabled ? [TASK_OUTPUT_TOOL, TASK_STOP_TOOL] : []),
    ...(options.searchAvailable ? [WEB_SEARCH_TOOL] : []),
  ];
}

const MAX_STEERING_ITEMS = 16;
const MAX_STEERING_LENGTH = 8_000;
/** Scheduling metadata is product-side only; Provider schemas remain unchanged. */
export type ToolExecutionClass = "read_only" | "workspace_write" | "process" | "external";
const TOOL_EXECUTION_CLASS: Readonly<Record<string, ToolExecutionClass>> = {
  read_file: "read_only", glob: "read_only", grep: "read_only", read_artifact: "read_only", load_skill: "read_only", repo_map: "read_only", code_search: "read_only",
  git_status: "read_only", git_diff: "read_only",
  web_fetch: "external", web_search: "external", write_file: "workspace_write", edit_file: "workspace_write",
  bash: "process", task_output: "read_only", task_stop: "process", todo_write: "workspace_write", remember: "workspace_write", spawn_task: "process", spawn_swarm: "process", test_runner: "process",
  git_commit: "process", git_worktree_create: "process", git_worktree_remove: "process", git_worktree_merge: "process",
};
function executionClass(name: string): ToolExecutionClass { return name.startsWith("mcp__") || name.startsWith("ext__") ? "external" : TOOL_EXECUTION_CLASS[name] ?? "workspace_write"; }
/** 系统提示中单个记忆/约定小节的字符上限 */
const MEMORY_SECTION_LIMIT = 8_000;

function workDisciplineSection(toolNames: ReadonlySet<string>): string {
  if (toolNames.size === 0) return "";
  const lines = [
    "\n\n## Work discipline",
    "- Inspect relevant code and context before editing.",
  ];
  if (["read_file", "glob", "grep"].every((name) => toolNames.has(name))) {
    lines.push("- For exploration, use read_file, glob, and grep instead of bash when they suffice.");
    lines.push("- Group independent read-only calls in one tool turn.");
  }
  if (toolNames.has("todo_write")) {
    lines.push("- For multi-step work, use todo_write; after an error, adjust rather than retrying the identical call.");
  } else if (toolNames.size > 0) {
    lines.push("- After a tool error, use the returned error to adjust rather than retrying the identical call.");
  }
  lines.push("- Before handoff, run focused tests or other relevant verification and report the result.");
  return lines.join("\n");
}

function planModeSection(enabled: boolean): string {
  if (enabled) {
    return "\n\nYou are in PLAN mode (read-only). Investigate with read-only tools, then output a step-by-step implementation plan and ask the user to switch to build mode to execute it.";
  }
  return "\n\nYou are in PLAN mode. Assess the available conversation context, output a step-by-step implementation plan, and ask the user to switch to build mode to execute it.";
}

function communicationSection(defaultLanguage: string): string {
  return [
    "\n\n## Communication",
    `- Respond in the user's language; use ${defaultLanguage} when the user has not indicated one. Use consistent Chinese terminology in Chinese replies.`,
    "- Keep updates brief and useful. Make final replies outcome-oriented; avoid filler, placeholders, and unnecessary explanation.",
  ].join("\n");
}

const SAFETY_BOUNDARY_SECTION = [
  "\n\n## Safety boundary",
  "- Stay within the workspace; do not access files outside it. Do not perform destructive or irreversible actions without the user's explicit approval.",
  "- Do not rewrite Git history, commit, push, send external messages, or otherwise change external systems without the user's explicit approval.",
].join("\n");

export class SteeringError extends Error {
  constructor(message: string, readonly code: "not_running" | "too_long" | "full") {
    super(message);
    this.name = "SteeringError";
  }
}

/** 编辑器保存被权限链拒绝（plan 只读门禁/用户拒绝）；REST 层映射为 403。 */
export class WorkspaceWriteDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceWriteDeniedError";
  }
}

/**
 * Lease supplied by the HTTP workspace gate for a managed-session run.
 *
 * An automatic VHDX/qcow2 checkpoint starts with the exclusive side of the
 * gate.  Once the short leaf-switch has finished, the route downgrades it to
 * a normal shared lease for the rest of the agent turn.  Keeping the gate
 * transition owned by app.ts makes it atomic with file/exec/sync routes.
 */
export interface ManagedWorkspaceRunLease {
  /** `false` means another workspace operation was already using the mount. */
  automaticSnapshotAllowed: boolean;
  /** Idempotently change an exclusive automatic-checkpoint lease to shared. */
  downgradeAfterAutomaticSnapshot?: () => void;
}

export interface AgentRunOptions {
  images?: Array<{ mediaType: string; data: string }>;
  /** 预组装的附件 text 块（app.ts 已读取+截断+包装为 `[Attachment <path>]\n<内容>`）；插入在 images 之后、正文之前 */
  attachments?: Array<{ text: string }>;
  /** app.ts managed-workspace shared/exclusive lease; absent for direct/test runs. */
  managedWorkspace?: ManagedWorkspaceRunLease;
  /** A durable follow-up queue entry which becomes applied when its user message is written. */
  queueItemId?: string;
}

/** 0.5.0 Phase 2d：run 级性能采样记录（脱敏：不含消息内容、文件路径、模型名）。 */
export interface RunPerfRecord {
  runId: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  turnCount: number;
  stages: {
    contextBuildMs: number;
    providerCallMs: number;
    toolExecMs: number;
    totalMs: number;
  };
}

const PERF_RING_SIZE = 20;

export class AgentRunner {
  private readonly running = new Map<string, AbortController>();
  private readonly coreGateway: CoreGateway;
  /** Active Run snapshots. Historical/latest snapshots live under sessions/<id>/runs/. */
  private readonly runs = new Map<string, AgentRunSnapshot>();
  /** Serialize per-run snapshots so a later state cannot overtake an earlier one on disk. */
  private readonly runWrites = new Map<string, Promise<void>>();
  /** Final assistant output is durable, but hooks/queue cleanup are not yet. */
  private readonly settling = new Set<string>();
  private readonly shells = new Map<string, AbortController>();
  /** 编辑器保存（REST 写）挂起态：与 run/shell 互斥，abort 时一并取消 */
  private readonly workspaceWrites = new Map<string, AbortController>();
  private readonly messageQueue: MessageQueue;
  private readonly interactions: InteractionCoordinator;
  private readonly repeatedCalls = new Map<string, { signature: string; count: number }>();
  private readonly mcpWarningSignatures = new Map<string, string>();
  /** 可编辑提示词覆盖：按 cwd 缓存一次，避免每轮 IO；首次构建时读取。 */
  private readonly promptOverrideCache = new Map<string, PromptOverride>();
  private readonly todos = new Map<string, TodoItem[]>();
  private readonly permissions: PermissionCoordinator;
  private readonly repoMap: RepoMapGenerator;
  private indexManager?: IndexManager;
  private diagnostics?: DiagnosticsService;
  /** 0.5.0 Phase 2d：per-session 性能环形缓冲（最近 20 次 run）。 */
  private readonly perfRecords = new Map<string, RunPerfRecord[]>();

  /** Phase 2：注入符号索引管理器；同时让 repo map 在索引可用时带符号摘要（不可用降级静态树）。 */
  setIndexManager(indexManager: IndexManager): void {
    this.indexManager = indexManager;
    this.repoMap.setSymbolProvider((cwd) => indexManager.symbolSummary(cwd));
  }

  /** Phase 3a：注入诊断服务，启用 test_runner 工具。 */
  setDiagnostics(diagnostics: DiagnosticsService): void {
    this.diagnostics = diagnostics;
  }

  private scm?: ScmService;

  /** Phase 4a：注入 SCM 服务，启用 git_status/git_diff/git_commit/git_worktree_* 工具。 */
  setScm(scm: ScmService): void {
    this.scm = scm;
  }

  /** 提示词覆盖更新后清空缓存，下次构建提示词时重新读取覆盖文件。 */
  refreshPromptOverride(): void {
    this.promptOverrideCache.clear();
  }

  private searchProvider: SearchProvider | undefined;
  private webFetchProvider: WebFetchProvider | undefined;

  constructor(
    private readonly sessions: SessionStore,
    private readonly providers: ProviderRegistry,
    private readonly core: CoreClientLike,
    private readonly events: EventBus,
    private readonly pricing: PricingCatalog,
    private readonly exchangeRates?: ExchangeRateService,
    private defaultLanguage = "zh-CN",
    private readonly maxTurns = 50,
    private readonly getProfile: (model: string, provider?: string) => ModelProfile = getModelProfile,
    private readonly usageLog?: UsageLog,
    private readonly skills?: SkillRegistry,
    private readonly mcp?: McpManager,
    private readonly compactor?: Compactor,
    private readonly dataDir?: string,
    private readonly agents?: AgentRegistry,
    private readonly commands?: CommandRegistry,
    search?: SearchProvider,
    _fetchImpl?: typeof fetch,
    private readonly backgroundTasks?: BackgroundTaskRegistry,
    private readonly hooks?: HookRunner,
    private readonly extensions?: ExtensionManager,
    webFetchProvider?: WebFetchProvider,
  ) {
    this.coreGateway = new CoreGateway(core);
    this.messageQueue = new MessageQueue((sessionId) => this.sessions.contextRoot(sessionId));
    this.interactions = new InteractionCoordinator((sessionId) => this.sessions.contextRoot(sessionId));
    this.permissions = new PermissionCoordinator(events);
    this.repoMap = new RepoMapGenerator(core);
    this.searchProvider = search;
    this.webFetchProvider = webFetchProvider;
    core.on("event", (event: CoreEvent) => {
      const payload = event.payload as
        | { execId?: string; stream?: string; data?: string; seq?: number }
        | undefined;
      const execution = payload?.execId ? this.executions.get(payload.execId) : undefined;
      if (
        event.type === "exec.output" &&
        execution &&
        payload?.stream &&
        payload.data &&
        typeof payload.seq === "number"
      ) {
        execution.output.push({ stream: payload.stream, data: payload.data, seq: payload.seq });
      }
      this.events.publish({
        source: "core",
        type: event.type,
        ...(execution ? { sessionId: execution.sessionId } : {}),
        payload: event.payload,
      });
    });
  }

  setDefaultLanguage(language: string): void {
    this.defaultLanguage = language;
  }

  /** Enables/disables web_fetch for future turns without restarting the server. */
  setWebFetchProvider(provider: WebFetchProvider | undefined): void {
    this.webFetchProvider = provider;
  }

  /** Enables/disables web_search for future turns without restarting the server. */
  setSearchProvider(provider: SearchProvider | undefined): void {
    this.searchProvider = provider;
  }

  async run(
    sessionId: string,
    text: string,
    options?: AgentRunOptions,
  ): Promise<void> {
    if (this.running.has(sessionId)) throw new Error("Session agent is already running");
    if (this.shells.has(sessionId)) throw new Error("A shell command is pending; respond to its permission request first");
    if (this.workspaceWrites.has(sessionId)) throw new Error("A file save is pending; respond to its permission request first");
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    let followUpQueueItemId = options?.queueItemId;
    let scheduleFollowUp = false;
    // 0.5.0 Phase 2d：性能采样累加器（声明在 try 外层，finally 可访问）
    let perfStartedAt = 0;
    let perfStartedAtIso = "";
    let perfContextBuildMs = 0;
    let perfProviderCallMs = 0;
    let perfToolExecMs = 0;
    let perfTurnCount = 0;
    let perfActive = false;
    try {
      const configuredSession = await this.sessions.get(sessionId);
      if (!configuredSession) throw new Error("Session not found");
      const appendUserMessage = async (message: string) => {
        return this.sessions.appendMessage(sessionId, "user", [
          ...(options?.images ?? []).map((image): MessageContent => ({ type: "image", mediaType: image.mediaType, data: image.data })),
          ...(options?.attachments ?? []).map((block): MessageContent => ({ type: "text", text: block.text })),
          { type: "text", text: message },
        ]);
      };
      // 输入框 /技能名 手动触发：展开为技能全文 + 用户补充（检查点标题仍用原文）。
      // 展开本身若意外失败，也先保留原始用户输入，避免 202 已确认的消息消失。
      let effectiveText: string;
      try {
        effectiveText = await this.expandSkillCommand(configuredSession.cwd, text);
      } catch (error) {
        await appendUserMessage(text);
        throw error;
      }

      const automaticSnapshotRequested = (configuredSession.snapshotMode ?? "auto") === "auto";
      // 每个后台任务都有独立 core/子进程，可能正以托管工作区为 cwd。换 VHDX/qcow2
      // 叶子会短暂卸载该目录，因此不能在它运行时自动快照；本轮对话继续，不阻塞用户。
      const backgroundTaskRunning = this.backgroundTasks?.hasRunningForSession(sessionId) ?? false;
      // app.ts 在进入 run 前原子地预留了独占 checkpoint lease。若工作区已经有
      // 文件/命令等 shared use，则它改为 shared lease，并让本轮安全地跳过自动快照。
      const workspaceBusyForAutomaticSnapshot = automaticSnapshotRequested
        && options?.managedWorkspace?.automaticSnapshotAllowed === false;
      const automaticSnapshot = automaticSnapshotRequested && !backgroundTaskRunning && !workspaceBusyForAutomaticSnapshot;
      // 若入口预留独占 lease 后才发现后台任务，或配置在 run 期间切换为手动模式，
      // 不等待本轮结束，立即降级为 shared lease，避免无谓阻塞文件浏览和命令执行。
      if (!automaticSnapshot) options?.managedWorkspace?.downgradeAfterAutomaticSnapshot?.();
      const snapshotMessageCount = configuredSession.messages.length;
      // 在用户消息写入前读取 ledger；实际镜像创建放到写入后，以保证任何快照/权限错误
      // 都不会吞掉已接受的消息。用户写入不改变 ledger 或工作区，因此仍是本轮前状态。
      const snapshotLedger = automaticSnapshot
        ? new ContextManager(this.sessions.contextRoot(sessionId)).load().then(
          (ledger) => ({ ledger }),
          (error: unknown) => ({ error }),
        )
        : undefined;

      // 一旦路由返回 202，用户输入优先于所有可失败的集成步骤（快照、Hook、Core、Provider）。
      const triggerMessage = await appendUserMessage(effectiveText);
      if (followUpQueueItemId) {
        const applied = await this.messageQueue.apply(sessionId, followUpQueueItemId, triggerMessage.id);
        if (!applied) throw new Error("Follow-up queue item disappeared while applying it");
        followUpQueueItemId = undefined;
        this.events.publish({ source: "agent", type: "queue.applied", sessionId, payload: applied });
      }
      await this.createRun(sessionId, triggerMessage.id);
      if (automaticSnapshotRequested && backgroundTaskRunning) {
        this.events.publish({
          source: "session",
          type: "checkpoint.failed",
          sessionId,
          payload: { message: "后台任务正在运行，已跳过自动快照；请等待任务结束后再创建手动快照。" },
        });
      } else if (workspaceBusyForAutomaticSnapshot) {
        this.events.publish({
          source: "session",
          type: "checkpoint.failed",
          sessionId,
          payload: { message: "工作区正在被文件或命令操作使用，已跳过自动快照；请等待操作结束后再创建手动快照。" },
        });
      }
      // UserPromptSubmit 钩子：仅通知不阻断（否决语义为 PreToolUse 专属）。
      await this.runNotificationHook("UserPromptSubmit", { sessionId, cwd: configuredSession.cwd, prompt: effectiveText.slice(0, 2000) });
      await this.core.configureSession({ sessionId, cwd: configuredSession.cwd, sandbox: configuredSession.sandbox ?? defaultSandboxPolicy(configuredSession.cwd) });
      if (automaticSnapshot) {
        await this.state(sessionId, "snapshotting");
        // 配置成功后再创建镜像，避免 Core 无法启动时留下无用的 VHD checkpoint；
        // 仍使用写入用户消息前捕获的 ledger/messageCount，恢复语义保持为本轮前状态。
        try {
          const prepared = await snapshotLedger!;
          if ("error" in prepared) throw prepared.error;
          const checkpoint = await (await getSnapshotBackend(this.sessions, configuredSession))
            .create(text.slice(0, 80) || "User message", snapshotMessageCount, prepared.ledger);
          this.events.publish({ source: "session", type: "checkpoint.created", sessionId, payload: checkpoint });
        } catch (error) {
          this.events.publish({
            source: "session",
            type: "checkpoint.failed",
            sessionId,
            payload: { message: error instanceof Error ? error.message : String(error) },
          });
        } finally {
          // 物理换叶已经结束（成功或已由 backend 回滚），后续 provider/tool 回合
          // 只需 shared lease；否则会把整个长对话错误地当成 checkpoint 临界区。
          options?.managedWorkspace?.downgradeAfterAutomaticSnapshot?.();
        }
      }
      await this.state(sessionId, "preparing_context");
      // 85% 水位强制概览压缩（§7.3 处理链⑤）：每次运行只触发一次
      let forceCompacted = false;
      // 0.5.0 Phase 2d：性能采样初始化
      perfStartedAt = performance.now();
      perfStartedAtIso = new Date().toISOString();
      perfActive = true;
      for (let turnIndex = 0; turnIndex < this.maxTurns; turnIndex++) {
        controller.signal.throwIfAborted();
        this.setTurnIndex(sessionId, turnIndex);
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const context = new ContextManager(this.sessions.contextRoot(sessionId));
        const budget = await context.budgetStatus();
        if (budget.paused) {
          await this.state(sessionId, "budget_paused");
          this.events.publish({ source: "agent", type: "agent.budget_paused", sessionId, payload: budget });
          return;
        }
        // 选择性上下文（§4.4）：pin 不被驱逐、排除不进组装；配置持久化在会话 meta。
        const contextSelection = { pins: session.contextPins ?? [], excludes: session.contextExcludes ?? [] };
        const ctxBuildStart = performance.now();
        const view = await context.buildView(session.messages, { selection: contextSelection });
        perfContextBuildMs += performance.now() - ctxBuildStart;
        if (this.extensions) {
          const transformed = await this.extensions.transformContext({
            sessionId,
            cwd: session.cwd,
            messages: view.messages,
            ledger: {
              round: view.ledger.round,
              entries: view.ledger.entries.map((entry) => ({ messageId: entry.messageId, state: entry.state, pinnedUntilRound: entry.pinnedUntilRound })),
              ...(view.ledger.compacted ? { compacted: { summary: view.ledger.compacted.summary, instructions: view.ledger.compacted.instructions } } : {}),
            },
          });
          view.messages = transformed.messages;
          if (transformed.metadata) this.events.publish({ source: "agent", type: "extension.context_transformed", sessionId, payload: transformed.metadata });
          const beforeSend = await this.extensions.beforeSend({
            sessionId,
            cwd: session.cwd,
            messages: view.messages,
            ledger: {
              round: view.ledger.round,
              entries: view.ledger.entries.map((entry) => ({ messageId: entry.messageId, state: entry.state, pinnedUntilRound: entry.pinnedUntilRound })),
              ...(view.ledger.compacted ? { compacted: { summary: view.ledger.compacted.summary, instructions: view.ledger.compacted.instructions } } : {}),
            },
          });
          view.messages = beforeSend.messages;
        }
        const cacheBreakpoints = selectCacheBreakpoints(view.messages, view.ledger);
        await context.recordCacheBreakpoints(cacheBreakpoints);
        // 断点策略写入 run 诊断：事件流可查，ledger.cacheBreakpoints 持久化供 Context 面板展示；
        // providerCaching 为 null 表示该 Provider 无显式断点（如 OpenAI 兼容的自动缓存）。
        this.events.publish({
          source: "agent",
          type: "context.cache_strategy",
          sessionId,
          payload: {
            provider: session.provider,
            providerCaching: this.providers.get(session.provider)?.promptCaching ?? null,
            messageBreakpoints: cacheBreakpoints,
          },
        });
        const profile = this.getProfile(session.model, session.provider);
        // 索引新鲜度（Phase 2 §4.1）：turn 边界检查。watch 激活时零成本；
        // watch 不可用时 mtime 抽样标滞后。失败/缺失都不阻断运行。
        if (this.indexManager) void this.indexManager.noteTurnBoundary(sessionId, session.cwd).catch(() => undefined);
        // repo map 预算段（§4.1 Phase 1）：默认开、会话可关；生成失败降级为空段，不阻断运行。
        // 注入位置在稳定 system 前缀之后的动态侧（systemSuffix），避免其逐 turn 变化污染
        // cache 断点；token 归因到 segments.repoMap，Context 面板按段可见。
        let repoMapSection = "";
        if (session.repoMapEnabled !== false) {
          try {
            const map = await this.repoMap.generate({
              sessionId,
              cwd: session.cwd,
              budget: session.repoMapBudget ?? DEFAULT_REPO_MAP_BUDGET,
              excludes: contextSelection.excludes,
            });
            view.stats.segments.repoMap = map.tokens;
            repoMapSection = `## Repository map (workspace structure; budget-bounded; key files carry symbol summaries when the index is available)\n${map.text}`;
          } catch (error) {
            this.events.publish({ source: "agent", type: "context.repo_map_failed", sessionId, payload: { message: error instanceof Error ? error.message : String(error) } });
          }
        }
        // 增量构建的 token 估算与 estimateMessageTokens 同规则；等价性由 server 测试断言。
        const estimatedTokens = view.stats.totalTokens;
        const workingBudget = Math.max(1, profile.contextWindow - profile.maxOutput);
        const utilization = estimatedTokens / workingBudget;
        // pin 占用如实上报：超预算时给明确警告，不悄悄驱逐 pin 的消息。
        const pinWarning = view.stats.pinnedTokens >= workingBudget ? "pins_over_budget" : undefined;
        this.events.publish({ source: "agent", type: "context.watermark", sessionId, payload: { estimatedTokens, contextWindow: profile.contextWindow, maxOutput: profile.maxOutput, workingBudget, utilization, warning: utilization >= 0.85 ? "force_compact" : utilization >= 0.7 ? "compact_recommended" : undefined, segments: view.stats.segments, pinnedTokens: view.stats.pinnedTokens, buildMs: view.stats.buildMs, incremental: view.stats.incremental, ...(pinWarning ? { pinWarning } : {}) } });
        // 85% 水位强制概览压缩：压缩成功后重建视图（消耗一个 turn 防止死循环）
        if (utilization >= 0.85 && this.compactor && !forceCompacted) {
          forceCompacted = true;
          try {
            const compacted = await this.compactor.compact(sessionId, "overview", { forced: true });
            if (compacted.changed) {
              this.events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: compacted.mode, uptoIndex: compacted.uptoIndex ?? 0, forced: true } });
              continue;
            }
          } catch (error) {
            // 压缩失败不阻断运行：记录后按未压缩视图继续
            this.events.publish({ source: "agent", type: "context.compact_failed", sessionId, payload: { message: error instanceof Error ? error.message : String(error) } });
          }
        }
        const provider = this.providers.get(session.provider);
        if (!provider) throw new Error(`Provider ${session.provider} is not configured`);

        // 模型不支持 function calling 时，绝不能下发工具 schema 或包含工具指令的系统提示。
        // 这不仅避免不支持 tools 的模型报错，也避免失真的 "可用工具" 提示诱导它返回 tool_call。
        const toolsEnabled = profile.capabilities.tools;

        // 技能/子代理目录只会在工具启用时进入本轮上下文。/skill 显式命令仍在 run 开头展开，
        // 因此不支持工具的模型仍可使用用户明确触发的技能内容。
        const skillCatalog = toolsEnabled && this.skills ? await this.skills.listFor(session.cwd) : [];
        const agentCatalog = toolsEnabled && this.agents ? await this.agents.listFor(session.cwd) : [];

        // MCP 连接可能包含外部进程/网络握手；模型不支持工具时不探测。配置加载等全局失败同样
        // 只能降级为本轮无 MCP 工具，不能打断已经接受的对话。
        let mcpBinding: { tools: ProviderTool[]; warnings: string[] } = { tools: [], warnings: [] };
        if (toolsEnabled && this.mcp) {
          try {
            mcpBinding = await this.mcp.toolsFor(session.cwd);
          } catch (error) {
            mcpBinding = {
              tools: [],
              warnings: [`MCP 工具发现失败，未注入：${error instanceof Error ? error.message : String(error)}`],
            };
          }
        }
        if (mcpBinding.warnings.length > 0) {
          const signature = mcpBinding.warnings.join("\n");
          if (this.mcpWarningSignatures.get(sessionId) !== signature) {
            this.mcpWarningSignatures.set(sessionId, signature);
            for (const message of mcpBinding.warnings) {
              this.events.publish({ source: "agent", type: "mcp.degraded", sessionId, payload: { message } });
            }
          }
        } else {
          this.mcpWarningSignatures.delete(sessionId);
        }

        // 扩展注册工具（ext__<extensionId>__<tool>）：注册表由 ExtensionManager 同步维护，
        // 仅含已启用扩展；host 断线时注册表已清空，本轮自然不注入。
        const extensionTools = toolsEnabled && this.extensions ? this.extensions.registeredTools() : [];

        const tools = toolsEnabled
          ? [
              ...builtInTools({
                skillsAvailable: skillCatalog.length > 0,
                backgroundTasksEnabled: Boolean(this.backgroundTasks),
                fetchAvailable: Boolean(this.webFetchProvider),
                searchAvailable: Boolean(this.searchProvider),
                shellBackend: session.shellBackend ?? "default",
              }),
              ...mcpBinding.tools,
              ...extensionTools,
            ]
          : [];
        const availableToolNames = new Set(tools.map((tool) => tool.name));
        const skillSection = availableToolNames.has("load_skill")
          ? `\n\nAvailable skills (load full text with the load_skill tool when relevant; the user can also trigger one with /name):\n${skillCatalog.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
          : "";
        const agentSection = availableToolNames.has("spawn_task") && agentCatalog.length > 0
          ? `\n\nAvailable sub-agents (pass agent=<name> to spawn_task; omit for the default read-only explorer):\n${agentCatalog.map((agent) => {
            const ignored = (agent.tools ?? []).filter((tool) => !(SUB_AGENT_TOOL_NAMES as readonly string[]).includes(tool));
            return `- ${agent.name}: ${agent.description}${ignored.length > 0 ? ` (unsupported tools ignored: ${ignored.join(", ")})` : ""}`;
          }).join("\n")}`
          : "";

        // 长期记忆注入（§2.3/§7.5）：CLAUDE.md/AGENTS.md + 项目/全局 memory.md，每轮现读
        const memorySection = await this.buildMemorySection(session.cwd);

        // 可编辑提示词覆盖：按 cwd 缓存一次（首次读取文件，后续复用）
        let promptOverride = this.promptOverrideCache.get(session.cwd);
        if (!promptOverride && this.dataDir) {
          promptOverride = await loadPromptOverride(this.dataDir, session.cwd);
          this.promptOverrideCache.set(session.cwd, promptOverride);
        }

        // 后台任务完成提示（读后即清）
        // 后台任务是工具能力的一部分；不支持工具的模型既不注入也不消费待发送通知。
        const bgNotices = toolsEnabled ? (this.backgroundTasks?.drainNotices(sessionId) ?? []) : [];
        const bgNoticeSection = bgNotices.length > 0 ? `\n\n${bgNotices.join("\n")}` : "";

        const system = buildSystemPrompt({
          cwd: session.cwd,
          tools,
          productSections: [
            workDisciplineSection(availableToolNames),
            communicationSection(this.defaultLanguage),
            session.agentMode === "plan" ? planModeSection(toolsEnabled) : "",
          ],
          finalConstraints: [SAFETY_BOUNDARY_SECTION],
          skillsSection: `${skillSection}${agentSection}`,
          projectContext: memorySection ? [{ path: "workspace instructions and memory", content: memorySection }] : [],
          ...(promptOverride ? { basePromptOverride: promptOverride.baseOverride, customAppend: promptOverride.customAppend } : {}),
        });
        await this.state(sessionId, "streaming");
        const providerCallStart = performance.now();
        const turn = await collectProviderTurn(
          provider,
          {
            model: session.model,
            ...(session.thinking ? { thinking: session.thinking } : {}),
            ...(session.effort ? { effort: session.effort } : {}),
            system,
            // 动态尾块（repo map 段 + 后台任务完成提示）独立于稳定 system 前缀下发，
            // 其逐 turn 变化不会污染稳定前缀的缓存断点。
            ...(repoMapSection || bgNoticeSection.trim()
              ? { systemSuffix: [repoMapSection, bgNoticeSection.trim()].filter(Boolean).join("\n\n") }
              : {}),
            messages: view.messages,
            cacheBreakpoints,
            tools,
            signal: controller.signal,
          },
          {
            onRetry: ({ attemptId, attempt, delayMs, error }) => {
              this.events.publish({
                source: "agent",
                type: "provider.retry",
                sessionId,
                payload: { attemptId, attempt, delayMs, kind: error.kind, message: error.message },
              });
            },
          },
        );
        this.events.publish({ source: "agent", type: "message.attempt", sessionId, payload: { attemptId: turn.attemptId } });
        perfProviderCallMs += performance.now() - providerCallStart;
        const assistantContent: MessageContent[] = [];
        let activeThinkingIndex: number | undefined;
        let stopReason: string | undefined;
        for (const event of turn.events) {
          if (event.type === "text_delta") {
            // Provider 文本以 token/chunk 形式流入。相邻分片属于同一段正文，
            // 落盘前合并，避免前端把每个分片当成独立块而逐词换行。
            const previous = assistantContent.at(-1);
            if (previous?.type === "text") previous.text = `${previous.text ?? ""}${event.text}`;
            else assistantContent.push({ type: "text", text: event.text });
            this.events.publish({ source: "agent", type: "message.delta", sessionId, payload: { text: event.text } });
          } else if (event.type === "thinking_delta") {
            const activeThinking = activeThinkingIndex === undefined ? undefined : assistantContent[activeThinkingIndex];
            if (activeThinking?.type === "thinking") {
              activeThinking.text = `${activeThinking.text ?? ""}${event.text}`;
            } else {
              assistantContent.push({ type: "thinking", text: event.text, provider: provider.name });
              activeThinkingIndex = assistantContent.length - 1;
            }
            this.events.publish({ source: "agent", type: "message.thinking_delta", sessionId, payload: { text: event.text } });
          } else if (event.type === "thinking_end") {
            const completedThinking: MessageContent = {
              type: "thinking",
              text: event.text,
              ...(event.signature ? { signature: event.signature } : {}),
              provider: provider.name,
            };
            if (activeThinkingIndex === undefined) assistantContent.push(completedThinking);
            else assistantContent[activeThinkingIndex] = completedThinking;
            activeThinkingIndex = undefined;
          } else if (event.type === "tool_call") {
            assistantContent.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
          } else if (event.type === "usage") {
            await this.recordUsageEvent(sessionId, context, session.provider, session.model, event);
          } else {
            stopReason = event.stopReason;
          }
        }
        if (assistantContent.length > 0) {
          await this.sessions.appendMessage(sessionId, "assistant", assistantContent, this.messageLineage(sessionId));
        }
        const toolCalls = assistantContent.filter((block) => block.type === "tool_call");
        // Some compatible providers have emitted tool_call blocks with a non-tool stop reason.
        // A persisted tool_call must always receive one matching tool_result; otherwise the next
        // request has an invalid conversation shape and can fail before a user-visible reply.
        if (toolCalls.length === 0 && stopReason !== "tool_use") {
          if (await this.applySteering(sessionId)) {
            await this.state(sessionId, "thinking");
            continue;
          }
          // Once output is durable, stop accepting steering.  A request in
          // this hook/cleanup window must receive a retryable 409 instead of
          // a 202 that would later be discarded by finally.
          this.settling.add(sessionId);
          await this.state(sessionId, "settling");
          try {
            // Stop 钩子：run 正常结束时通知（abort/error 路径不触发）。
            await this.runNotificationHook("Stop", { sessionId, cwd: session.cwd });
          } finally {
            this.settling.delete(sessionId);
          }
          scheduleFollowUp = true;
          return;
        }
        if (toolCalls.length === 0) throw new Error("Provider stopped for tool use without a tool call");
        await this.state(sessionId, "executing_tools");
        const toolExecStart = performance.now();
        for (const call of toolCalls) {
          let effectiveInput = call.input;
          let result: Extract<MessageContent, { type: "tool_result" }>;
          if (!availableToolNames.has(call.name)) {
            // Keep the plan-mode MCP safety boundary ahead of availability diagnostics: an
            // unadvertised MCP name is still opaque and must be described as read/write unknown.
            const externalLabel = call.name.startsWith("mcp__") ? "MCP 工具" : call.name.startsWith("ext__") ? "扩展工具" : undefined;
            const content = session.agentMode === "plan" && externalLabel
              ? `Plan 模式为只读：${externalLabel} ${call.name} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。`
              : toolsEnabled
                ? `Tool is not available in this turn: ${call.name}`
                : `Tool calls are disabled for the selected model: ${call.name}`;
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId: call.id, error: content } });
            result = { type: "tool_result", toolCallId: call.id, content, isError: true };
          } else {
            try {
              const extensionOutcome = this.extensions
                ? await this.extensions.beforeTool({ sessionId, cwd: session.cwd, tool: call.name, input: call.input })
                : { sessionId, cwd: session.cwd, tool: call.name, input: call.input };
              if (extensionOutcome.blocked) {
                result = { type: "tool_result", toolCallId: call.id, content: extensionOutcome.reason ?? "Blocked by extension", isError: true };
              } else {
                effectiveInput = extensionOutcome.input;
                const repeated = this.recordToolCall(sessionId, call.name, effectiveInput);
                if (repeated >= 3) {
                  const content = `Tool call blocked: ${call.name} was requested with identical arguments ${repeated} consecutive times.`;
                  this.events.publish({ source: "agent", type: "tool.repeated", sessionId, payload: { name: call.name, input: effectiveInput, count: repeated } });
                  result = { type: "tool_result", toolCallId: call.id, content, isError: true };
                } else {
                  const permission = await this.authorizeTool(sessionId, call.name, effectiveInput, controller.signal);
                  if (!permission.allowed) {
                    result = { type: "tool_result", toolCallId: call.id, content: permission.reason ?? "Tool permission denied", isError: true };
                  } else {
                    // PreToolUse 钩子：exit 2 否决 → 工具不执行，stderr 回填 LLM
                    const outcome = this.hooks
                      ? await this.hooks.run("PreToolUse", { sessionId, cwd: session.cwd, tool: call.name, input: effectiveInput })
                      : undefined;
                    result = outcome?.blocked
                      ? { type: "tool_result", toolCallId: call.id, content: outcome.reason ?? "Blocked by hook", isError: true }
                      : await this.executeTool(sessionId, call.name, call.id, effectiveInput, controller.signal);
                  }
                }
              }
            } catch (error) {
              // Abort 仍按原语义结束整个 run；其他前置工具失败必须回填给 provider，
              // 否则已落盘的 tool_call 会永久没有对应 tool_result。
              if (controller.signal.aborted) throw error;
              const content = error instanceof Error ? error.message : String(error);
              this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId: call.id, error: content } });
              result = { type: "tool_result", toolCallId: call.id, content, isError: true };
            }
          }
          await this.sessions.appendMessage(sessionId, "tool", [result], this.messageLineage(sessionId));
          // PostToolUse 钩子：仅写类工具成功后触发（format-on-write 等），不阻断
          if (!result.isError && ["write_file", "edit_file", "bash"].includes(call.name)) {
            const summary = result.content.slice(0, 300);
            await this.runNotificationHook("PostToolUse", { sessionId, cwd: session.cwd, tool: call.name, input: effectiveInput, result: { summary } });
          }
        }
        perfToolExecMs += performance.now() - toolExecStart;
        perfTurnCount++;
        await this.state(sessionId, "advancing_turn");
        await context.advanceRound();
        const afterTools = await this.sessions.get(sessionId);
        if (afterTools && (!this.extensions || this.extensions.isEnabled("context-manager"))) {
          await context.evict(afterTools.messages, new Set(afterTools.contextPins ?? []));
          this.events.publish({ source: "agent", type: "context.evicted", sessionId, payload: (await context.load()).entries });
        }
        await this.applySteering(sessionId);
        this.state(sessionId, "thinking");
      }
      throw new Error(`Agent exceeded ${this.maxTurns} turns`);
    } catch (error) {
      if (followUpQueueItemId) await this.messageQueue.requeue(sessionId, followUpQueueItemId);
      if (controller.signal.aborted) {
        this.events.publish({
          source: "agent",
          type: "agent.aborted",
          sessionId,
          payload: { message: "Agent run aborted" },
        });
        await this.finishRun(sessionId, "aborted", { code: "aborted", message: "Agent run aborted", retryable: false });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.events.publish({ source: "agent", type: "agent.error", sessionId, payload: { message } });
      await this.finishRun(sessionId, "failed", { code: "run_failed", message, retryable: false });
      throw error;
    } finally {
      this.settling.delete(sessionId);
      this.running.delete(sessionId);
      this.repeatedCalls.delete(sessionId);
      // abort 与正常结束都保留未消费队列；queue.json 是用户可恢复状态。
      this.todos.delete(sessionId);
      this.events.publish({ source: "agent", type: "todos.updated", sessionId, payload: { items: [] } });
      // 0.5.0 Phase 2d：发布 run.perf 事件并存入环形缓冲
      if (perfActive) {
        const runId = this.runs.get(sessionId)?.id ?? "unknown";
        const totalMs = performance.now() - perfStartedAt;
        const record: RunPerfRecord = {
          runId,
          sessionId,
          startedAt: perfStartedAtIso,
          finishedAt: new Date().toISOString(),
          turnCount: perfTurnCount,
          stages: {
            contextBuildMs: Math.round(perfContextBuildMs * 100) / 100,
            providerCallMs: Math.round(perfProviderCallMs * 100) / 100,
            toolExecMs: Math.round(perfToolExecMs * 100) / 100,
            totalMs: Math.round(totalMs * 100) / 100,
          },
        };
        this.events.publish({ source: "agent", type: "run.perf", sessionId, payload: record });
        const ring = this.perfRecords.get(sessionId) ?? [];
        ring.push(record);
        if (ring.length > PERF_RING_SIZE) ring.shift();
        this.perfRecords.set(sessionId, ring);
      }
      if (this.runs.has(sessionId)) await this.finishRun(sessionId, "completed");
      if (scheduleFollowUp && !controller.signal.aborted) void this.startFollowUp(sessionId);
    }
  }

  listTodos(sessionId: string): TodoItem[] {
    return [...(this.todos.get(sessionId) ?? [])];
  }

  listPendingPermissions(sessionId: string): Array<{ requestId: string; tool: string; input: Record<string, unknown> }> {
    return this.permissions.listPending(sessionId);
  }

  async preparePermissionResponse(sessionId: string, requestId: string, decision: PermissionDecision, reason?: string): Promise<(() => void) | undefined> {
    const response = this.permissions.respond(sessionId, requestId, decision, reason);
    if (!response) return undefined;
    try {
      if (response.persist) {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const rule = permissionRule(response.tool, response.input);
        const rules = [...(session.permissionRules ?? []).filter((item) => item.tool !== rule.tool || item.argumentPrefix !== rule.argumentPrefix), rule];
        await this.sessions.updatePermissions(sessionId, session.permissionMode ?? "ask", rules);
      }
      // 由 HTTP 层在批准响应完成后调用，避免工具执行抢在响应发送前开始。
      return () => response.complete();
    } catch (error) {
      response.complete(false, "Failed to persist permission rule");
      throw error;
    }
  }

  abort(sessionId: string): boolean {
    const controller = this.running.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.workspaceWrites.get(sessionId)?.abort();
    this.permissions.cancelSession(sessionId);
    return true;
  }

  /**
   * shell 快捷前缀 `!cmd`：走与 bash 工具相同的 authorizeTool 权限链 + core.run + boundToolResult 截断，
   * 但**不进 agent run 循环**（isRunning 全程 false）。落盘用户消息（`!cmd`）+ tool_result 一对，
   * 不触发 provider turn。
   *
   * 权限挂起复用现有 permission.request 事件 + respond 驱动机制：用独立 AbortController（不入 running Map），
   * respondPermission 路由驱动 permissions.request() 解析继续。run() 与 runShell() 通过 shells Map 互斥
   * （run() 开头检查 shells.has -> throw；shell 路由检查 isRunning -> 409）。
   *
   * PreToolUse/PostToolUse 钩子与 bash 工具一致触发（exit 2 否决 -> 错误 tool_result）。
   * 权限规则用 tool="bash" 复用现有 bash allow_always 规则（用户对 bash 的持久放行自动适用于 ! shell）。
   */
  async runShell(sessionId: string, cmd: string): Promise<void> {
    if (this.running.has(sessionId)) throw new Error("Session agent is running; wait for it to finish before running a shell command");
    if (this.shells.has(sessionId)) throw new Error("A shell command is already pending in this session");
    const controller = new AbortController();
    this.shells.set(sessionId, controller);
    const toolCallId = `shell-${randomUUID().slice(0, 8)}`;
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      // 先落盘 shell 请求；Core 配置/权限失败也必须让用户看得到原始命令和对应错误。
      // 保留 ! 前缀作为 shell 标记，便于前端「发给 agent」按钮识别配对。
      await this.sessions.appendMessage(sessionId, "user", [{ type: "text", text: `!${cmd}` }]);
      // 沙盒配置幂等（与 /files 路由同款）；不写 configuredSessions 缓存（app.ts 私有，重复配置无害）
      await this.core.configureSession({
        sessionId,
        cwd: session.cwd,
        sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd),
      });
      // 权限链（与 bash 工具一致；plan 模式会被门禁拦截）
      const permission = await this.authorizeTool(sessionId, "bash", { cmd }, controller.signal);
      if (!permission.allowed) {
        await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: permission.reason ?? "Shell command permission denied", isError: true }]);
        return;
      }
      // PreToolUse 钩子：exit 2 否决 -> 错误 tool_result
      if (this.hooks) {
        const outcome = await this.hooks.run("PreToolUse", { sessionId, cwd: session.cwd, tool: "bash", input: { cmd } });
        if (outcome.blocked) {
          await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: outcome.reason ?? "Blocked by hook", isError: true }]);
          return;
        }
      }
      const result = await this.executeBash(sessionId, cmd, toolCallId, controller.signal);
      await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: result.content, isError: result.isError }]);
      // PostToolUse 钩子：成功后触发（与 bash 工具一致，不阻断）
      if (!result.isError) {
        const summary = result.content.slice(0, 300);
        await this.runNotificationHook("PostToolUse", { sessionId, cwd: session.cwd, tool: "bash", input: { cmd }, result: { summary } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.publish({ source: "agent", type: "agent.error", sessionId, payload: { message } });
      // 尽力落盘错误 tool_result 防止丢失（appendMessage 自身失败则忽略）
      try {
        await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId, content: message, isError: true }]);
      } catch {
        // 二次落盘失败不再抛错
      }
    } finally {
      this.shells.delete(sessionId);
    }
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** REST snapshot source. An unfinished snapshot after a process restart is
   * explicitly failed: this runner cannot safely resume a half-completed tool
   * turn and must never report a phantom running agent. */
  async getRun(sessionId: string): Promise<AgentRunSnapshot | undefined> {
    const active = this.runs.get(sessionId);
    if (active) {
      // A REST snapshot must never acknowledge a state that has not reached
      // durable storage yet. State writers are serialized per session.
      await this.runWrites.get(sessionId);
      return { ...active, ...(active.error ? { error: { ...active.error } } : {}) };
    }
    const store = new RunStore(this.sessions.contextRoot(sessionId));
    const saved = await store.readLatest();
    if (!saved || ["completed", "failed", "aborted"].includes(saved.state)) return saved;
    const now = new Date().toISOString();
    const recovered: AgentRunSnapshot = {
      ...saved,
      state: "failed",
      since: now,
      settledAt: now,
      error: { code: "server_restarted", message: "The server restarted before this run reached a terminal state", retryable: true },
    };
    await store.write(recovered);
    return recovered;
  }

  /** shell 快捷前缀 `!cmd` 是否在挂起中（权限审批/执行中）；agent.isRunning 全程 false。 */
  isShellPending(sessionId: string): boolean {
    return this.shells.has(sessionId);
  }

  /** 0.5.0 Phase 2d：返回最近 N 次 run 的性能采样记录（内存环形缓冲，脱敏）。 */
  getPerf(sessionId: string): RunPerfRecord[] {
    return this.perfRecords.get(sessionId) ?? [];
  }

  /** 编辑器保存（REST 写）是否在挂起中。 */
  isWorkspaceWritePending(sessionId: string): boolean {
    return this.workspaceWrites.has(sessionId);
  }

  /**
   * 编辑器保存（0.5.0 Phase 1a）：REST 触发的工作区文件写入，复用与 write_file 工具
   * 完全相同的权限链（authorizeTool：plan 模式只读门禁 + 权限模式/规则 + permission.request
   * 事件挂起与 respond 恢复），不绕过任何审批；不落盘消息、不进 agent run 循环。
   * 与 run/shell 互斥（避免并发写竞态），abort 会取消挂起的审批。
   */
  async writeWorkspaceFile(sessionId: string, path: string, content: string, expectedSha256: string): Promise<void> {
    if (this.running.has(sessionId)) throw new Error("Session agent is running; wait for it to finish before saving files");
    if (this.shells.has(sessionId)) throw new Error("A shell command is pending; respond to its permission request first");
    if (this.workspaceWrites.has(sessionId)) throw new Error("A file save is already pending in this session");
    const controller = new AbortController();
    this.workspaceWrites.set(sessionId, controller);
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      // 沙盒配置幂等（与 runShell 同款）
      await this.core.configureSession({
        sessionId,
        cwd: session.cwd,
        sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd),
      });
      // 权限链（与 write_file 工具一致；plan 模式会被门禁拦截）
      const permission = await this.authorizeTool(sessionId, "write_file", { path }, controller.signal);
      if (!permission.allowed) throw new WorkspaceWriteDeniedError(permission.reason ?? "File write permission denied");
      await this.core.writeFile({ sessionId, path, content, expectedSha256 });
    } finally {
      this.workspaceWrites.delete(sessionId);
    }
  }

  async enqueueSteering(sessionId: string, content: string, requestId?: string): Promise<{ id: string; position: number; reused: boolean }> {
    if (!this.running.has(sessionId)) throw new SteeringError("Session agent is not running", "not_running");
    if (this.settling.has(sessionId)) throw new SteeringError("Session is settling; retry after it becomes idle", "not_running");
    if (content.length > MAX_STEERING_LENGTH) throw new SteeringError(`Steering message exceeds ${MAX_STEERING_LENGTH} characters`, "too_long");
    const queuedItems = await this.messageQueue.list(sessionId, "steer");
    if (queuedItems.filter((item) => item.status === "queued").length >= MAX_STEERING_ITEMS) throw new SteeringError("Steering queue is full", "full");
    const queued = await this.messageQueue.enqueue(sessionId, "steer", content, requestId);
    const payload = { ...queued.item, position: queued.position, reused: queued.reused };
    this.events.publish({ source: "agent", type: "queue.queued", sessionId, payload });
    this.events.publish({ source: "agent", type: "steering.queued", sessionId, payload });
    return { id: queued.item.id, position: queued.position, reused: queued.reused };
  }

  async enqueueFollowUp(sessionId: string, content: string, requestId?: string): Promise<{ id: string; position: number; reused: boolean }> {
    if (!this.running.has(sessionId)) throw new SteeringError("Session agent is not running", "not_running");
    if (content.length > MAX_STEERING_LENGTH) throw new SteeringError(`Follow-up message exceeds ${MAX_STEERING_LENGTH} characters`, "too_long");
    const queuedItems = await this.messageQueue.list(sessionId, "follow_up");
    if (queuedItems.filter((item) => item.status === "queued").length >= MAX_STEERING_ITEMS) throw new SteeringError("Follow-up queue is full", "full");
    const queued = await this.messageQueue.enqueue(sessionId, "follow_up", content, requestId);
    const payload = { ...queued.item, position: queued.position, reused: queued.reused };
    this.events.publish({ source: "agent", type: "queue.queued", sessionId, payload });
    return { id: queued.item.id, position: queued.position, reused: queued.reused };
  }

  async listSteering(sessionId: string): Promise<QueueItem[]> {
    return (await this.messageQueue.list(sessionId, "steer")).filter((item) => item.status === "queued");
  }
  async listQueue(sessionId: string): Promise<QueueItem[]> { return this.messageQueue.list(sessionId); }
  async updateQueue(sessionId: string, id: string, change: { content?: string; kind?: "steer" | "follow_up" }): Promise<QueueItem | undefined> {
    const item = await this.messageQueue.update(sessionId, id, change);
    if (item) this.events.publish({ source: "agent", type: "queue.updated", sessionId, payload: item });
    return item;
  }
  async removeQueue(sessionId: string, id: string): Promise<boolean> {
    const item = await this.messageQueue.cancel(sessionId, id);
    if (!item) return false;
    this.events.publish({ source: "agent", type: "queue.cancelled", sessionId, payload: { id: item.id, kind: item.kind } });
    return true;
  }

  async listInteractions(sessionId: string): Promise<InteractionRequest[]> { return this.interactions.list(sessionId); }
  async createInteraction(sessionId: string, input: { runId: string; toolCallId?: string; kind: InteractionKind; title: string; prompt: string; options?: Array<{ id: string; label: string; description?: string }> }): Promise<InteractionRequest> {
    const item = await this.interactions.create(sessionId, input);
    this.events.publish({ source: "agent", type: "interaction.requested", sessionId, runId: item.runId, payload: item });
    return item;
  }
  async respondInteraction(sessionId: string, id: string, answer: unknown): Promise<InteractionRequest | undefined> {
    const item = await this.interactions.answer(sessionId, id, answer);
    if (item) this.events.publish({ source: "agent", type: "interaction.answered", sessionId, payload: item });
    return item;
  }

  async removeSteering(sessionId: string, id: string): Promise<boolean> {
    const item = await this.messageQueue.cancel(sessionId, id);
    if (!item) return false;
    this.events.publish({ source: "agent", type: "queue.cancelled", sessionId, payload: { id: item.id, kind: item.kind } });
    this.events.publish({ source: "agent", type: "steering.removed", sessionId, payload: { id: item.id } });
    return true;
  }

  private async applySteering(sessionId: string): Promise<boolean> {
    const item = await this.messageQueue.take(sessionId, "steer");
    if (!item) return false;
    try {
      const message = await this.sessions.appendMessage(sessionId, "user", [{ type: "text", text: item.content }]);
      const applied = await this.messageQueue.apply(sessionId, item.id, message.id);
      if (!applied) throw new Error("Steering queue item disappeared while applying it");
      this.events.publish({ source: "agent", type: "queue.applied", sessionId, payload: applied });
      this.events.publish({ source: "agent", type: "steering.applied", sessionId, payload: applied });
      return true;
    } catch (error) {
      await this.messageQueue.requeue(sessionId, item.id);
      this.events.publish({ source: "agent", type: "queue.apply_failed", sessionId, payload: { id: item.id, kind: item.kind, message: error instanceof Error ? error.message : String(error) } });
      return false;
    }
  }

  private async startFollowUp(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    // Avoid creating queue.json for the overwhelmingly common no-follow-up path.
    // This also keeps a just-finished session from racing its caller's cleanup.
    if (!(await this.messageQueue.list(sessionId, "follow_up")).some((item) => item.status === "queued")) return;
    const item = await this.messageQueue.take(sessionId, "follow_up");
    if (!item) return;
    this.events.publish({ source: "agent", type: "queue.consuming", sessionId, payload: item });
    void this.run(sessionId, item.content, { queueItemId: item.id }).catch((error: unknown) => {
      this.events.publish({
        source: "agent",
        type: "queue.run_failed",
        sessionId,
        payload: { id: item.id, kind: item.kind, message: error instanceof Error ? error.message : String(error) },
      });
    });
  }

  private async authorizeTool(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
    const session = await this.sessions.get(sessionId);
    if (!session) return { allowed: false, reason: "Session not found" };
    // Plan 模式门禁：只读工具放行，其余一律拦截
    const PLAN_READONLY = new Set(["read_file", "glob", "grep", "read_artifact", "load_skill", "spawn_task", "spawn_swarm", "todo_write", "web_fetch", "web_search", "task_output", "repo_map", "code_search", "git_status", "git_diff"]);
    if (session.agentMode === "plan") {
      if (tool.startsWith("mcp__")) return { allowed: false, reason: `Plan 模式为只读：MCP 工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。` };
      if (tool.startsWith("ext__")) return { allowed: false, reason: `Plan 模式为只读：扩展工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。` };
      if (!PLAN_READONLY.has(tool)) return { allowed: false, reason: `Plan 模式为只读：${tool} 被拦截。请输出实施计划并请用户切换到 build 模式执行。` };
    }
    const mode = session.permissionMode ?? "ask";
    const rules = session.permissionRules ?? [];
    if (!this.permissions.needsApproval(mode, rules, tool, input)) return { allowed: true };
    this.state(sessionId, "waiting_permission");
    const result = await this.permissions.request(sessionId, tool, input, signal);
    this.state(sessionId, "tool_running");
    return { allowed: result.allowed, ...(result.reason ? { reason: result.reason } : {}) };
  }

  /** 非拦截型 Hook（用户提交、工具后、正常结束）绝不能让已接受的会话卡住。 */
  private async runNotificationHook(
    event: Exclude<HookEvent, "PreToolUse" | "SessionStart">,
    payload: HookPayload,
  ): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.run(event, payload);
    } catch (error) {
      this.events.publish({
        source: "server",
        type: "hook.failed",
        sessionId: payload.sessionId,
        payload: { event, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async expandSkillCommand(cwd: string, text: string): Promise<string> {
    const parsed = parseSkillCommand(text);
    if (!parsed) return text;
    const custom = this.commands ? await this.commands.find(cwd, parsed.name) : undefined;
    if (custom) return renderCommand(custom.body, parsed.rest);
    if (!this.skills) return text;
    const skill = await this.skills.find(cwd, parsed.name);
    if (!skill) return text;
    const request = parsed.rest !== "" ? parsed.rest : "Follow the skill instructions above.";
    return `[Skill "${skill.name}" — full text]\n${skill.body}\n\n[User request]\n${request}`;
  }

  /**
   * 长期记忆/项目约定注入（§2.3/§7.5）：host fs 直读 CLAUDE.md、AGENTS.md、
   * 项目 .owc/memory.md 与全局 <dataDir>/memory.md；每节独立标题、上限 8000 字符，
   * 读失败一律按不存在处理，绝不 throw 阻断 agent 循环。
   */
  private async buildMemorySection(cwd: string): Promise<string> {
    const sections: string[] = [];
    const add = (title: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed === "") return;
      const text = trimmed.length > MEMORY_SECTION_LIMIT ? `${trimmed.slice(0, MEMORY_SECTION_LIMIT)}…(truncated)` : trimmed;
      sections.push(`## ${title}\n${text}`);
    };
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      let body = "";
      try {
        body = await readFile(path.join(cwd, name), "utf8");
      } catch {
        // 不存在或不可读：跳过该节
      }
      add(name, body);
    }
    add("Project memory (.owc/memory.md)", await readProjectMemory(cwd));
    if (this.dataDir) add("Global memory", await readGlobalMemory(this.dataDir));
    return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
  }

  /**
   * mcp__ / ext__ 共用的外部工具执行路径：tool.start/end 事件、tool_running 状态、
   * boundToolResult 截断包装完全一致；差异仅在底层调用（MCP 连接 vs Extension Host IPC）。
   */
  private async executeExternalTool(
    sessionId: string,
    name: string,
    toolCallId: string,
    input: Record<string, unknown>,
    call: (cwd: string) => Promise<{ content: string; isError?: boolean }>,
  ): Promise<MessageContent & { type: "tool_result" }> {
    this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
    this.state(sessionId, "tool_running");
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      const result = await call(session.cwd);
      const isError = result.isError === true;
      const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, result.content);
      this.events.publish({
        source: "agent",
        type: "tool.end",
        sessionId,
        payload: { toolCallId, result: toolEventResult(bounded), isError },
      });
      return { type: "tool_result", toolCallId, content: bounded.content, isError };
    } catch (error) {
      const content = error instanceof Error ? error.message : String(error);
      this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
      return { type: "tool_result", toolCallId, content, isError: true };
    }
  }

  private async executeTool(
    sessionId: string,
    name: string,
    toolCallId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MessageContent & { type: "tool_result" }> {
    const execution = executionClass(name);
    this.events.publish({ source: "agent", type: "tool.scheduling", sessionId, payload: { toolCallId, name, execution, parallelEligible: execution === "read_only" } });
    if (name.startsWith("mcp__")) {
      const mcp = this.mcp;
      if (!mcp) {
        return { type: "tool_result", toolCallId, content: "MCP is not enabled on this server", isError: true };
      }
      return this.executeExternalTool(sessionId, name, toolCallId, input, (cwd) => mcp.callTool(cwd, name, input));
    }
    if (name.startsWith("ext__")) {
      const extensions = this.extensions;
      if (!extensions) {
        return { type: "tool_result", toolCallId, content: "Extension Host is not configured on this server", isError: true };
      }
      return this.executeExternalTool(sessionId, name, toolCallId, input, () => extensions.invokeTool(name, input));
    }
    if (name === "web_fetch" || name === "web_search") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        signal.throwIfAborted();
        let value: unknown;
        if (name === "web_fetch") {
          if (!this.webFetchProvider) throw new Error("Web fetch is not configured");
          const url = typeof input.url === "string" ? input.url.trim() : "";
          if (!url) throw new Error("web_fetch requires a non-empty url");
          value = await this.webFetchProvider.fetchUrl(url, { signal });
        } else {
          if (!this.searchProvider) throw new Error("Web search is not configured");
          const query = typeof input.query === "string" ? input.query.trim() : "";
          if (!query) throw new Error("web_search requires a non-empty query");
          const requested = input.limit === undefined ? 5 : Number(input.limit);
          if (!Number.isInteger(requested) || requested < 1) throw new Error("web_search limit must be a positive integer");
          value = await this.searchProvider.search(query, Math.min(requested, 10), { signal });
        }
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, JSON.stringify(value));
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "load_skill") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const skillName = String(input.name ?? "");
        const skill = this.skills ? await this.skills.find(session.cwd, skillName) : undefined;
        if (!skill) throw new Error(`Unknown skill: ${skillName || "(empty)"}`);
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, skill.body);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { name: skill.name, source: skill.source }, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "spawn_task") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      // catch 分支需引用（子代理启动后失败补发 subagent.finished），声明在 try 之外
      let taskId = "";
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const provider = this.providers.get(session.provider);
        if (!provider) throw new Error(`Provider ${session.provider} is not configured`);
        const prompt = String(input.prompt ?? "");
        if (!prompt) throw new Error("spawn_task requires a non-empty prompt");
        const agentName = typeof input.agent === "string" ? input.agent.trim() : "";
        const definition = agentName && this.agents ? await this.agents.find(session.cwd, agentName) : undefined;
        if (agentName && !definition) throw new Error(`Unknown sub-agent: ${agentName}`);
        const requestedTools = definition?.tools ?? (Array.isArray(input.tools) ? input.tools.map((item) => String(item)) : [...SUB_AGENT_TOOL_NAMES]);
        const toolNames = requestedTools.filter((tool) => (SUB_AGENT_TOOL_NAMES as readonly string[]).includes(tool));
        // 子代理期间不发布 message.delta/thinking_delta，避免污染主聊天流；
        // 子代理 token 经 onUsage 复用主循环记账路径，计入会话成本
        const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
        const result = await runSubAgent({
          provider,
          model: session.model,
          ...(definition?.model ? { modelOverride: definition.model } : {}),
          ...(definition ? { systemExtra: definition.body, agent: definition.name } : {}),
          prompt,
          toolNames,
          core: this.core,
          sessionId,
          cwd: session.cwd,
          contextRoot: this.sessions.contextRoot(sessionId),
          signal,
          onStart: (id) => {
            taskId = id;
            this.events.publish({
              source: "agent",
              type: "subagent.started",
              sessionId,
              payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), ...(definition ? { agent: definition.name } : {}) },
            });
          },
          onProgress: (progress) => {
            if (!taskId) return;
            this.events.publish({
              source: "agent",
              type: "subagent.progress",
              sessionId,
              payload: { toolCallId, taskId, turns: progress.turns, toolsUsed: progress.toolsUsed },
            });
          },
          onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, session.provider, definition?.model ?? session.model, usage),
        });
        this.events.publish({
          source: "agent",
          type: "subagent.finished",
          sessionId,
          payload: { toolCallId, taskId: result.taskId, status: "done", turns: result.turns, toolsUsed: result.toolsUsed },
        });
        this.events.publish({
          source: "agent",
          type: "tool.end",
          sessionId,
          payload: { toolCallId, result: { taskId: result.taskId, conclusion: result.conclusion, turns: result.turns, toolsUsed: result.toolsUsed } },
        });
        return { type: "tool_result", toolCallId, content: result.conclusion, isError: false, subagentTaskIds: [result.taskId] };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        // 子代理已启动后失败（含中断）：补发 finished，与 spawn_swarm 单项失败语义一致
        if (taskId) {
          this.events.publish({ source: "agent", type: "subagent.finished", sessionId, payload: { toolCallId, taskId, status: "failed", error: content } });
        }
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "spawn_swarm") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const provider = this.providers.get(session.provider);
        if (!provider) throw new Error(`Provider ${session.provider} is not configured`);
        const template = String(input.prompt_template ?? "");
        if (!template.includes("{{item}}")) throw new Error("spawn_swarm requires prompt_template to contain the {{item}} placeholder");
        // items 兼容两种形态：纯字符串，或 { task, agent? }（agent 覆盖本次调用的整体 agent）
        interface SwarmItemSpec { task: string; agent?: string }
        const items: SwarmItemSpec[] = (Array.isArray(input.items) ? input.items : []).map((raw) => {
          if (typeof raw === "string") return { task: raw };
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            const record = raw as Record<string, unknown>;
            const agent = typeof record.agent === "string" ? record.agent.trim() : "";
            return { task: String(record.task ?? ""), ...(agent ? { agent } : {}) };
          }
          return { task: String(raw) };
        });
        if (items.length < 2) throw new Error("spawn_swarm requires at least 2 items; for a single task use spawn_task");
        if (items.length > SPAWN_SWARM_MAX_ITEMS) throw new Error(`spawn_swarm supports at most ${SPAWN_SWARM_MAX_ITEMS} items (got ${items.length})`);
        if (items.some((item) => !item.task.trim())) throw new Error("spawn_swarm items require a non-empty task");
        const prompts = items.map((item) => template.split("{{item}}").join(item.task));
        if (new Set(prompts).size !== prompts.length) throw new Error("spawn_swarm items must produce distinct filled-in prompts");
        const agentName = typeof input.agent === "string" ? input.agent.trim() : "";
        const definition = agentName && this.agents ? await this.agents.find(session.cwd, agentName) : undefined;
        if (agentName && !definition) throw new Error(`Unknown sub-agent: ${agentName}`);
        // 预解析逐项 agent 覆盖：未知名称直接拒绝整次调用（与调用级 agent 一致）
        const itemDefinitions = new Map<number, AgentDefinition>();
        for (const [index, item] of items.entries()) {
          if (!item.agent) continue;
          const found = this.agents ? await this.agents.find(session.cwd, item.agent) : undefined;
          if (!found) throw new Error(`Unknown sub-agent: ${item.agent} (item ${index + 1})`);
          itemDefinitions.set(index, found);
        }
        const requestedTools = definition?.tools ?? [...SUB_AGENT_TOOL_NAMES];
        const toolNames = requestedTools.filter((tool) => (SUB_AGENT_TOOL_NAMES as readonly string[]).includes(tool));
        const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
        const contextRoot = this.sessions.contextRoot(sessionId);
        interface SwarmItemOutcome { ok: boolean; conclusion?: string; error?: string }
        const subagentTaskIds: string[] = [];
        const runOne = async (prompt: string, index: number): Promise<SwarmItemOutcome> => {
          const swarm = { index: index + 1, total: prompts.length };
          const effective = itemDefinitions.get(index) ?? definition;
          const effectiveTools = effective?.tools
            ? effective.tools.filter((tool) => (SUB_AGENT_TOOL_NAMES as readonly string[]).includes(tool))
            : toolNames;
          let taskId = "";
          try {
            const result = await runSubAgent({
              provider,
              model: session.model,
              ...(effective?.model ? { modelOverride: effective.model } : {}),
              ...(effective ? { systemExtra: effective.body, agent: effective.name } : {}),
              prompt,
              toolNames: effectiveTools,
              core: this.core,
              sessionId,
              cwd: session.cwd,
              contextRoot,
              signal,
              onStart: (id) => {
                taskId = id;
                subagentTaskIds[index] = id;
                this.events.publish({
                  source: "agent",
                  type: "subagent.started",
                  sessionId,
                  payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), swarm, ...(effective ? { agent: effective.name } : {}) },
                });
              },
              onProgress: (progress) => {
                if (!taskId) return;
                this.events.publish({
                  source: "agent",
                  type: "subagent.progress",
                  sessionId,
                  payload: { toolCallId, taskId, turns: progress.turns, toolsUsed: progress.toolsUsed, swarm },
                });
              },
              onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, session.provider, effective?.model ?? session.model, usage),
            });
            this.events.publish({
              source: "agent",
              type: "subagent.finished",
              sessionId,
              payload: { toolCallId, taskId: result.taskId, status: "done", turns: result.turns, toolsUsed: result.toolsUsed, swarm },
            });
            return { ok: true, conclusion: result.conclusion };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.events.publish({
              source: "agent",
              type: "subagent.finished",
              sessionId,
              payload: { toolCallId, taskId, status: "failed", error: message, swarm },
            });
            return { ok: false, error: message };
          }
        };
        // 并发上限内的 worker-pool：超出项排队，单项失败不拖垮整批（allSettled 语义）；
        // 中断后不再启动排队项（在途项经 signal 自然中止）
        const outcomes: SwarmItemOutcome[] = new Array(prompts.length) as SwarmItemOutcome[];
        let next = 0;
        const workers = Array.from({ length: Math.min(SPAWN_SWARM_CONCURRENCY, prompts.length) }, async () => {
          while (!signal.aborted && next < prompts.length) {
            const index = next;
            next += 1;
            outcomes[index] = await runOne(prompts[index]!, index);
          }
        });
        await Promise.all(workers);
        signal.throwIfAborted();
        const failed = outcomes.filter((outcome) => !outcome.ok).length;
        const aggregated = outcomes
          .map((outcome, index) => outcome.ok
            ? `[${index + 1}/${outcomes.length}] ${outcome.conclusion ?? ""}`
            : `[${index + 1}/${outcomes.length}] FAILED: ${outcome.error ?? "unknown error"}`)
          .join("\n\n");
        const bounded = await boundToolResult(contextRoot, name, aggregated);
        this.events.publish({
          source: "agent",
          type: "tool.end",
          sessionId,
          payload: { toolCallId, result: { total: outcomes.length, failed, ...toolEventResult(bounded) } },
        });
        return {
          type: "tool_result",
          toolCallId,
          content: bounded.content,
          isError: failed === outcomes.length,
          subagentTaskIds: subagentTaskIds.filter((id): id is string => typeof id === "string" && id.length > 0),
        };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "todo_write") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        if (!Array.isArray(input.items)) throw new Error("todo_write requires an items array");
        const items = input.items.map((raw): TodoItem => {
          if (!raw || typeof raw !== "object") throw new Error("Each todo item must be an object");
          const item = raw as Record<string, unknown>;
          const content = typeof item.content === "string" ? item.content.trim() : "";
          if (!content) throw new Error("Each todo item requires non-empty content");
          if (!(["pending", "in_progress", "done"] as const).includes(item.status as TodoItem["status"])) throw new Error(`Invalid todo status: ${String(item.status)}`);
          if (item.activeForm !== undefined && typeof item.activeForm !== "string") throw new Error("Todo activeForm must be a string");
          return { content, status: item.status as TodoItem["status"], ...(item.activeForm ? { activeForm: item.activeForm } : {}) };
        });
        this.todos.set(sessionId, items);
        this.events.publish({ source: "agent", type: "todos.updated", sessionId, payload: { items } });
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { count: items.length } } });
        return { type: "tool_result", toolCallId, content: `Task list replaced (${items.length} item(s)).`, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "remember") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const fact = String(input.fact ?? "").trim();
        if (!fact) throw new Error("remember requires a non-empty fact");
        // 写入路径固定两处，不接受任意路径；dataDir 未注入时全局记忆不可用
        const scope = input.scope === "global" ? "global" : "project";
        const target = scope === "global"
          ? (this.dataDir ? path.join(this.dataDir, "memory.md") : undefined)
          : path.join(session.cwd, ".owc", "memory.md");
        if (!target) throw new Error("Global memory is not available: server data directory is not configured");
        const { appended } = await appendMemory(target, [fact]);
        const content = appended > 0
          ? `Remembered in ${scope} memory (${target}): ${appended} fact(s) appended.`
          : `Fact already present in ${scope} memory (${target}); nothing appended.`;
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { scope, path: target, appended } } });
        return { type: "tool_result", toolCallId, content, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "read_artifact") {
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const manager = new ContextManager(this.sessions.contextRoot(sessionId));
        const content = await manager.readArtifact(
          String(input.artifactId),
          Number(input.offset),
          Number(input.limit),
        );
        return { type: "tool_result", toolCallId, content, isError: false };
      } catch (error) {
        return { type: "tool_result", toolCallId, content: error instanceof Error ? error.message : String(error), isError: true };
      }
    }
    if (name === "repo_map") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (input.budget !== undefined && (!Number.isInteger(Number(input.budget)) || Number(input.budget) < 64)) {
          throw new Error("repo_map budget must be an integer >= 64");
        }
        // 与自动注入共用同一生成器/缓存；显式调用不受会话自动注入开关影响。
        const map = await this.repoMap.generate({
          sessionId,
          cwd: session.cwd,
          budget: input.budget === undefined ? (session.repoMapBudget ?? DEFAULT_REPO_MAP_BUDGET) : Number(input.budget),
          excludes: session.contextExcludes ?? [],
        });
        // 大预算结果经 boundToolResult artifact 化，超预算部分可从 artifact 续读
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, map.text);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded), truncated: map.truncated || bounded.truncated } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "test_runner") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (!this.diagnostics) throw new Error("Diagnostics service is not enabled on this server.");
        const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : undefined;
        // Run 轨道子节点：agentRunId 挂当前 run；diagnostics.updated 事件与 artifact 均带该归属
        const agentRunId = this.runs.get(sessionId)?.id;
        const { record, feedback } = await this.diagnostics.run(sessionId, session.cwd, {
          ...(command ? { command } : {}),
          ...(agentRunId ? { agentRunId } : {}),
          signal,
          shellBackend: session.shellBackend ?? "default",
        });
        this.events.publish({
          source: "agent",
          type: "tool.end",
          sessionId,
          payload: { toolCallId, result: { runId: record.runId, summary: record.diagnostics.summary, parseFallback: record.parseFallback, repeatedSignatureCount: record.repeatedSignatureCount } },
        });
        return { type: "tool_result", toolCallId, content: feedback, isError: false };
      } catch (error) {
        if (signal.aborted) throw error;
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "git_status" || name === "git_diff" || name === "git_commit" || name === "git_worktree_create" || name === "git_worktree_remove" || name === "git_worktree_merge") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (!this.scm) throw new Error("SCM service is not enabled on this server.");
        const context = { shellBackend: session.shellBackend ?? "default", signal };
        let text: string;
        let eventResult: Record<string, unknown>;
        if (name === "git_status") {
          const status = await this.scm.status(sessionId, session.cwd, context);
          if (!status.isRepo) throw new Error("Session workspace is not a git repository");
          const totals = status.totals;
          text = [
            `Branch: ${status.branch ?? "(unknown)"}${status.upstream ? ` tracking ${status.upstream}` : ""} (ahead ${status.ahead ?? 0}, behind ${status.behind ?? 0})`,
            `Staged (${totals.staged}):`,
            ...status.staged.map((entry) => `  ${entry.code} ${entry.path}`),
            `Unstaged (${totals.unstaged}):`,
            ...status.unstaged.map((entry) => `  ${entry.code} ${entry.path}`),
            `Untracked (${totals.untracked}):`,
            ...status.untracked.map((entry) => `  ${entry.path}`),
            ...(status.truncated ? [`(output truncated per group at 200 entries; totals above are exact)`] : []),
          ].join("\n");
          eventResult = { branch: status.branch, ahead: status.ahead, behind: status.behind, totals, truncated: status.truncated };
        } else if (name === "git_diff") {
          const options = {
            ...(input.staged !== undefined ? { staged: Boolean(input.staged) } : {}),
            ...(typeof input.base === "string" && input.base.trim() ? { base: input.base.trim() } : {}),
            ...(typeof input.file === "string" && input.file.trim() ? { file: input.file.trim() } : {}),
          };
          if (options.staged && options.base) throw new Error("git_diff staged and base are mutually exclusive");
          const diff = await this.scm.diff(sessionId, session.cwd, options, context);
          if (!diff.isRepo) throw new Error("Session workspace is not a git repository");
          text = diff.truncated
            ? `Diff is ${diff.totalBytes} bytes (over the inline limit); showing stat only. Full diff is in artifact:${diff.artifactId} (use read_artifact).\n\n${diff.stat}`
            : (diff.diff ?? "") === ""
              ? "No changes."
              : `${diff.stat}\n${diff.diff}`;
          eventResult = { totalBytes: diff.totalBytes, truncated: diff.truncated, ...(diff.artifactId ? { artifactId: diff.artifactId } : {}) };
        } else if (name === "git_commit") {
          const result = await this.scm.commit(sessionId, session.cwd, {
            message: String(input.message ?? ""),
            ...(input.stageAll !== undefined ? { stageAll: Boolean(input.stageAll) } : {}),
            ...(Array.isArray(input.files) ? { files: input.files.map((item) => String(item)) } : {}),
          }, context);
          const totals = result.status.totals;
          text = `Committed ${result.commit.slice(0, 12)}: ${result.subject}\nPost-commit status: branch ${result.status.branch ?? "(unknown)"}, staged ${totals.staged}, unstaged ${totals.unstaged}, untracked ${totals.untracked}.`;
          eventResult = { commit: result.commit, subject: result.subject, totals };
        } else if (name === "git_worktree_create") {
          const entry = await this.scm.createWorktree(sessionId, session.cwd, {
            ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
            ...(typeof input.branch === "string" && input.branch.trim() ? { branch: input.branch.trim() } : {}),
          }, context);
          text = `Worktree created: ${entry.name}\nPath: ${entry.path}\nBranch: ${entry.branch}\nMerge back explicitly with git_worktree_merge; worktrees are not auto-deleted.`;
          eventResult = { name: entry.name, path: entry.path, branch: entry.branch };
        } else if (name === "git_worktree_remove") {
          const result = await this.scm.removeWorktree(sessionId, session.cwd, String(input.name ?? ""), { force: Boolean(input.force) }, context);
          text = `Worktree removed: ${result.name}`;
          eventResult = result;
        } else {
          const result = await this.scm.mergeWorktree(sessionId, session.cwd, String(input.name ?? ""), {
            strategy: input.strategy === "cherry-pick" ? "cherry-pick" : "merge",
          }, context);
          text = result.merged
            ? `Merged worktree branch ${result.branch} into the workspace (${result.strategy}).`
            : `Merge of ${result.branch} reported conflicts and was aborted (no auto-resolution). Conflicting files:\n${result.conflicts.map((file) => `  ${file}`).join("\n") || "  (none listed)"}`;
          eventResult = result as unknown as Record<string, unknown>;
        }
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: eventResult } });
        return { type: "tool_result", toolCallId, content: text, isError: false };
      } catch (error) {
        if (signal.aborted) throw error;
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "code_search") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (!this.indexManager) throw new IndexUnavailableError("Symbol index is not enabled on this server.");
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) throw new Error("code_search requires a non-empty query");
        const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : undefined;
        const limit = input.limit === undefined ? undefined : Number(input.limit);
        const hits = await this.indexManager.searchSymbols(session.cwd, query, { ...(kind ? { kind } : {}), ...(limit !== undefined ? { limit } : {}) });
        // 输出为紧凑文本行：file:line kind name — signature；结果可 artifact 化（§4.1）
        const text = hits.length === 0
          ? `No symbols matching "${query}"${kind ? ` (kind=${kind})` : ""}. Try a broader query, or fall back to grep/glob.`
          : hits.map((hit) => `${hit.path}:${hit.startLine}\t${hit.kind}\t${hit.name}\t${hit.signature}`).join("\n");
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, text);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded), truncated: bounded.truncated } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        // 索引未建/损坏：明确指引 agent 退回 grep/glob，不自动触发重建（重建是显式动作）
        const content = error instanceof IndexUnavailableError
          ? `${error.message} Fall back to grep/glob for navigation.`
          : error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (FILE_TOOLS.some((tool) => tool.name === name)) {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const path = typeof input.path === "string" ? input.path : "";
        if (!path) throw new Error(`${name} requires a non-empty path`);
        let value: unknown;
        if (name === "read_file") value = await this.core.readFile({ sessionId, path, ...(input.offset === undefined ? {} : { offset: Number(input.offset) }), ...(input.limit === undefined ? {} : { limit: Number(input.limit) }) });
        else if (name === "write_file") value = await this.core.writeFile({ sessionId, path, content: String(input.content ?? ""), ...(input.createDirs === undefined ? {} : { createDirs: Boolean(input.createDirs) }) });
        else if (name === "edit_file") value = await this.core.editFile({ sessionId, path, oldText: String(input.oldText ?? ""), newText: String(input.newText ?? ""), ...(input.replaceAll === undefined ? {} : { replaceAll: Boolean(input.replaceAll) }) });
        else if (name === "glob") value = await this.core.globFiles({ sessionId, path, pattern: String(input.pattern ?? "") });
        else value = await this.core.grepFiles({ sessionId, path, pattern: String(input.pattern ?? "") });
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, JSON.stringify(value));
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "task_output") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const taskId = String(input.taskId ?? "");
        if (!taskId) throw new Error("task_output requires a non-empty taskId");
        const block = Boolean(input.block);
        const timeoutMs = Math.min(Number(input.timeoutMs) || 30000, 30000);
        if (!this.backgroundTasks) throw new Error("Background tasks are not enabled");
        if (block) {
          const deadline = Date.now() + timeoutMs;
          const poll = async (): Promise<ReturnType<BackgroundTaskRegistry["get"]>> => {
            const entry = this.backgroundTasks!.get(taskId);
            if (!entry) throw new Error(`Task not found: ${taskId}`);
            if (entry.status !== "running") return entry;
            if (Date.now() >= deadline) return entry;
            await new Promise((resolve) => setTimeout(resolve, 250));
            return poll();
          };
          const result = await poll();
          const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, JSON.stringify(result));
          this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
          return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
        }
        const entry = this.backgroundTasks.get(taskId);
        if (!entry) throw new Error(`Task not found: ${taskId}`);
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, JSON.stringify(entry));
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "task_stop") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const taskId = String(input.taskId ?? "");
        if (!taskId) throw new Error("task_stop requires a non-empty taskId");
        if (!this.backgroundTasks) throw new Error("Background tasks are not enabled");
        const stopped = await this.backgroundTasks.stop(taskId);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { stopped } } });
        return { type: "tool_result", toolCallId, content: JSON.stringify({ stopped }), isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name !== "bash" || typeof input.cmd !== "string" || !input.cmd) {
      return { type: "tool_result", toolCallId, content: `Unsupported or invalid tool call: ${name}`, isError: true };
    }

    // 后台 bash：独立 core 进程，不阻塞主循环
    if (input.run_in_background) {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        if (!this.backgroundTasks) throw new Error("后台任务未启用");
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (session.sandboxMode === "wsb") throw new Error("WSB 沙盒模式不支持后台 bash");
        if (session.workspace?.mode === "managed") throw new Error("托管工作区不支持后台 bash");
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        await this.backgroundTasks.start({
          sessionId,
          taskId,
          cmd: input.cmd,
          cwd: session.cwd,
          // 后台任务语义是长时间运行：独立 core 连接，10 分钟超时（core-client RPC 超时随之为 610s，不再 ~130s 杀连接）
          timeoutMs: 10 * 60_000,
          shellBackend: session.shellBackend ?? "default",
        });
        const result = { taskId, status: "started" as const };
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result } });
        return { type: "tool_result", toolCallId, content: JSON.stringify(result), isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }

    const bashResult = await this.executeBash(sessionId, input.cmd, toolCallId, signal);
    return { type: "tool_result", toolCallId, content: bashResult.content, isError: bashResult.isError };
  }

  /**
   * 前台 bash 执行（runShell 与 executeTool 的 bash 分支共用）：
   * core.run + exec.output 推送收集 + boundToolResult 截断。
   * 失败转成 isError=true 返回，不抛错（调用方负责落盘 tool_result）。
   */
  private async executeBash(
    sessionId: string,
    cmd: string,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    signal.throwIfAborted();
    const execId = `${sessionId}:${randomUUID()}`;
    const execution: ExecutionContext = { sessionId, output: [] };
    this.executions.set(execId, execution);
    this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name: "bash", input: { cmd }, execId } });
    this.state(sessionId, "tool_running");
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      if (await this.coreGateway.supports("jobControl")) {
        const jobId = `job-${randomUUID()}`;
        const output: Array<{ stream: "stdout" | "stderr"; data: string; seq: number }> = [];
        let afterSeq = 0;
        const cancel = () => { void this.core.cancelJob({ sessionId, jobId }).catch(() => undefined); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          // jobControl 路径本身无 RPC 超时兜底：给 core 侧 10 分钟上限，轮询循环遇 timed_out 终止
          await this.core.startJob({ sessionId, jobId, kind: "exec", cmd, cwd: session.cwd, timeoutMs: 10 * 60_000, shellBackend: session.shellBackend ?? "default" });
          for (;;) {
            const page = await this.core.jobOutput({ sessionId, jobId, afterSeq, limit: 128 });
            output.push(...page.chunks);
            afterSeq = page.nextSeq;
            const status = await this.core.jobStatus({ sessionId, jobId });
            if (status.state === "running") {
              await new Promise<void>((resolve) => setTimeout(resolve, 50));
              continue;
            }
            // Drain chunks produced between the last poll and terminal state.
            const tail = await this.core.jobOutput({ sessionId, jobId, afterSeq, limit: 128 });
            output.push(...tail.chunks);
            if (signal.aborted) signal.throwIfAborted();
            if (status.state === "cancelled" || status.state === "timed_out" || status.state === "failed") {
              throw new Error(status.error ?? `Job ${status.state}`);
            }
            const decoded = decodeProcessOutputChunks(output);
            const rawContent = JSON.stringify({ ...status, output: decoded, outputTruncated: page.truncated || tail.truncated });
            const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), "bash", rawContent);
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
            return { content: bounded.content, isError: false };
          }
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      }
      const result = await this.core.run({ sessionId, execId, cmd, cwd: session.cwd, shellBackend: session.shellBackend ?? "default" });
      const output = decodeProcessOutputChunks(execution.output);
      const rawContent = JSON.stringify({ ...result, output });
      const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), "bash", rawContent);
      // 事件只发摘要 + artifact 引用（0.3.x 规约）；完整输出走 artifact/session 读取路径。
      this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
      return { content: bounded.content, isError: false };
    } catch (error) {
      if (signal.aborted) throw error;
      const content = error instanceof Error ? error.message : String(error);
      this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
      return { content, isError: true };
    } finally {
      this.executions.delete(execId);
    }
  }

  // 用量记账：主循环与 spawn_task 子代理共用同一 ledger/用量日志/事件路径
  private async recordUsageEvent(
    sessionId: string,
    context: ContextManager,
    providerName: string,
    model: string,
    event: Extract<ProviderEvent, { type: "usage" }>,
  ): Promise<void> {
    const usageCost = calculateUsageCost(event, this.pricing.get(providerName, model), this.exchangeRates?.current());
    const recordedCost = {
      priced: usageCost.priced,
      ...(usageCost.source ? { source: { currency: usageCost.source.currency, microUnits: usageCost.source.microUnits.toString() } } : {}),
      ...(usageCost.usd ? { usdMicroUnits: usageCost.usd.microUnits.toString() } : {}),
      ...(usageCost.cny ? { cnyMicroUnits: usageCost.cny.microUnits.toString() } : {}),
      ...(usageCost.exchangeRate ? {
        exchangeRate: {
          rate: usageCost.exchangeRate.rate.toString(),
          source: usageCost.exchangeRate.source,
          effectiveDate: usageCost.exchangeRate.effectiveDate,
          fetchedAt: usageCost.exchangeRate.fetchedAt,
        },
      } : {}),
    };
    const ledger = await context.recordUsage(event, recordedCost);
    // 全局用量日志（成本报表数据源）：失败只记 stderr，不阻断会话
    void this.usageLog?.record({
      at: new Date().toISOString(),
      sessionId,
      provider: providerName,
      model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheRead: event.cacheRead,
      cacheWrite: event.cacheWrite,
      priced: usageCost.priced,
      ...(usageCost.usd ? { usdMicroUnits: usageCost.usd.microUnits.toString() } : {}),
      ...(usageCost.cny ? { cnyMicroUnits: usageCost.cny.microUnits.toString() } : {}),
    }).catch((error: unknown) => {
      process.stderr.write(`[usage-log] 写入失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
    this.events.publish({
      source: "agent",
      type: "context.usage",
      sessionId,
      payload: {
        ...event,
        cost: {
          priced: usageCost.priced,
          ...(usageCost.source ? { source: { currency: usageCost.source.currency, amount: usageCost.source.amount } } : {}),
          ...(usageCost.usd ? { usd: usageCost.usd.amount } : {}),
          ...(usageCost.cny ? { cny: usageCost.cny.amount } : {}),
        },
        sessionCost: ledger.cost,
      },
    });
  }

  private recordToolCall(sessionId: string, name: string, input: Record<string, unknown>): number {
    const signature = `${name}:${stableStringify(input)}`;
    const previous = this.repeatedCalls.get(sessionId);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    this.repeatedCalls.set(sessionId, { signature, count });
    return count;
  }

  private readonly executions = new Map<string, ExecutionContext>();

  private async createRun(sessionId: string, triggerMessageId: string): Promise<void> {
    const now = new Date().toISOString();
    const run: AgentRunSnapshot = {
      id: randomUUID(),
      sessionId,
      triggerMessageId,
      state: "accepted",
      turnIndex: 0,
      startedAt: now,
      since: now,
    };
    this.runs.set(sessionId, run);
    await this.writeRun(sessionId, run, true);
    this.events.publish({ source: "agent", type: "run.accepted", sessionId, runId: run.id, payload: { ...run } });
    await this.state(sessionId, "starting");
  }

  private setTurnIndex(sessionId: string, turnIndex: number): void {
    const run = this.runs.get(sessionId);
    if (!run || run.turnIndex === turnIndex) return;
    run.turnIndex = turnIndex;
    this.queueRunWrite(sessionId, run, false);
  }

  /** Keep new agent output attributable to one durable run/turn without rewriting older history. */
  private messageLineage(sessionId: string): { runId?: string; turnId?: string } {
    const run = this.runs.get(sessionId);
    return run ? { runId: run.id, turnId: `${run.id}:${run.turnIndex}` } : {};
  }

  /** Map legacy transient names to the persisted Run state machine. */
  private state(sessionId: string, requested: string): Promise<void> {
    const state: AgentRunState | undefined = ({
      thinking: "preparing_context",
      tool_running: "executing_tools",
      waiting_permission: "waiting_permission",
      settling: "settling",
      budget_paused: "budget_paused",
      starting: "starting",
      snapshotting: "snapshotting",
      preparing_context: "preparing_context",
      streaming: "streaming",
      executing_tools: "executing_tools",
      advancing_turn: "advancing_turn",
    } as Record<string, AgentRunState>)[requested];
    const run = this.runs.get(sessionId);
    if (!run || !state) {
      this.events.publish({ source: "agent", type: "agent.state", sessionId, payload: { state: requested } });
      return Promise.resolve();
    }
    run.state = state;
    run.since = new Date().toISOString();
    const write = this.writeRun(sessionId, run, true);
    void write.catch((error) => {
      this.events.publish({
        source: "agent",
        type: "run.persistence_failed",
        sessionId,
        runId: run.id,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    });
    return write;
  }

  private async finishRun(
    sessionId: string,
    state: Extract<AgentRunState, "completed" | "failed" | "aborted">,
    error?: AgentRunSnapshot["error"],
  ): Promise<void> {
    const run = this.runs.get(sessionId);
    if (!run) return;
    const now = new Date().toISOString();
    run.state = state;
    run.since = now;
    run.settledAt = now;
    if (error) run.error = error;
    await this.writeRun(sessionId, run, true);
    this.events.publish({ source: "agent", type: `run.${state}`, sessionId, runId: run.id, payload: { ...run } });
    // Keep the legacy UI/CLI completion signal while REST snapshots expose the
    // terminal state above. This event intentionally does not mutate the Run.
    this.events.publish({ source: "agent", type: "agent.state", sessionId, runId: run.id, payload: { state: "idle" } });
    this.runs.delete(sessionId);
    this.runWrites.delete(sessionId);
  }

  private queueRunWrite(sessionId: string, run: AgentRunSnapshot, publishState: boolean): void {
    void this.writeRun(sessionId, run, publishState).catch((error) => {
      this.events.publish({
        source: "agent",
        type: "run.persistence_failed",
        sessionId,
        runId: run.id,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    });
  }

  private async writeRun(sessionId: string, run: AgentRunSnapshot, publishState: boolean): Promise<void> {
    const snapshot = { ...run, ...(run.error ? { error: { ...run.error } } : {}) };
    const previous = this.runWrites.get(sessionId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await new RunStore(this.sessions.contextRoot(sessionId)).write(snapshot);
      if (publishState) {
        this.events.publish({
          source: "agent",
          type: "agent.state",
          sessionId,
          runId: snapshot.id,
          payload: { runId: snapshot.id, state: snapshot.state, turnIndex: snapshot.turnIndex, since: snapshot.since },
        });
      }
    });
    this.runWrites.set(sessionId, write);
    await write;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
