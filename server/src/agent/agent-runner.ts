import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CoreClientLike, CoreEvent } from "../core-client.js";
import { CoreGateway } from "../core-gateway.js";
import type { EventBus } from "../events/event-bus.js";
import { ContextManager, selectCacheBreakpoints } from "../context/context-manager.js";
import type { Compactor } from "../context/compactor.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { errorMessage } from "../error-utils.js";
import { RepoMapGenerator, DEFAULT_REPO_MAP_BUDGET } from "../context/repo-map.js";
import { IndexManager, IndexUnavailableError } from "../index/index-manager.js";
import type { DiagnosticsService } from "../diagnostics/service.js";
import type { ScmService } from "../scm/service.js";
import { getModelProfile, type ModelProfile } from "../context/model-profile.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { ExchangeRateService } from "../cost/exchange-rate.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import type { Provider, ProviderRegistry, ProviderTool, ProviderEvent } from "../providers/provider.js";
import { ProviderError } from "../providers/provider-error.js";
import { collectProviderTurn } from "../providers/retry.js";
import { PermissionCoordinator, permissionRule, type PermissionDecision } from "./permission-coordinator.js";
import { buildReviewMessages, completeWithProvider, parseVerdict, type ReviewOutcome } from "./permission-review.js";
import type { FastModelClient } from "../fast-model.js";
import {
  BUILTIN_SUB_AGENTS,
  GENERAL_AGENT_TOOL_NAMES,
  getBuiltinSubAgent,
  runSubAgent,
  SUB_AGENT_TOOL_NAMES,
  type BuiltinSubAgent,
} from "./sub-agent.js";
import {
  bashTool,
  ASK_USER_TOOL,
  CODE_SEARCH_TOOL,
  FILE_TOOLS,
  READ_ARTIFACT_TOOL,
  REPO_MAP_TOOL,
  TEST_RUNNER_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from "./tool-schemas.js";
import { getSnapshotBackend } from "../snapshots/index.js";
import type { MessageContent, PythonEnv, SessionMeta, ShellBackend } from "../sessions/types.js";
import { effectivePythonEnv, UvPythonEnvironments, uvVenvDir, wrapCommandWithNote, wrapCommandWithVenv } from "../python-env.js";
import { activePathMessages } from "../sessions/session-tree.js";
import type { SessionStore } from "../sessions/session-store.js";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import { parseSkillCommand, type SkillRegistry } from "../skills.js";
import type { AgentRegistry } from "../agents.js";
import { renderCommand, type CommandRegistry } from "../commands.js";
import type { McpManager } from "../mcp/manager.js";
import { appendMemory, readGlobalMemory, readProjectMemory } from "../memory.js";
import type { UsageLog } from "../usage-log.js";
import type { SearchProvider, WebFetchProvider } from "../web-tools.js";
import type { BackgroundTaskRegistry } from "./background-tasks.js";
import type { HookEvent, HookPayload, HookRunner } from "../hooks.js";
import type { ExtensionManager } from "../extensions/extension-manager.js";
import type { PromptHookResult } from "../extensions/types.js";
import { decodeProcessOutputChunks } from "./output-decoder.js";
import { buildSystemPrompt } from "./prompts/prompt-builder.js";
import { PI_BASE_SYSTEM_PROMPT } from "./prompts/pi-base.js";
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
    "Launch a sub-agent with an isolated context to work on a task. " +
    "The sub-agent does not share this session's context; only its final conclusion (at most 2000 characters) is returned. " +
    "Built-in agent types: explore (default; read-only read_file, glob, grep, read_artifact) and general (write-capable coding tools, run through the session permission chain and sandbox). " +
    "Custom sub-agents from the catalog are always read-only. Sub-agents cannot spawn further sub-agents.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Self-contained task description for the sub-agent." },
      agent: { type: "string", description: "Built-in sub-agent type (explore or general) or a custom sub-agent name from the system prompt catalog." },
      tools: {
        type: "array",
        items: { type: "string", enum: [...GENERAL_AGENT_TOOL_NAMES] },
        description: "Subset of the resolved agent type's tool allowlist; names outside that allowlist are ignored. Defaults to the type's full allowlist (explore: read_file/glob/grep/read_artifact).",
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

/** 手动启动（REST）子代理的每会话并发上限：与 SPAWN_SWARM_CONCURRENCY 对齐，超出直接 429。 */
export const MAX_MANUAL_SUBAGENTS = 4;

/** 手动子代理启动失败：REST 层按 code 映射 400/429。 */
export class SubAgentLaunchError extends Error {
  constructor(message: string, readonly code: "invalid_agent" | "busy") {
    super(message);
    this.name = "SubAgentLaunchError";
  }
}

/** resolveSubAgent 的输出：内置类型或自定义 markdown 子代理的统一执行参数。 */
interface ResolvedSubAgent {
  /** transcript/事件回显名；未指定（默认 explore）时省略 */
  name?: string;
  kind: "explore" | "general";
  systemExtra?: string;
  modelOverride?: string;
  toolNames: string[];
  maxTurns?: number;
}

const SPAWN_SWARM_TOOL: ProviderTool = {
  name: "spawn_swarm",
  description:
    "Launch multiple sub-agents from one prompt template over different inputs, running in parallel (launches beyond the concurrency limit are queued). " +
    "The {{item}} placeholder in prompt_template is replaced with each item's task value; each item launches one independent sub-agent with an isolated context. " +
    "Use when many independent tasks of the same kind should run in parallel (e.g. reviewing several files or endpoints). " +
    "For a single task use spawn_task instead. Built-in agent types: explore (default; read-only) and general (write-capable, via the session permission chain); custom sub-agents are read-only. " +
    "Only each sub-agent's final conclusion (at most 2000 characters) is returned, aggregated as numbered results.",
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
                agent: { type: "string", description: "Optional built-in type (explore/general) or custom sub-agent name overriding the call-level agent for this item only." },
              },
              required: ["task"],
              additionalProperties: false,
            },
          ],
        },
        description: "Values used to fill {{item}}. Each item launches one sub-agent; 2-16 items, and the filled-in prompts must be distinct. An item may be a plain string or an object { task, agent? } to override the agent for that item.",
      },
      agent: { type: "string", description: "Built-in sub-agent type (explore or general) or a custom sub-agent name from the system prompt catalog, applied to every launch unless an item overrides it." },
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
  pythonEnv: PythonEnv;
  /** 并行子代理（spawn_swarm）开关：会话级，默认关闭。 */
  swarmEnabled: boolean;
}): ProviderTool[] {
  return [
    bashTool(options.backgroundTasksEnabled, options.shellBackend, options.pythonEnv),
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
    ...(options.swarmEnabled ? [SPAWN_SWARM_TOOL] : []),
    TODO_WRITE_TOOL,
    REMEMBER_TOOL,
    ASK_USER_TOOL,
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
  git_status: "read_only", git_diff: "read_only", ask_user: "read_only",
  web_fetch: "external", web_search: "external", write_file: "workspace_write", edit_file: "workspace_write",
  bash: "process", task_output: "read_only", task_stop: "process", todo_write: "workspace_write", remember: "workspace_write", spawn_task: "process", spawn_swarm: "process", test_runner: "process",
  git_commit: "process", git_worktree_create: "process", git_worktree_remove: "process", git_worktree_merge: "process",
};
function executionClass(name: string): ToolExecutionClass { return name.startsWith("mcp__") || name.startsWith("ext__") ? "external" : TOOL_EXECUTION_CLASS[name] ?? "workspace_write"; }

/** ask_user 校验后的单题规格（options 已确认 2-4 项、label 非空）。 */
interface AskUserQuestionSpec {
  question: string;
  header?: string;
  type: InteractionKind;
  options?: Array<{ label: string; description?: string }>;
}

/** ask_user 输入校验：1-4 题；select 类型必须 2-4 个非空 label 选项；confirm/text 不得携带 options（拒绝而非忽略，避免歧义）。 */
function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestionSpec[] {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new Error("ask_user requires 1-4 questions");
  return raw.map((entry, index) => {
    const at = `questions[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`ask_user ${at} must be an object`);
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (!question) throw new Error(`ask_user ${at} requires a non-empty question`);
    const type = record.type;
    if (type !== "confirm" && type !== "single_select" && type !== "multi_select" && type !== "text") {
      throw new Error(`ask_user ${at} type must be confirm|single_select|multi_select|text`);
    }
    if (record.header !== undefined && typeof record.header !== "string") throw new Error(`ask_user ${at} header must be a string`);
    const header = record.header === undefined ? {} : { header: record.header as string };
    const select = type === "single_select" || type === "multi_select";
    if (!select) {
      if (record.options !== undefined) throw new Error(`ask_user ${at} of type ${type} must not carry options`);
      return { question, type, ...header };
    }
    if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 4) {
      throw new Error(`ask_user ${at} of type ${type} requires 2-4 options`);
    }
    const options = record.options.map((option, optionIndex) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) throw new Error(`ask_user ${at} options[${optionIndex}] must be an object`);
      const recordOption = option as Record<string, unknown>;
      const label = typeof recordOption.label === "string" ? recordOption.label.trim() : "";
      if (!label) throw new Error(`ask_user ${at} options[${optionIndex}] requires a non-empty label`);
      if (recordOption.description !== undefined && typeof recordOption.description !== "string") throw new Error(`ask_user ${at} options[${optionIndex}] description must be a string`);
      return recordOption.description === undefined ? { label } : { label, description: recordOption.description as string };
    });
    return { question, type, ...header, options };
  });
}

/** 交互原始回答 → 工具结果：confirm 布尔；select 为选中项 label 数组（web 提交 opt-<index> id，REST 直提 label 亦可）；text 字符串。 */
function normalizeAskUserAnswer(spec: AskUserQuestionSpec, answer: unknown): unknown {
  if (spec.type === "confirm") return answer === true;
  if (spec.type === "text") return typeof answer === "string" ? answer : "";
  const ids = Array.isArray(answer) ? answer : typeof answer === "string" ? [answer] : [];
  const labels: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const match = /^opt-(\d+)$/.exec(id);
    const option = match ? spec.options?.[Number(match[1])] : undefined;
    labels.push(option ? option.label : id);
  }
  return labels;
}
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
  /** ask_user 挂起等待：interactionId → waiter；respondInteraction 解析，run abort 经 signal 监听器解析为 cancelled。 */
  private readonly interactionWaiters = new Map<string, { resolve: (answer: unknown) => void; signal: AbortSignal; abort: () => void }>();
  private readonly repeatedCalls = new Map<string, { signature: string; count: number }>();
  private readonly mcpWarningSignatures = new Map<string, string>();
  /** 可编辑提示词覆盖：按 cwd 缓存一次，避免每轮 IO；首次构建时读取。 */
  private readonly promptOverrideCache = new Map<string, PromptOverride>();
  /** 工具形态别名反向映射（sessionId → alias → 内置名），每轮随工具表重建，run 结束清理。 */
  private readonly toolAliases = new Map<string, Map<string, string>>();
  /** 会话级别名参数归一表：模型侧工具名 -> (模型侧参数名 -> 内置参数名)。 */
  private readonly toolAliasArgMaps = new Map<string, Map<string, Record<string, string>>>();
  private readonly todos = new Map<string, TodoItem[]>();
  private readonly permissions: PermissionCoordinator;
  /** 手动启动（REST）子代理：sessionId → 在途 taskId 集（并发上限见 MAX_MANUAL_SUBAGENTS）。 */
  private readonly manualSubagents = new Map<string, Set<string>>();
  /** 手动子代理的 AbortController：会话 abort 时一并取消。 */
  private readonly manualSubagentControllers = new Map<string, Set<AbortController>>();
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

  private fastModel?: FastModelClient;

  /** 注入快速模型客户端：review 权限模式的 fast 审核通道（未注入时 review 一律转人工）。 */
  setFastModel(fastModel: FastModelClient): void {
    this.fastModel = fastModel;
  }

  /** 提示词覆盖更新后清空缓存，下次构建提示词时重新读取覆盖文件。 */
  refreshPromptOverride(): void {
    this.promptOverrideCache.clear();
  }

  /** 工具形态别名 → 内置名解析；无映射时原样返回（权限/门禁/分发统一按内置名）。 */
  private resolveBuiltinToolName(sessionId: string, name: string): string {
    return this.toolAliases.get(sessionId)?.get(name) ?? name;
  }

  /**
   * 别名工具的参数名归一（env-sim 拟态外部产品参数形态）：模型侧参数名按 argMap
   * 改回内置参数名，未列出的键原样透传。归一发生在权限/门禁/执行之前，
   * 下游链路只看到内置工具的标准参数。
   */
  private translateAliasInput(sessionId: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
    const argMap = this.toolAliasArgMaps.get(sessionId)?.get(name);
    if (!argMap) return input;
    const translated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) translated[argMap[key] ?? key] = value;
    return translated;
  }

  private searchProvider: SearchProvider | undefined;
  private webFetchProvider: WebFetchProvider | undefined;
  private readonly pythonEnvManager = new UvPythonEnvironments();
  private getPythonEnvDefault: () => PythonEnv = () => "global";

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

  /** pythonEnv 全局默认的懒读取（settings 热生效，无需热应用回调）。 */
  setPythonEnvDefault(getter: () => PythonEnv): void {
    this.getPythonEnvDefault = getter;
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
            payload: { message: errorMessage(error) },
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
        // 消息树：上下文只组装活动路径（根→活动叶子），checkout/retry 出的旧分支不进 provider 历史。
        const view = await context.buildView(activePathMessages(session.messages, session.activeLeafId), { selection: contextSelection });
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
            this.events.publish({ source: "agent", type: "context.repo_map_failed", sessionId, payload: { message: errorMessage(error) } });
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
            this.events.publish({ source: "agent", type: "context.compact_failed", sessionId, payload: { message: errorMessage(error) } });
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
              warnings: [`MCP 工具发现失败，未注入：${errorMessage(error)}`],
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

        // 工具形态（env-sim 等官方扩展）：隐藏内置工具 + 别名重命名。反向映射按轮重建——
        // 形态由实时扩展配置驱动，不可跨 run 缓存；执行/权限/门禁经 resolveBuiltinToolName 归一。
        const builtIns = builtInTools({
          skillsAvailable: skillCatalog.length > 0,
          backgroundTasksEnabled: Boolean(this.backgroundTasks),
          fetchAvailable: Boolean(this.webFetchProvider),
          searchAvailable: Boolean(this.searchProvider),
          shellBackend: session.shellBackend ?? "default",
          pythonEnv: effectivePythonEnv(session.pythonEnv, this.getPythonEnvDefault()),
          swarmEnabled: session.swarmEnabled === true,
        });
        const shaping = toolsEnabled && this.extensions
          ? await this.extensions.activeToolShaping(builtIns.map((tool) => tool.name), session.persona)
          : undefined;
        const aliasMap = new Map<string, string>();
        const aliasArgMaps = new Map<string, Record<string, string>>();
        let shapedBuiltIns = builtIns;
        if (shaping) {
          shapedBuiltIns = builtIns.filter((tool) => !shaping.hideBuiltIns.has(tool.name));
          for (const [as, spec] of shaping.aliases) {
            const index = shapedBuiltIns.findIndex((tool) => tool.name === spec.from);
            if (index < 0) continue;
            const source = shapedBuiltIns[index]!;
            shapedBuiltIns[index] = { name: as, description: spec.description ?? source.description, inputSchema: spec.inputSchema ?? source.inputSchema };
            aliasMap.set(as, spec.from);
            if (spec.argMap && Object.keys(spec.argMap).length > 0) aliasArgMaps.set(as, spec.argMap);
          }
        }
        this.toolAliases.set(sessionId, aliasMap);
        this.toolAliasArgMaps.set(sessionId, aliasArgMaps);

        const tools = toolsEnabled
          ? [
              ...shapedBuiltIns,
              ...mcpBinding.tools,
              ...extensionTools,
            ]
          : [];
        const availableToolNames = new Set(tools.map((tool) => tool.name));
        const skillSection = availableToolNames.has("load_skill")
          ? `\n\nAvailable skills (load full text with the load_skill tool when relevant; the user can also trigger one with /name):\n${skillCatalog.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
          : "";
        const agentSection = availableToolNames.has("spawn_task") && agentCatalog.length > 0
          ? `\n\nAvailable sub-agents (pass agent=<name> to spawn_task; built-in types explore (default, read-only) and general (write-capable, via the session permission chain) are always available; the custom agents below are read-only):\n${agentCatalog.map((agent) => {
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

        const baseProductSections = [
          workDisciplineSection(availableToolNames),
          communicationSection(this.defaultLanguage),
          session.agentMode === "plan" ? planModeSection(toolsEnabled) : "",
          availableToolNames.has("spawn_swarm")
            ? "## Parallel exploration\nspawn_swarm is enabled for this session: when a task fans out into many independent subtasks of the same kind (e.g. reviewing several files or endpoints), prefer one spawn_swarm call over serial spawn_task calls."
            : "",
        ];

        // prompt.beforeBuild 钩子（env-sim 等）：不缓存——结果依赖实时扩展配置，
        // 逐轮叠加在文件覆盖之上。finalConstraints/安全边界由核心追加，钩子无法移除。
        let promptTransform: PromptHookResult = {};
        if (this.extensions) {
          promptTransform = await this.extensions.transformPrompt({
            sessionId,
            cwd: session.cwd,
            identity: `You are OpenWebCode. The workspace is ${session.cwd}.`,
            basePrompt: promptOverride?.baseOverride?.trim() || PI_BASE_SYSTEM_PROMPT,
            productSections: baseProductSections,
          }, session.persona);
        }
        const effectiveBaseOverride = promptTransform.basePromptOverride ?? promptOverride?.baseOverride;

        const system = buildSystemPrompt({
          cwd: session.cwd,
          tools,
          ...(promptTransform.identity ? { identity: promptTransform.identity } : {}),
          productSections: [...(promptTransform.prependSections ?? []), ...(promptTransform.productSections ?? baseProductSections)],
          finalConstraints: [SAFETY_BOUNDARY_SECTION],
          skillsSection: `${skillSection}${agentSection}`,
          projectContext: memorySection ? [{ path: "workspace instructions and memory", content: memorySection }] : [],
          ...(effectiveBaseOverride ? { basePromptOverride: effectiveBaseOverride } : {}),
          ...(promptOverride?.customAppend ? { customAppend: promptOverride.customAppend } : {}),
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
                effectiveInput = this.translateAliasInput(sessionId, call.name, extensionOutcome.input);
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
              const content = errorMessage(error);
              this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId: call.id, error: content } });
              result = { type: "tool_result", toolCallId: call.id, content, isError: true };
            }
          }
          await this.sessions.appendMessage(sessionId, "tool", [result], this.messageLineage(sessionId));
          // PostToolUse 钩子：仅写类工具成功后触发（format-on-write 等），不阻断；别名按内置名判定
          if (!result.isError && ["write_file", "edit_file", "bash"].includes(this.resolveBuiltinToolName(sessionId, call.name))) {
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
          // evict 的返回值就是落盘后的 ledger（serial 队列保证期间无其他写入），不必再 load 一次。
          // 与 buildView 一致只按活动路径记账，避免旧分支消息污染 ledger。
          const evictedLedger = await context.evict(activePathMessages(afterTools.messages, afterTools.activeLeafId), new Set(afterTools.contextPins ?? []));
          this.events.publish({ source: "agent", type: "context.evicted", sessionId, payload: evictedLedger.entries });
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
      const message = errorMessage(error);
      // Provider 错误（重试耗尽后抛出 ProviderError）携带分类 kind 与 retryable，
      // 供前端给出可操作的提示（检查 API Key / 限流稍后重试等）；非 provider 路径省略 kind。
      const providerError = error instanceof ProviderError ? error : undefined;
      this.events.publish({
        source: "agent",
        type: "agent.error",
        sessionId,
        payload: { message, retryable: providerError?.retryable ?? false, ...(providerError ? { kind: providerError.kind } : {}) },
      });
      await this.finishRun(sessionId, "failed", { code: "run_failed", message, retryable: providerError?.retryable ?? false });
      throw error;
    } finally {
      this.settling.delete(sessionId);
      this.running.delete(sessionId);
      this.repeatedCalls.delete(sessionId);
      this.toolAliases.delete(sessionId);
      this.toolAliasArgMaps.delete(sessionId);
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
      if (scheduleFollowUp && !controller.signal.aborted) void this.startFollowUp(sessionId).catch(() => { /* follow-up failures are logged via queue.run_failed */ });
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
    // 手动子代理独立于主 run：无论主循环是否在跑都一并取消；其挂起的权限请求同样解除
    for (const sub of this.manualSubagentControllers.get(sessionId) ?? []) sub.abort();
    this.permissions.cancelSession(sessionId);
    if (!controller) return false;
    controller.abort();
    this.workspaceWrites.get(sessionId)?.abort();
    return true;
  }

  /**
   * 解析子代理引用：内置类型（explore/general）优先，其次自定义 markdown 子代理。
   * agentName 为空时返回默认 explore（不回显 name，保持历史行为）。
   * 自定义子代理维持只读子集；其 frontmatter tools 优先于调用方 tools 参数。
   */
  private async resolveSubAgent(cwd: string, sessionId: string, agentName: string, requestedTools?: string[]): Promise<ResolvedSubAgent> {
    const builtin = agentName ? getBuiltinSubAgent(agentName) : undefined;
    if (builtin) {
      const requested = requestedTools ?? [...builtin.toolNames];
      return { name: builtin.id, kind: builtin.id, toolNames: this.filterSubAgentTools(sessionId, requested, builtin), maxTurns: builtin.maxTurns };
    }
    const definition = agentName && this.agents ? await this.agents.find(cwd, agentName) : undefined;
    if (agentName && !definition) throw new Error(`Unknown sub-agent: ${agentName}`);
    const requested = definition?.tools ?? requestedTools ?? [...SUB_AGENT_TOOL_NAMES];
    return {
      ...(definition ? { name: definition.name, systemExtra: definition.body, ...(definition.model ? { modelOverride: definition.model } : {}) } : {}),
      kind: "explore",
      toolNames: this.filterSubAgentTools(sessionId, requested, undefined),
    };
  }

  /** allowlist 以内置名为准：先把可能的工具形态别名解析回内置名再过滤。 */
  private filterSubAgentTools(sessionId: string, requested: string[], builtin: BuiltinSubAgent | undefined): string[] {
    const allowlist: readonly string[] = builtin ? builtin.toolNames : SUB_AGENT_TOOL_NAMES;
    return requested.map((tool) => this.resolveBuiltinToolName(sessionId, tool)).filter((tool) => allowlist.includes(tool));
  }

  /** GET /api/agents：内置类型在前（description 为中文，前端按 id 做 i18n），随后自定义子代理。 */
  async listAgentCatalog(cwd?: string): Promise<Array<{ id: string; name: string; description: string; builtin: boolean }>> {
    const builtins = BUILTIN_SUB_AGENTS.map((agent) => ({ id: agent.id, name: agent.id, description: agent.description, builtin: true }));
    // 未提供 cwd 时只列全局目录，避免误扫进程相对路径下的 .owc/agents
    const custom = this.agents ? (cwd ? await this.agents.listFor(cwd) : await this.agents.listGlobal()) : [];
    return [...builtins, ...custom.map((agent) => ({ id: agent.name, name: agent.name, description: agent.description, builtin: false }))];
  }

  /**
   * 手动启动子代理（REST POST /api/sessions/:id/subagents）：校验 + 并发登记同步完成，
   * 实际运行 detachment（调用方拿到 202 后经 subagent.* 事件跟踪）。
   * toolCallId 固定为 `manual-<taskId>`；事件负载与 spawn_task 相同，started 额外带 manual: true。
   */
  async launchManualSubagent(sessionId: string, input: { prompt: string; agent?: string }): Promise<{ taskId: string; toolCallId: string }> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new SubAgentLaunchError("Session not found", "invalid_agent");
    const agentName = input.agent?.trim() ?? "";
    let resolved: ResolvedSubAgent;
    try {
      resolved = await this.resolveSubAgent(session.cwd, sessionId, agentName, undefined);
    } catch (error) {
      throw new SubAgentLaunchError(errorMessage(error), "invalid_agent");
    }
    const provider = this.providers.get(session.provider);
    if (!provider) throw new SubAgentLaunchError(`Provider ${session.provider} is not configured`, "invalid_agent");
    const running = this.manualSubagents.get(sessionId) ?? new Set<string>();
    if (running.size >= MAX_MANUAL_SUBAGENTS) {
      throw new SubAgentLaunchError(`已有 ${MAX_MANUAL_SUBAGENTS} 个手动子代理在运行，请等待其完成后再启动`, "busy");
    }
    const taskId = randomUUID();
    const toolCallId = `manual-${taskId}`;
    running.add(taskId);
    this.manualSubagents.set(sessionId, running);
    const controller = new AbortController();
    const controllers = this.manualSubagentControllers.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.manualSubagentControllers.set(sessionId, controllers);
    void this.runManualSubagent(sessionId, resolved, {
      taskId,
      toolCallId,
      prompt: input.prompt,
      providerName: session.provider,
      provider,
      signal: controller.signal,
    }).finally(() => {
      running.delete(taskId);
      controllers.delete(controller);
      if (running.size === 0) this.manualSubagents.delete(sessionId);
      if (controllers.size === 0) this.manualSubagentControllers.delete(sessionId);
    });
    return { taskId, toolCallId };
  }

  /** 手动子代理的运行体：任何失败都以 subagent.finished(failed) 收尾，不向调用方抛出。 */
  private async runManualSubagent(
    sessionId: string,
    resolved: ResolvedSubAgent,
    context: {
      taskId: string;
      toolCallId: string;
      prompt: string;
      providerName: string;
      provider: Provider;
      signal: AbortSignal;
    },
  ): Promise<void> {
    const { taskId, toolCallId, prompt, signal } = context;
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      // 与 runShell 同款幂等沙盒配置：手动子代理可能在主循环之外首次触达 core
      await this.core.configureSession({
        sessionId,
        cwd: session.cwd,
        sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd),
      });
      const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
      const result = await runSubAgent({
        provider: context.provider,
        model: session.model,
        ...(resolved.modelOverride ? { modelOverride: resolved.modelOverride } : {}),
        ...(resolved.systemExtra ? { systemExtra: resolved.systemExtra } : {}),
        ...(resolved.name ? { agent: resolved.name } : {}),
        agentKind: resolved.kind,
        prompt,
        toolNames: resolved.toolNames,
        ...(resolved.maxTurns ? { maxTurns: resolved.maxTurns } : {}),
        // general 类型：工具调用经会话权限链 + 主循环同一沙盒执行（见 executeSubAgentTool）
        ...(resolved.kind === "general" ? { executeTool: (call: { name: string; input: Record<string, unknown> }) => this.executeSubAgentTool(sessionId, call.name, call.input, signal) } : {}),
        core: this.core,
        sessionId,
        cwd: session.cwd,
        contextRoot: this.sessions.contextRoot(sessionId),
        signal,
        taskId,
        onStart: (id) => {
          this.events.publish({
            source: "agent",
            type: "subagent.started",
            sessionId,
            payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), manual: true, ...(resolved.name ? { agent: resolved.name } : {}) },
          });
        },
        onProgress: (progress) => {
          this.events.publish({
            source: "agent",
            type: "subagent.progress",
            sessionId,
            payload: { toolCallId, taskId, turns: progress.turns, toolsUsed: progress.toolsUsed },
          });
        },
        onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, context.providerName, resolved.modelOverride ?? session.model, usage),
      });
      this.events.publish({
        source: "agent",
        type: "subagent.finished",
        sessionId,
        payload: { toolCallId, taskId: result.taskId, status: "done", turns: result.turns, toolsUsed: result.toolsUsed },
      });
    } catch (error) {
      const message = errorMessage(error);
      this.events.publish({ source: "agent", type: "subagent.finished", sessionId, payload: { toolCallId, taskId, status: "failed", error: message } });
    }
  }

  /**
   * general 子代理的工具执行入口：与主循环工具完全相同的权限链（authorizeTool：
   * plan 只读门禁 + 权限模式/规则 + permission.request 挂起与 respond 恢复），
   * 执行复用主循环同一 core/沙盒配置。不发布 tool.start/end、不改变 run 状态——
   * 子代理进度只经 subagent.progress 暴露。
   */
  private async executeSubAgentTool(sessionId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const permission = await this.authorizeTool(sessionId, name, input, signal);
    if (!permission.allowed) return { content: permission.reason ?? "Tool permission denied", isError: true };
    try {
      return await this.dispatchSubAgentTool(sessionId, name, input, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { content: errorMessage(error), isError: true };
    }
  }

  /** general 子代理的工具分发：语义对齐 executeTool 各分支，但无事件/状态副作用。 */
  private async dispatchSubAgentTool(sessionId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const contextRoot = this.sessions.contextRoot(sessionId);
    if ((FILE_TOOLS as readonly ProviderTool[]).some((tool) => tool.name === name)) {
      const raw = await this.callCoreFileTool(sessionId, name, input);
      const bounded = await boundToolResult(contextRoot, name, raw);
      return { content: bounded.content, isError: false };
    }
    if (name === "read_artifact") {
      const manager = new ContextManager(contextRoot);
      const content = await manager.readArtifact(String(input.artifactId), Number(input.offset), Number(input.limit));
      return { content, isError: false };
    }
    if (name === "bash") {
      const cmd = typeof input.cmd === "string" ? input.cmd : "";
      if (!cmd) throw new Error("bash requires a non-empty cmd");
      return this.executeBash(sessionId, cmd, `subagent-${randomUUID().slice(0, 8)}`, signal, { quiet: true });
    }
    if (name === "repo_map") {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      if (input.budget !== undefined && (!Number.isInteger(Number(input.budget)) || Number(input.budget) < 64)) {
        throw new Error("repo_map budget must be an integer >= 64");
      }
      const map = await this.repoMap.generate({
        sessionId,
        cwd: session.cwd,
        budget: input.budget === undefined ? (session.repoMapBudget ?? DEFAULT_REPO_MAP_BUDGET) : Number(input.budget),
        excludes: session.contextExcludes ?? [],
      });
      const bounded = await boundToolResult(contextRoot, name, map.text);
      return { content: bounded.content, isError: false };
    }
    if (name === "code_search") {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      if (!this.indexManager) throw new IndexUnavailableError("Symbol index is not enabled on this server. Fall back to grep/glob for navigation.");
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) throw new Error("code_search requires a non-empty query");
      const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : undefined;
      const limit = input.limit === undefined ? undefined : Number(input.limit);
      const hits = await this.indexManager.searchSymbols(session.cwd, query, { ...(kind ? { kind } : {}), ...(limit !== undefined ? { limit } : {}) });
      const text = hits.length === 0
        ? `No symbols matching "${query}"${kind ? ` (kind=${kind})` : ""}. Try a broader query, or fall back to grep/glob.`
        : hits.map((hit) => `${hit.path}:${hit.startLine}\t${hit.kind}\t${hit.name}\t${hit.signature}`).join("\n");
      const bounded = await boundToolResult(contextRoot, name, text);
      return { content: bounded.content, isError: false };
    }
    if (name === "test_runner") {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      if (!this.diagnostics) throw new Error("Diagnostics service is not enabled on this server.");
      const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : undefined;
      const { feedback } = await this.diagnostics.run(sessionId, session.cwd, {
        ...(command ? { command } : {}),
        ...(this.runs.get(sessionId)?.id ? { agentRunId: this.runs.get(sessionId)!.id } : {}),
        signal,
        shellBackend: session.shellBackend ?? "default",
      });
      return { content: feedback, isError: false };
    }
    if (name === "web_fetch" || name === "web_search") {
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
      const bounded = await boundToolResult(contextRoot, name, JSON.stringify(value));
      return { content: bounded.content, isError: false };
    }
    return { content: `Unsupported tool for general sub-agent: ${name}`, isError: true };
  }

  /** FILE_TOOLS 各分支共用的 core 调用分发（主循环与 general 子代理共用）。 */
  private async callCoreFileTool(sessionId: string, name: string, input: Record<string, unknown>): Promise<string> {
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) throw new Error(`${name} requires a non-empty path`);
    let value: unknown;
    if (name === "read_file") value = await this.core.readFile({ sessionId, path, ...(input.offset === undefined ? {} : { offset: Number(input.offset) }), ...(input.limit === undefined ? {} : { limit: Number(input.limit) }) });
    else if (name === "write_file") value = await this.core.writeFile({ sessionId, path, content: String(input.content ?? ""), ...(input.createDirs === undefined ? {} : { createDirs: Boolean(input.createDirs) }) });
    else if (name === "edit_file") value = await this.core.editFile({ sessionId, path, oldText: String(input.oldText ?? ""), newText: String(input.newText ?? ""), ...(input.replaceAll === undefined ? {} : { replaceAll: Boolean(input.replaceAll) }) });
    else if (name === "glob") value = await this.core.globFiles({ sessionId, path, pattern: String(input.pattern ?? "") });
    else value = await this.core.grepFiles({ sessionId, path, pattern: String(input.pattern ?? "") });
    return JSON.stringify(value);
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
      const message = errorMessage(error);
      // runShell 不经过 provider，payload 不带 kind；retryable 恒为 false
      this.events.publish({ source: "agent", type: "agent.error", sessionId, payload: { message, retryable: false } });
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
    if (item) {
      this.events.publish({ source: "agent", type: "interaction.answered", sessionId, payload: item });
      // ask_user 工具挂起等待：回答到达即恢复工具执行（镜像权限 respond 语义）
      const waiter = this.interactionWaiters.get(id);
      if (waiter) {
        this.interactionWaiters.delete(id);
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.resolve(item.answer);
      }
    }
    return item;
  }

  /**
   * 等待 ask_user 交互被回答；run abort 或交互已取消时解析为 { cancelled: true }，
   * 工具结果按 { cancelled: true } 返回（非错误），agent 可自行决定继续或收尾。
   */
  private async waitForInteractionAnswer(sessionId: string, interactionId: string, signal: AbortSignal): Promise<{ cancelled: true } | { cancelled: false; answer: unknown }> {
    if (signal.aborted) return { cancelled: true };
    // 竞态防护：REST respond 可能先于 waiter 注册完成（事件发布与注册之间存在微任务窗口）
    const existing = (await this.interactions.list(sessionId)).find((item) => item.id === interactionId);
    if (existing && existing.status !== "pending") {
      return existing.status === "cancelled" ? { cancelled: true } : { cancelled: false, answer: existing.answer };
    }
    return new Promise((resolve) => {
      const abort = () => {
        this.interactionWaiters.delete(interactionId);
        resolve({ cancelled: true });
      };
      this.interactionWaiters.set(interactionId, { resolve: (answer) => resolve({ cancelled: false, answer }), signal, abort });
      signal.addEventListener("abort", abort, { once: true });
    });
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
      this.events.publish({ source: "agent", type: "queue.apply_failed", sessionId, payload: { id: item.id, kind: item.kind, message: errorMessage(error) } });
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
        payload: { id: item.id, kind: item.kind, message: errorMessage(error) },
      });
    });
  }

  private async authorizeTool(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
    const session = await this.sessions.get(sessionId);
    if (!session) return { allowed: false, reason: "Session not found" };
    // 工具形态别名按原内置工具的权限类处理（不降级为 external）
    tool = this.resolveBuiltinToolName(sessionId, tool);
    // Plan 模式门禁：只读工具放行，其余一律拦截
    const PLAN_READONLY = new Set(["read_file", "glob", "grep", "read_artifact", "load_skill", "spawn_task", "spawn_swarm", "todo_write", "web_fetch", "web_search", "task_output", "repo_map", "code_search", "git_status", "git_diff", "ask_user"]);
    if (session.agentMode === "plan") {
      if (tool.startsWith("mcp__")) return { allowed: false, reason: `Plan 模式为只读：MCP 工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。` };
      if (tool.startsWith("ext__")) return { allowed: false, reason: `Plan 模式为只读：扩展工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。` };
      if (!PLAN_READONLY.has(tool)) return { allowed: false, reason: `Plan 模式为只读：${tool} 被拦截。请输出实施计划并请用户切换到 build 模式执行。` };
    }
    const mode = session.permissionMode ?? "ask";
    const rules = session.permissionRules ?? [];
    // 权限规则键与确认卡片统一使用 core path.normalize 归一化后的 canonical
    // path（路径处理归一在 core C 层）：src/a.ts、./src/a.ts 与根内绝对路径
    // 命中同一条 allow-always 规则。normalize 不可用/失败时回退原始字符串。
    if ((tool === "write_file" || tool === "edit_file") && typeof input.path === "string" && this.core.normalizePath) {
      try {
        const normalized = await this.core.normalizePath({ sessionId, path: input.path, purpose: "write" });
        input = { ...input, path: normalized.path };
      } catch { /* 回退原始路径 */ }
    }
    if (!this.permissions.needsApproval(mode, rules, tool, input)) return { allowed: true };
    // 模型审核（review 模式）：需要人工确认的调用先由审核模型评判风险；git_commit 永远直接人工。
    // 审核期间不置 waiting_permission（仍视为工具运行中）；LOW 自动放行，其余照旧走人工流程。
    if (mode === "review" && tool !== "git_commit") {
      const reviewed = await this.reviewToolCall(session, tool, input, signal);
      this.events.publish({ source: "agent", type: "permission.reviewed", sessionId, payload: { tool, input, verdict: reviewed.verdict, rationale: reviewed.rationale, model: reviewed.model } });
      if (reviewed.verdict === "low") return { allowed: true };
    }
    this.state(sessionId, "waiting_permission");
    const result = await this.permissions.request(sessionId, tool, input, signal);
    this.state(sessionId, "tool_running");
    return { allowed: result.allowed, ...(result.reason ? { reason: result.reason } : {}) };
  }

  /**
   * review 模式的审核门：fast = FastModelClient（未配置直接转人工）；main = 会话当前
   * provider/model 的一次性补全。30s 超时并尊重 run 的 AbortSignal；调用失败、超时或
   * 结果无法解析一律按 HIGH 转人工——审核通道故障不得放大权限。
   */
  private async reviewToolCall(session: SessionMeta, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ReviewOutcome & { model: string }> {
    const reviewModel = session.reviewModel ?? "fast";
    if (reviewModel === "fast" && !this.fastModel?.configured) {
      return { verdict: "high", rationale: "快速模型未配置，无法自动审核", model: "fast" };
    }
    const { system, prompt } = buildReviewMessages(tool, input);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const model = reviewModel === "fast" ? `fast:${this.fastModel?.model ?? ""}` : `${session.provider}/${session.model}`;
    try {
      let text: string;
      if (reviewModel === "fast") {
        // FastModelClient.complete 不接受外部 signal，用竞速实现超时/中止（底层请求会自行收尾）
        text = (await raceAbort(this.fastModel!.complete({ system, prompt, maxTokens: 256 }), combined)).text;
      } else {
        const provider = this.providers.get(session.provider);
        if (!provider) return { verdict: "high", rationale: "当前服务商不可用，无法自动审核", model };
        text = await completeWithProvider(provider, { model: session.model, system, prompt, maxTokens: 256, signal: combined });
      }
      return { ...parseVerdict(text), model };
    } catch (error) {
      return { verdict: "high", rationale: `审核调用失败：${errorMessage(error)}`, model };
    }
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
        payload: { event, message: errorMessage(error) },
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
      const content = errorMessage(error);
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
    // 工具形态别名回调到内置实现：权限分级/事件/分发统一按内置名。
    name = this.resolveBuiltinToolName(sessionId, name);
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
        const content = errorMessage(error);
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
        const content = errorMessage(error);
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
        const requestedTools = Array.isArray(input.tools) ? input.tools.map((item) => String(item)) : undefined;
        const resolved = await this.resolveSubAgent(session.cwd, sessionId, agentName, requestedTools);
        // 子代理期间不发布 message.delta/thinking_delta，避免污染主聊天流；
        // 子代理 token 经 onUsage 复用主循环记账路径，计入会话成本
        const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
        const result = await runSubAgent({
          provider,
          model: session.model,
          ...(resolved.modelOverride ? { modelOverride: resolved.modelOverride } : {}),
          ...(resolved.systemExtra ? { systemExtra: resolved.systemExtra } : {}),
          ...(resolved.name ? { agent: resolved.name } : {}),
          agentKind: resolved.kind,
          prompt,
          toolNames: resolved.toolNames,
          ...(resolved.maxTurns ? { maxTurns: resolved.maxTurns } : {}),
          // general 类型：工具调用经会话权限链 + 主循环同一沙盒执行（见 executeSubAgentTool）
          ...(resolved.kind === "general" ? { executeTool: (call: { name: string; input: Record<string, unknown> }) => this.executeSubAgentTool(sessionId, call.name, call.input, signal) } : {}),
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
              payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), ...(resolved.name ? { agent: resolved.name } : {}) },
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
          onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, session.provider, resolved.modelOverride ?? session.model, usage),
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
        return {
          type: "tool_result",
          toolCallId,
          content: result.conclusion,
          isError: false,
          subagentTaskIds: [result.taskId],
          subagentTasks: [{ taskId: result.taskId, index: 0, status: "done" }],
        };
      } catch (error) {
        const content = errorMessage(error);
        // 子代理已启动后失败（含中断）：补发 finished，与 spawn_swarm 单项失败语义一致
        if (taskId) {
          this.events.publish({ source: "agent", type: "subagent.finished", sessionId, payload: { toolCallId, taskId, status: "failed", error: content } });
        }
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        // 子代理已启动：保留 taskId 与逐项终态，页面刷新后历史可还原（转录已落盘）
        return {
          type: "tool_result",
          toolCallId,
          content,
          isError: true,
          ...(taskId ? { subagentTaskIds: [taskId], subagentTasks: [{ taskId, index: 0, status: "failed" as const, error: content }] } : {}),
        };
      }
    }
    if (name === "spawn_swarm") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      // catch 分支需引用（中断/整体失败仍回报已启动项的 taskId 与逐项终态），声明在 try 之外
      interface SwarmTaskStatus { taskId: string; index: number; status: "done" | "failed"; error?: string }
      const subagentTaskIds: string[] = [];
      const subagentTasks: SwarmTaskStatus[] = [];
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
        const resolvedDefault = await this.resolveSubAgent(session.cwd, sessionId, agentName, undefined);
        // 预解析逐项 agent 覆盖：未知名称直接拒绝整次调用（与调用级 agent 一致）
        const itemResolutions = new Map<number, ResolvedSubAgent>();
        for (const [index, item] of items.entries()) {
          if (!item.agent) continue;
          try {
            itemResolutions.set(index, await this.resolveSubAgent(session.cwd, sessionId, item.agent, undefined));
          } catch (error) {
            const message = errorMessage(error);
            throw new Error(`${message} (item ${index + 1})`);
          }
        }
        const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
        const contextRoot = this.sessions.contextRoot(sessionId);
        interface SwarmItemOutcome { ok: boolean; conclusion?: string; error?: string }
        const runOne = async (prompt: string, index: number): Promise<SwarmItemOutcome> => {
          const swarm = { index: index + 1, total: prompts.length };
          const effective = itemResolutions.get(index) ?? resolvedDefault;
          let taskId = "";
          try {
            const result = await runSubAgent({
              provider,
              model: session.model,
              ...(effective.modelOverride ? { modelOverride: effective.modelOverride } : {}),
              ...(effective.systemExtra ? { systemExtra: effective.systemExtra } : {}),
              ...(effective.name ? { agent: effective.name } : {}),
              agentKind: effective.kind,
              prompt,
              toolNames: effective.toolNames,
              ...(effective.maxTurns ? { maxTurns: effective.maxTurns } : {}),
              // general 类型：工具调用经会话权限链 + 主循环同一沙盒执行（见 executeSubAgentTool）
              ...(effective.kind === "general" ? { executeTool: (call: { name: string; input: Record<string, unknown> }) => this.executeSubAgentTool(sessionId, call.name, call.input, signal) } : {}),
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
                  payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), swarm, ...(effective.name ? { agent: effective.name } : {}) },
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
              onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, session.provider, effective.modelOverride ?? session.model, usage),
            });
            this.events.publish({
              source: "agent",
              type: "subagent.finished",
              sessionId,
              payload: { toolCallId, taskId: result.taskId, status: "done", turns: result.turns, toolsUsed: result.toolsUsed, swarm },
            });
            subagentTasks.push({ taskId, index, status: "done" });
            return { ok: true, conclusion: result.conclusion };
          } catch (error) {
            const message = errorMessage(error);
            this.events.publish({
              source: "agent",
              type: "subagent.finished",
              sessionId,
              payload: { toolCallId, taskId, status: "failed", error: message, swarm },
            });
            // 启动前失败的项没有 taskId/转录，不进入逐项终态
            if (taskId) subagentTasks.push({ taskId, index, status: "failed", error: message });
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
          subagentTasks: [...subagentTasks].sort((a, b) => a.index - b.index),
        };
      } catch (error) {
        const content = errorMessage(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        // 中断/整体失败仍回报已启动子代理的 taskId 与逐项终态，页面刷新后历史可还原
        const ids = subagentTaskIds.filter((id): id is string => typeof id === "string" && id.length > 0);
        return {
          type: "tool_result",
          toolCallId,
          content,
          isError: true,
          ...(ids.length > 0 ? { subagentTaskIds: ids, subagentTasks: [...subagentTasks].sort((a, b) => a.index - b.index) } : {}),
        };
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
        const content = errorMessage(error);
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
        const content = errorMessage(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "ask_user") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const questions = parseAskUserQuestions(input);
        const runId = this.runs.get(sessionId)?.id ?? "";
        const results: Array<{ question: string; type: InteractionKind; answer: unknown }> = [];
        for (const spec of questions) {
          // 逐题串行发问：每题经 InteractionCoordinator 落盘 + interaction.requested 事件，REST respond 恢复
          const interaction = await this.createInteraction(sessionId, {
            runId,
            toolCallId,
            kind: spec.type,
            title: spec.header ?? spec.question,
            prompt: spec.question,
            ...(spec.options
              ? { options: spec.options.map((option, index) => ({ id: `opt-${index}`, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) }
              : {}),
          });
          this.state(sessionId, "waiting_permission");
          const outcome = await this.waitForInteractionAnswer(sessionId, interaction.id, signal);
          this.state(sessionId, "tool_running");
          if (outcome.cancelled) {
            this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { cancelled: true } } });
            return { type: "tool_result", toolCallId, content: JSON.stringify({ cancelled: true }), isError: false };
          }
          results.push({ question: spec.question, type: spec.type, answer: normalizeAskUserAnswer(spec, outcome.answer) });
        }
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { answered: results.length } } });
        return { type: "tool_result", toolCallId, content: JSON.stringify(results), isError: false };
      } catch (error) {
        const content = errorMessage(error);
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
        return { type: "tool_result", toolCallId, content: errorMessage(error), isError: true };
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
        const content = errorMessage(error);
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
        const content = errorMessage(error);
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
        const content = errorMessage(error);
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
          : errorMessage(error);
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
        const raw = await this.callCoreFileTool(sessionId, name, input);
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, raw);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        const content = errorMessage(error);
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
        const content = errorMessage(error);
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
        const content = errorMessage(error);
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
        const content = errorMessage(error);
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
   * quiet（general 子代理）：不发布 tool.start/end、不触碰 run 状态，执行语义不变。
   */
  private async executeBash(
    sessionId: string,
    cmd: string,
    toolCallId: string,
    signal: AbortSignal,
    options?: { quiet?: boolean },
  ): Promise<{ content: string; isError: boolean }> {
    const quiet = options?.quiet === true;
    signal.throwIfAborted();
    const execId = `${sessionId}:${randomUUID()}`;
    const execution: ExecutionContext = { sessionId, output: [] };
    this.executions.set(execId, execution);
    if (!quiet) {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name: "bash", input: { cmd }, execId } });
      this.state(sessionId, "tool_running");
    }
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      cmd = await this.wrapForPythonEnv(session, cmd);
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
            if (!quiet) this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
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
      if (!quiet) this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: toolEventResult(bounded) } });
      return { content: bounded.content, isError: false };
    } catch (error) {
      if (signal.aborted) throw error;
      const content = errorMessage(error);
      if (!quiet) this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
      return { content, isError: true };
    } finally {
      this.executions.delete(execId);
    }
  }

  /**
   * pythonEnv=uv-* 时把会话 bash 包装进 uv 管理的 venv（PATH 前置，懒创建）；
   * global（本机环境）原样返回。uv 缺失/建环境失败回退本机环境并在输出中说明。
   */
  private async wrapForPythonEnv(session: SessionMeta, cmd: string): Promise<string> {
    const mode = effectivePythonEnv(session.pythonEnv, this.getPythonEnvDefault());
    if (mode === "global") return cmd;
    const venvDir = uvVenvDir(mode, session.cwd, this.dataDir);
    if (!venvDir) return cmd;
    const ensured = await this.pythonEnvManager.ensure(venvDir);
    if (!ensured.ok) return wrapCommandWithNote(cmd, ensured.note ?? "uv environment unavailable; using the host python environment");
    return wrapCommandWithVenv(cmd, venvDir, session.shellBackend ?? "default");
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
      process.stderr.write(`[usage-log] 写入失败：${errorMessage(error)}\n`);
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
        payload: { message: errorMessage(error) },
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
        payload: { message: errorMessage(error) },
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

/** 给不支持外部 signal 的 Promise 套上中止/超时竞速（review 模式的 fast 审核通道用）。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("审核已中止"));
      return;
    }
    const onAbort = (): void => reject(new Error(signal.reason === undefined ? "审核已中止" : "审核超时或已中止"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
