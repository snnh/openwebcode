import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { CoreClientLike, CoreEvent } from "../core-client.js";
import { CoreGateway } from "../core-gateway.js";
import type { EventBus } from "../events/event-bus.js";
import { withTimeout } from "../http-utils.js";
import { fetchMedia } from "../media-fetch.js";
import { MAX_IMAGE_BASE64_CHARS, MAX_VIDEO_BYTES } from "../media-limits.js";
import { sniffMedia } from "../media-sniff.js";
import { ContextManager, selectCacheBreakpoints, type TurnLedger } from "../context/context-manager.js";
import { evictContext } from "../extensions/context-saver/index.js";
import type { Compactor, CompactResult } from "../context/compactor.js";
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
import { PermissionCoordinator, permissionRule, matchesRule, type PermissionDecision } from "./permission-coordinator.js";
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
  CRON_CREATE_TOOL,
  CRON_DELETE_TOOL,
  CRON_LIST_TOOL,
  EXIT_PLAN_MODE_TOOL,
  FILE_TOOLS,
  applyToolShaping,
  filterBuiltInTools,
  isSubagentToolName,
  READ_ARTIFACT_TOOL,
  readMediaTool,
  REPO_MAP_TOOL,
  SUBAGENT_LEGACY_NAME,
  SUBAGENT_TOOL,
  TEST_RUNNER_TOOL,
  toolAllowedBySession,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from "./tool-schemas.js";
import type { CronScheduler } from "../cron-scheduler.js";
import { getSnapshotBackend } from "../snapshots/index.js";
import { ToolAliasResolver } from "./tool-alias.js";

/** 本机会话（kind=local）路径门覆盖的文件工具：HOME 外路径需人工允许或命中 allow 规则。
 * 由 FILE_TOOLS 派生 + read_media（本地路径读媒体与 read_file 同门；http(s) URL 在门内特判放行，
 * URL 安全由 media-fetch 的 SSRF 链负责）。 */
const LOCAL_PATH_GATED_TOOLS = new Set([...FILE_TOOLS.map((tool) => tool.name), "read_media"]);
import { digestSwarmBoard, swarmBoardPath } from "./swarm-board.js";
import type { MessageContent, NodeEnv, PythonEnv, SessionMeta, WebSearchCallContent } from "../sessions/types.js";
import { replaceThinkingBlockById } from "../providers/thinking-merge.js";
import { effectivePythonEnv, UvPythonEnvironments, uvVenvDir, wrapCommandWithNote, wrapCommandWithVenv } from "../python-env.js";
import { effectiveNodeEnv, NodeEnvManagers, wrapCommandWithNodeEnv } from "../node-env.js";
import { activePathMessages } from "../sessions/session-tree.js";
import type { SessionStore } from "../sessions/session-store.js";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import { resolveSessionPersona } from "../sessions/extension-state.js";
import { parseSkillCommand, type SkillRegistry } from "../skills.js";
import type { AgentRegistry } from "../agents.js";
import { renderCommand, type CommandRegistry } from "../commands.js";
import type { McpManager } from "../mcp/manager.js";
import { appendMemory } from "../memory.js";
import type { UsageLog } from "../usage-log.js";
import type { SearchProvider, WebFetchProvider } from "../web-tools.js";
import type { BackgroundTaskRegistry } from "./background-tasks.js";
import type { HookEvent, HookPayload, HookRunner } from "../hooks.js";
import type { ExtensionManager } from "../extensions/extension-manager.js";
import type { CompactVaultService } from "../extensions/compact-vault.js";
import type { PromptHookResult } from "../extensions/types.js";
import { decodeProcessOutputChunks } from "./output-decoder.js";
import { buildSystemPrompt } from "./prompts/prompt-builder.js";
import { PI_BASE_SYSTEM_PROMPT } from "./prompts/pi-base.js";
import { loadPromptOverride, type PromptOverride } from "./prompts/prompt-overrides.js";
import { RunStore, type AgentRunSnapshot, type AgentRunState } from "./run-store.js";
import { PersistentShellManager, PersistentShellUnavailableError } from "./persistent-shell.js";
import { coreExecShell, resolveShell, type ResolvedShell } from "./shell-detect.js";
import { wrapCommandWithSessionEnv } from "./session-env.js";
import type { QueueItem } from "./message-queue.js";
import type { InteractionKind, InteractionRequest } from "./interaction-coordinator.js";
import { RunControl } from "./run-control.js";
import { MemorySectionBuilder } from "./memory-section.js";
export { SteeringError } from "./run-control.js";
import { ModelRoleResolver, MODEL_ROLES, isModelRole, type ModelRole } from "../model-roles.js";

interface ExecutionContext {
  sessionId: string;
  output: Array<{ stream: string; data: string; seq: number }>;
}

const TOOL_EVENT_PREVIEW_CHARS = 1_024;
/** 事件 payload 单字符串值上限：write_file 全量 content 这类大输入会把 MB 级帧推上 WS 热路径。 */
const TOOL_EVENT_INPUT_VALUE_CHARS = 256 * 1024;

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

/**
 * 事件 payload 的 input 限长（tool.start / permission.reviewed / tool.repeated 等）：
 * 逐值截断超长字符串并标记 inputTruncated。web 端这些事件只消费 toolCallId/name/verdict，
 * 展示用 input 来自持久化消息；对齐结果侧 boundToolResult 的截断先例。
 */
function boundToolEventInput(input: Record<string, unknown>): { input: Record<string, unknown>; inputTruncated?: true } {
  let truncated = false;
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > TOOL_EVENT_INPUT_VALUE_CHARS) {
      bounded[key] = `${value.slice(0, TOOL_EVENT_INPUT_VALUE_CHARS)}…[truncated ${value.length - TOOL_EVENT_INPUT_VALUE_CHARS} chars]`;
      truncated = true;
    } else {
      bounded[key] = value;
    }
  }
  return truncated ? { input: bounded, inputTruncated: true } : { input };
}

/** 子代理 maxTurns 参数校验：1–1000 整数；未传返回 undefined（走全局默认）。非法值显式报错。 */
function parseMaxTurns(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 1000) {
    throw new Error(`maxTurns must be an integer between 1 and 1000 (got ${String(raw)})`);
  }
  return raw;
}

/**
 * Provider 上下文溢出判定（F4 一次性安全恢复的触发条件）：仅 invalid_request（HTTP 400/409/422）
 * 且消息命中已知上下文长度签名才视为溢出。其他 400（参数非法、模型不存在等）绝不触发压缩恢复，
 * 避免把真实配置错误掩盖成一轮又一轮的无效压缩。签名保持紧凑：误伤面只可能是「消息里恰好
 * 提到 context length 的其他 400」，代价是一次多余的压缩，可接受。
 */
const CONTEXT_OVERFLOW_MESSAGE = /context.?length|too many tokens|maximum context|prompt is too long/i;

export function isContextOverflowError(error: unknown): boolean {
  return error instanceof ProviderError && error.kind === "invalid_request" && CONTEXT_OVERFLOW_MESSAGE.test(error.message);
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

const SPAWN_SUBAGENT_TOOL: ProviderTool = {
  name: SUBAGENT_TOOL,
  description:
    "Launch a sub-agent with an isolated context to work on a task. " +
    "The sub-agent does not share this session's context; only its final conclusion (at most 64000 characters) is returned. " +
    "Built-in agent types: explore (default; read-only read_file, glob, grep, read_artifact) and general (write-capable coding tools, run through the session permission chain and sandbox). " +
    "Custom sub-agents from the catalog are always read-only. Sub-agents cannot spawn further sub-agents.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Self-contained task description: the sub-agent cannot see this conversation, the project's convention files, or current session state, so include the exact task, relevant file paths to read, project conventions, expected language, and what to report back. If the sub-agent must read specific files, list them explicitly." },
      agent: { type: "string", description: "Built-in sub-agent type (explore or general) or a custom sub-agent name from the system prompt catalog." },
      tools: {
        type: "array",
        items: { type: "string", enum: [...GENERAL_AGENT_TOOL_NAMES] },
        description: "Subset of the resolved agent type's tool allowlist; names outside that allowlist are ignored. Defaults to the type's full allowlist (explore: read_file/glob/grep/read_artifact).",
      },
      role: {
        type: "string",
        enum: [...MODEL_ROLES],
        description: "Optional model tier for the sub-agent (see the sub-agent model-role mapping in the system prompt; defaults to balanced when omitted). Explicit provider:/model: in a custom agent's frontmatter takes precedence over any role.",
      },
      maxTurns: {
        type: "number",
        description: "Optional per-call turn limit (1-1000) overriding the session default; the sub-agent stops after this many provider turns.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

/** swarm 单项数上限：低于 Kimi Code AgentSwarm 的 128，作为自托管部署的成本护栏。 */
const SPAWN_SWARM_MAX_ITEMS = 16;
// spawn_swarm 并发成员数（原常量 4）已配置化：AgentRunner.spawnSwarmConcurrencyLimit 现读
// 设置项 spawnSwarmConcurrency（2–16，默认 4），执行点在下方 worker 池。

/** 系统提示中四档角色的一句话语义（引导主模型按任务选档）。 */
const SUB_AGENT_ROLE_GUIDANCE: Record<ModelRole, string> = {
  premium: "highest quality; use for hard reasoning, deep review, or high-stakes tasks",
  balanced: "default quality/cost trade-off; suitable for most tasks",
  fast: "lowest latency; use for quick lookups and simple transformations",
  cheap: "lowest cost; use for bulk or low-stakes fan-out work",
};

/** 手动启动（REST）子代理的每会话并发上限，超出直接 429（独立于 subagent/spawn_swarm 并行配置；手动路径后续计划归档）。 */
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
  /** 角色档/frontmatter provider: 解析出的 provider 覆盖；缺省用会话 provider。 */
  providerOverride?: string;
  toolNames: string[];
  maxTurns?: number;
}

const SPAWN_SWARM_TOOL: ProviderTool = {
  name: "spawn_swarm",
  description:
    "Launch multiple sub-agents from one prompt template over different inputs, running in parallel (launches beyond the concurrency limit are queued). " +
    "The {{item}} placeholder in prompt_template is replaced with each item's task value; each item launches one independent sub-agent with an isolated context. " +
    "Use when many independent tasks of the same kind should run in parallel (e.g. reviewing several files or endpoints). " +
    "For a single task use subagent instead. Built-in agent types: explore (default; read-only) and general (write-capable, via the session permission chain); custom sub-agents are read-only. " +
    "Members of one swarm share a discussion board (swarm_board_post/swarm_board_read) so they can exchange findings while running. " +
    "Only each sub-agent's final conclusion (at most 64000 characters) is returned, aggregated as numbered results with a board digest.",
  inputSchema: {
    type: "object",
    properties: {
      prompt_template: { type: "string", description: "Prompt template for every sub-agent; must contain the {{item}} placeholder where each item's task value is substituted. Each sub-agent cannot see this conversation, the project's convention files, or current session state, so make the template self-contained: include the task, relevant file paths to read, project conventions, expected language, and what to report back. If a sub-agent must read specific files, list them explicitly." },
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
                role: { type: "string", enum: [...MODEL_ROLES], description: "Optional model tier overriding the call-level role for this item only." },
                maxTurns: { type: "number", description: "Optional per-item turn limit (1-1000) overriding the call-level maxTurns for this item only." },
              },
              required: ["task"],
              additionalProperties: false,
            },
          ],
        },
        description: "Values used to fill {{item}}. Each item launches one sub-agent; 2-16 items, and the filled-in prompts must be distinct. An item may be a plain string or an object { task, agent?, role?, maxTurns? } to override the agent, model tier, or turn limit for that item.",
      },
      agent: { type: "string", description: "Built-in sub-agent type (explore or general) or a custom sub-agent name from the system prompt catalog, applied to every launch unless an item overrides it." },
      role: {
        type: "string",
        enum: [...MODEL_ROLES],
        description: "Optional model tier applied to every launch unless an item overrides it (see the sub-agent model-role mapping in the system prompt; defaults to balanced when omitted). Explicit provider:/model: in a custom agent's frontmatter takes precedence over any role.",
      },
      maxTurns: {
        type: "number",
        description: "Optional call-level turn limit (1-1000) applied to every launch unless an item overrides it.",
      },
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

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
  activeForm?: string;
}

const REMEMBER_TOOL: ProviderTool = {
  name: "remember",
  description:
    "Use this only when the user explicitly asks you to remember something. " +
    "Choose the scope by the fact's nature: \"project\" writes the workspace .owc/memory.md (project-specific facts), " +
    "\"global\" writes the server data-root memory.md shared by all sessions (cross-project facts). " +
    "Saved facts are injected into the system prompt on every turn.",
  inputSchema: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The fact to remember, stored as a single bullet." },
      scope: { type: "string", enum: ["project", "global"], description: "Where to store the fact: project or global." },
    },
    required: ["fact"],
    additionalProperties: false,
  },
};

const TASK_OUTPUT_TOOL: ProviderTool = {
  name: "task_output",
  description: "Read the output of a background task started with bash run_in_background=true. " +
    "Set block=true to wait until the task finishes (up to timeoutMs, default 30s); otherwise the output produced so far is returned.",
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
  /** 会话实际选中的 shell（探测后的具体解释器，描述按它生成）。 */
  shell: ResolvedShell;
  pythonEnv: PythonEnv;
  /** 并行子代理（spawn_swarm）开关：会话级，默认关闭。 */
  swarmEnabled: boolean;
  /** cron 定时任务（提交⑫）：调度器注入后下发 cron_create/cron_list/cron_delete。 */
  cronEnabled: boolean;
  /** 当前模型的媒体输入模态（按轮从能力档案解析）：两者皆无时不下发 read_media。 */
  media: { image: boolean; video: boolean };
}): ProviderTool[] {
  return [
    bashTool(options.backgroundTasksEnabled, options.shell, options.pythonEnv),
    ...FILE_TOOLS,
    ...(options.media.image || options.media.video ? [readMediaTool(options.media)] : []),
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
    SPAWN_SUBAGENT_TOOL,
    ...(options.swarmEnabled ? [SPAWN_SWARM_TOOL] : []),
    TODO_WRITE_TOOL,
    REMEMBER_TOOL,
    ASK_USER_TOOL,
    ...(options.fetchAvailable ? [WEB_FETCH_TOOL] : []),
    ...(options.backgroundTasksEnabled ? [TASK_OUTPUT_TOOL, TASK_STOP_TOOL] : []),
    ...(options.searchAvailable ? [WEB_SEARCH_TOOL] : []),
    ...(options.cronEnabled ? [CRON_CREATE_TOOL, CRON_LIST_TOOL, CRON_DELETE_TOOL] : []),
  ];
}

/** Scheduling metadata is product-side only; Provider schemas remain unchanged. */
type ToolExecutionClass = "read_only" | "workspace_write" | "process" | "external";
const TOOL_EXECUTION_CLASS: Readonly<Record<string, ToolExecutionClass>> = {
  read_file: "read_only", read_media: "read_only", glob: "read_only", grep: "read_only", read_artifact: "read_only", load_skill: "read_only", repo_map: "read_only", code_search: "read_only",
  git_status: "read_only", git_diff: "read_only", ask_user: "read_only", exit_plan_mode: "read_only",
  web_fetch: "external", web_search: "external", write_file: "workspace_write", edit_file: "workspace_write",
  bash: "process", task_output: "read_only", task_stop: "process", todo_write: "workspace_write", remember: "workspace_write", subagent: "process", [SUBAGENT_LEGACY_NAME]: "process", spawn_swarm: "process", test_runner: "process",
  swarm_board_post: "read_only", swarm_board_read: "read_only",
  cron_create: "read_only", cron_list: "read_only", cron_delete: "read_only",
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

/** 交互原始回答 → 工具结果：confirm 布尔；select 为选中项 label 数组（web 提交 opt-<index> id 或 other:<自定义文本>，REST 直提 label 亦可）；text 字符串。 */
function normalizeAskUserAnswer(spec: AskUserQuestionSpec, answer: unknown): unknown {
  if (spec.type === "confirm") return answer === true;
  if (spec.type === "text") return typeof answer === "string" ? answer : "";
  const ids = Array.isArray(answer) ? answer : typeof answer === "string" ? [answer] : [];
  const labels: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    // 「其他」选项回答：other:<自定义文本> → 剥离前缀返回纯文本；空文本丢弃
    if (id.startsWith("other:")) {
      const custom = id.slice("other:".length);
      if (custom) labels.push(custom);
      continue;
    }
    const match = /^opt-(\d+)$/.exec(id);
    const option = match ? spec.options?.[Number(match[1])] : undefined;
    labels.push(option ? option.label : id);
  }
  return labels;
}

/** exit_plan_mode 交互回答 → 决定：approve（按原文执行）/ edit（按用户改后文本执行）/ reject（附意见保持 plan 模式）。 */
type PlanApprovalDecision = { kind: "approve" } | { kind: "edit"; plan: string } | { kind: "reject"; feedback: string };
/** 无法解析的回答一律按 reject 处理：计划批准是人工确认门，绝不因响应畸形而自动放行。 */
function parsePlanApprovalDecision(answer: unknown): PlanApprovalDecision {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return { kind: "reject", feedback: "响应无法解析" };
  const record = answer as Record<string, unknown>;
  if (record.decision === "approve") return { kind: "approve" };
  if (record.decision === "edit" && typeof record.plan === "string" && record.plan.trim()) return { kind: "edit", plan: record.plan };
  if (record.decision === "reject") return { kind: "reject", feedback: typeof record.feedback === "string" ? record.feedback.trim() : "" };
  return { kind: "reject", feedback: "响应无法解析" };
}

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
    lines.push("- After a tool error, adjust using the returned error rather than retrying the identical call.");
  }
  lines.push("- Before finishing, run focused verification (tests or equivalent) and report the result.");
  return lines.join("\n");
}

function planModeSection(enabled: boolean): string {
  // 两分支都点名「写/执行工具仍列出但会被拒」：模型看到完整工具表时不再无效调用写工具。
  const rejection = " Write and exec tools remain listed but are rejected in plan mode — use only read-only tools.";
  if (enabled) {
    return "\n\nYou are in PLAN mode (read-only). Investigate with read-only tools, write a step-by-step implementation plan, then call exit_plan_mode exactly once with the full plan to request user approval. Only after approval may you execute it." + rejection;
  }
  return "\n\nYou are in PLAN mode. Assess the available conversation context and output a step-by-step implementation plan for the user to review before execution." + rejection;
}

/** goal 模式提示词段：全能力模式（无 plan 的只读门禁），融合 KimiCode /goal 自主推进语义，要求每轮末行输出目标自评标记。 */
function goalModeSection(): string {
  return [
    "\n\n## Goal mode",
    "You are in GOAL mode: the user is tracking a goal. Work through it end-to-end: plan internally, execute without pausing for confirmation between steps, and do not re-ask questions answerable from the codebase. Stop and report only on an unrecoverable blocker. Every turn must end with a self-assessment marker on its own final line: GOAL_COMPLETE when the goal is fully achieved, or GOAL_INCOMPLETE: <one sentence of remaining work> otherwise. Do not mention this mechanism anywhere else.",
  ].join("\n");
}

function communicationSection(defaultLanguage: string): string {
  return [
    "\n\n## Communication",
    `- Reply in the user's language (default ${defaultLanguage}); keep Chinese terminology consistent in Chinese replies.`,
    "- Be brief and outcome-oriented; skip filler, placeholders, and unnecessary explanation.",
  ].join("\n");
}

const SAFETY_BOUNDARY_SECTION = [
  "\n\n## Safety boundary",
  "- Stay within the workspace; do not access files outside it. Do not perform destructive or irreversible actions without the user's explicit approval.",
  "- Do not rewrite Git history, commit, push, send external messages, or otherwise change external systems without the user's explicit approval.",
].join("\n");

/** 编辑器保存被权限链拒绝（plan 只读门禁/用户拒绝）；REST 层映射为 403。 */
export class WorkspaceWriteDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceWriteDeniedError";
  }
}

/**
 * Managed workspace run lease (gate contract).
 *
 * Supplied by the HTTP workspace gate for a managed-session run: an automatic
 * VHDX/qcow2 checkpoint starts with the exclusive side of the gate.  Once the
 * short leaf-switch has finished, the route downgrades it to a normal shared
 * lease for the rest of the agent turn.  Keeping the gate transition owned by
 * app.ts makes it atomic with file/exec/sync routes.
 *
 * `release` belongs to the route layer that acquired the lease; the agent only
 * ever sees the `Omit`ed run view used by `AgentRunOptions.managedWorkspace`.
 */
export interface ManagedWorkspaceRunLease {
  /** `false` means another workspace operation was already using the mount. */
  automaticSnapshotAllowed: boolean;
  /** Idempotently change an exclusive automatic-checkpoint lease to shared. */
  downgradeAfterAutomaticSnapshot?: () => void;
  /** Release the lease (shared/exclusive) once the operation settles. */
  release: () => void;
}

interface AgentRunOptions {
  images?: Array<{ mediaType: string; data: string }>;
  /** 预组装的附件 text 块（app.ts 已读取+截断+包装为 `[Attachment <path>]\n<内容>`）；插入在 images 之后、正文之前 */
  attachments?: Array<{ text: string }>;
  /** app.ts managed-workspace shared/exclusive lease; absent for direct/test runs. */
  managedWorkspace?: Omit<ManagedWorkspaceRunLease, "release">;
  /** A durable follow-up queue entry which becomes applied when its user message is written. */
  queueItemId?: string;
}

/** 0.5.0 Phase 2d：run 级性能采样记录（脱敏：不含消息内容、文件路径、模型名）。 */
interface RunPerfRecord {
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
  /** 提交⑩：agent bash 持久 shell（pty 可用时）；cwd/env 跨调用保持。 */
  private readonly persistentShells: PersistentShellManager;
  /** Active Run snapshots. Historical/latest snapshots live under sessions/<id>/runs/. */
  private readonly runs = new Map<string, AgentRunSnapshot>();
  /** Serialize per-run snapshots so a later state cannot overtake an earlier one on disk. */
  private readonly runWrites = new Map<string, Promise<void>>();
  /** Final assistant output is durable, but hooks/queue cleanup are not yet. */
  private readonly settling = new Set<string>();
  private readonly shells = new Map<string, AbortController>();
  /** 编辑器保存（REST 写）挂起态：与 run/shell 互斥，abort 时一并取消 */
  private readonly workspaceWrites = new Map<string, AbortController>();
  /** steering/消息队列/交互管理外观（实现见 run-control.ts）；公共方法在本类做一行委托，接口不变。 */
  private readonly runControl: RunControl;
  private readonly repeatedCalls = new Map<string, { signature: string; count: number }>();
  private readonly mcpWarningSignatures = new Map<string, string>();
  /** 可编辑提示词覆盖：按 cwd 缓存一次，避免每轮 IO；首次构建时读取。 */
  private readonly promptOverrideCache = new Map<string, PromptOverride>();
  /** 工具形态别名与参数归一（实现见 tool-alias.ts）：每轮随工具表重建，run 结束清理。 */
  private readonly toolAliases: ToolAliasResolver;
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
  /** 长期记忆/项目约定注入段构建（含指纹缓存；实现见 memory-section.ts）。 */
  private readonly memorySections: MemorySectionBuilder;

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

  private cronScheduler?: CronScheduler;

  /** 提交⑫：注入 cron 调度器，启用 cron_create/cron_list/cron_delete 工具。 */
  setCronScheduler(cronScheduler: CronScheduler): void {
    this.cronScheduler = cronScheduler;
  }

  private fastModel?: FastModelClient;

  /** 注入快速模型客户端：review 权限模式的 fast 审核通道（未注入时 review 一律转人工）。 */
  setFastModel(fastModel: FastModelClient): void {
    this.fastModel = fastModel;
  }

  private vaultService?: CompactVaultService;

  /** 注入档案库压缩服务：compact-vault 扩展启用时，85% 水位强制压缩走归档路径（与手动 /compact 同口径）。 */
  setVaultService(vaultService: CompactVaultService): void {
    this.vaultService = vaultService;
  }

  private modelRoles?: ModelRoleResolver;

  /** 注入子代理角色档解析器：subagent/spawn_swarm 的 role 参数与提示词角色映射段（未注入时 role 输入仅校验不生效）。 */
  setModelRoleResolver(modelRoles: ModelRoleResolver): void {
    this.modelRoles = modelRoles;
  }

  /** 提示词覆盖更新后清空缓存，下次构建提示词时重新读取覆盖文件。 */
  refreshPromptOverride(): void {
    this.promptOverrideCache.clear();
  }

  /**
   * 生效的子代理附加指令（项目 > 全局逐面合并后的 subAgentAppend），拼入所有
   * runSubAgent 的 systemExtra——追加在自定义子代理 body 之后。与主提示词覆盖
   * 共用 promptOverrideCache，热更新走同一 refreshPromptOverride 失效路径。
   */
  private async withSubAgentAppend(cwd: string, systemExtra: string | undefined): Promise<string | undefined> {
    let override = this.promptOverrideCache.get(cwd);
    if (!override && this.dataDir) {
      override = await loadPromptOverride(this.dataDir, cwd);
      this.promptOverrideCache.set(cwd, override);
    }
    const append = override?.subAgentAppend;
    if (!append) return systemExtra;
    return systemExtra ? `${systemExtra}\n\n${append}` : append;
  }

  private searchProvider: SearchProvider | undefined;
  private webFetchProvider: WebFetchProvider | undefined;
  /** read_media URL 抓取的 fetch 注入点（测试用 stub；缺省 globalThis.fetch）。 */
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly pythonEnvManager = new UvPythonEnvironments();
  private getPythonEnvDefault: () => PythonEnv = () => "global";
  private readonly nodeEnvManager = new NodeEnvManagers();
  private getNodeEnvDefault: () => NodeEnv = () => "global";
  /** 联网搜索模式懒读取（settings 热生效）：local = 本地 web_search；model-api = 模型服务端搜索。 */
  private getWebSearchMode: () => "local" | "model-api" = () => "local";
  /** 单条消息轮次上限取值函数：默认读构造参数，setMaxTurns 注入后走设置热生效值 */
  private maxTurnsLimit: () => number = () => this.maxTurns;

  /** 注入轮次上限的实时取值函数（index.ts 装配：settings.effective().agentMaxTurns）。 */
  setMaxTurns(get: () => number): void {
    this.maxTurnsLimit = get;
  }

  /** 子代理默认轮次上限取值函数（index.ts 装配：settings.effective().subAgentMaxTurns）。
   *  subagent/spawn_swarm 的显式 maxTurns 参数优先于它；仅作为未指定时的全局默认。 */
  private subAgentMaxTurnsLimit: () => number = () => 100;

  /** 注入子代理默认轮次上限的实时取值函数（index.ts 装配：settings.effective().subAgentMaxTurns）。 */
  setSubAgentMaxTurns(get: () => number): void {
    this.subAgentMaxTurnsLimit = get;
  }

  /** 同一消息内 subagent 类调用的最大并行数（index.ts 装配：settings.effective().subAgentConcurrency）。
   *  默认 2（与设置默认一致）；1 = 逐条串行；>1 且整条消息全为 subagent 类调用时才并行。
   *  只限制同时运行数量，不限制子代理总执行数量（超出的调用排队依次执行）。 */
  private subAgentConcurrencyLimit: () => number = () => 2;

  /** 注入同一消息 subagent 并行数的实时取值函数（index.ts 装配：settings.effective().subAgentConcurrency）。 */
  setSubAgentConcurrency(get: () => number): void {
    this.subAgentConcurrencyLimit = get;
  }

  /** spawn_swarm 并发成员数（index.ts 装配：settings.effective().spawnSwarmConcurrency）；设置校验保证 ≥2。 */
  private spawnSwarmConcurrencyLimit: () => number = () => 4;

  /** 注入 spawn_swarm 并发成员数的实时取值函数（index.ts 装配：settings.effective().spawnSwarmConcurrency）。 */
  setSpawnSwarmConcurrency(get: () => number): void {
    this.spawnSwarmConcurrencyLimit = get;
  }

  /** 自动压缩水位（百分比）取值函数：默认 85，setCompactionThreshold 注入后走设置热生效值。 */
  private compactionThresholdPercent: () => number = () => 85;

  /** 注入自动压缩水位的实时取值函数（index.ts 装配：settings.effective().compactionThresholdPercent）。 */
  setCompactionThreshold(get: () => number): void {
    this.compactionThresholdPercent = get;
  }

  /**
   * 强制压缩统一入口（水位触发 + Provider overflow 一次性恢复共用）：
   * 发布 compacting/compacted 事件（overflow 恢复带 reason:"overflow_recovery" 明确标记）；
   * compact-vault 扩展启用时走档案库压缩（与手动 /compact 同口径），否则 Compactor overview。
   * protectFromMessageId 为本 run 触发消息：压缩区段不得包含它（见 Compactor）。
   * 返回压缩结果（changed:false 由调用方决策）；压缩异常原样抛出。
   */
  private async runForcedCompaction(
    sessionId: string,
    session: SessionMeta,
    vaultForce: boolean,
    protectFromMessageId: string,
    reason?: "overflow_recovery",
  ): Promise<CompactResult> {
    // 开始事件：压缩可能耗时（vault 多次快速模型调用），先给 UI 即时反馈
    this.events.publish({ source: "agent", type: "context.compacting", sessionId, payload: { forced: true, mode: vaultForce ? "vault" : "overview", ...(reason ? { reason } : {}) } });
    let compacted: CompactResult;
    if (vaultForce) {
      const config = this.extensions?.list().find((item) => item.id === "compact-vault")?.config ?? {};
      compacted = await this.vaultService!.compact(sessionId, {
        ...(Number.isSafeInteger(config.keepTail) ? { keepTail: config.keepTail as number } : {}),
        ...(Number.isSafeInteger(config.chunkSize) ? { chunkSize: config.chunkSize as number } : {}),
      });
    } else {
      // 压缩提示词优先级：用户覆盖 > env-sim persona > 内置；用户覆盖与主提示词覆盖共用 promptOverrideCache
      let override = this.promptOverrideCache.get(session.cwd);
      if (!override && this.dataDir) {
        override = await loadPromptOverride(this.dataDir, session.cwd);
        this.promptOverrideCache.set(session.cwd, override);
      }
      const persona = this.extensions
        ? await this.extensions.activeEnvSimPersonaPreset(resolveSessionPersona(session))
        : null;
      const overviewPrompt = override?.compactOverviewOverride ?? persona?.compactOverviewPrompt;
      compacted = await this.compactor!.compact(sessionId, "overview", { forced: true, protectFromMessageId, ...(overviewPrompt ? { promptOverrides: { overview: overviewPrompt } } : {}) });
    }
    if (compacted.changed) {
      this.events.publish({ source: "agent", type: "context.compacted", sessionId, payload: { mode: compacted.mode, uptoIndex: compacted.uptoIndex ?? 0, forced: true, ...(compacted.createdAt ? { createdAt: compacted.createdAt } : {}), ...(reason ? { reason } : {}) } });
    }
    return compacted;
  }

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
    fetchImpl?: typeof fetch,
    private readonly backgroundTasks?: BackgroundTaskRegistry,
    private readonly hooks?: HookRunner,
    private readonly extensions?: ExtensionManager,
    webFetchProvider?: WebFetchProvider,
  ) {
    this.coreGateway = new CoreGateway(core);
    this.memorySections = new MemorySectionBuilder(dataDir);
    this.persistentShells = new PersistentShellManager(core, this.pythonEnvManager, () => this.getPythonEnvDefault(), this.nodeEnvManager, () => this.getNodeEnvDefault(), dataDir);
    this.runControl = new RunControl({
      sessions: this.sessions,
      events: this.events,
      running: this.running,
      settling: this.settling,
      run: (sessionId, text, options) => this.run(sessionId, text, options),
      notify: (payload) => this.runNotificationHook("Notification", payload),
    });
    this.permissions = new PermissionCoordinator(events);
    this.toolAliases = new ToolAliasResolver();
    this.repoMap = new RepoMapGenerator(core);
    this.searchProvider = search;
    this.fetchImpl = fetchImpl;
    this.webFetchProvider = webFetchProvider;
    core.on("event", (event: CoreEvent) => {
      // core 崩溃自动重启重新握手后能力快照失效：下次用到时重新协商（崩溃期间的
      // 失败 Promise 已由 CoreGateway 自身不缓存失败的语义覆盖）
      if (event.type === "core.ready") this.coreGateway.invalidate();
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

  /** nodeEnv 全局默认的懒读取（settings 热生效，无需热应用回调）。 */
  setNodeEnvDefault(getter: () => NodeEnv): void {
    this.getNodeEnvDefault = getter;
  }

  /** 联网搜索模式的懒读取（settings 热生效，无需热应用回调）。 */
  setWebSearchMode(getter: () => "local" | "model-api"): void {
    this.getWebSearchMode = getter;
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
    // 本轮的轮级共享账本句柄（声明在 try 外层，finally 兜底提交可访问）
    let activeTurn: { context: ContextManager; ledger: TurnLedger } | undefined;
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

      const automaticSnapshotRequested = (configuredSession.snapshotMode ?? "auto") === "auto"
        // 本机会话（kind=local）不做快照：不探测后端、不建 git-shadow，避免在 HOME 上留元数据
        && configuredSession.kind !== "local";
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
        const applied = await this.runControl.applyFollowUp(sessionId, followUpQueueItemId, triggerMessage.id);
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
          const checkpoint = await (await getSnapshotBackend(this.sessions, configuredSession, { core: this.core }))
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
      // Provider 上下文溢出的一次性安全恢复（F4）：与水位 forceCompacted 相互独立——
      // 水位是预防（阈值 100 可关），溢出恢复是兜底（恒开）；各每 run 至多一次。
      // 水位压缩已发生仍溢出时恢复仍可触发一次；恢复后再次溢出则按原错误失败。
      let overflowRecovered = false;
      // 会话级模型 fallback（仅主循环）：主模型在 collectProviderTurn 重试耗尽后仍抛
      // 可恢复 ProviderError 时，切到 fallbackModels 链下一个未尝试的候选重建本轮。
      // 每个候选每 run 只尝试一次；链穷尽按原 agent.error 路径结束。切换只影响
      // 本 run 的后续 turn，不写回会话主模型字段。
      let modelOverride: { provider: string; model: string } | undefined;
      const fallbackTried = new Set<string>();
      // 0.5.0 Phase 2d：性能采样初始化
      perfStartedAt = performance.now();
      perfStartedAtIso = new Date().toISOString();
      perfActive = true;
      // 轮次上限每次运行取一次当前生效值（设置页热生效），运行途中不随设置改变
      const maxTurns = this.maxTurnsLimit();
      for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
        controller.signal.throwIfAborted();
        this.setTurnIndex(sessionId, turnIndex);
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        // fallback 切换后的生效模型（未切换 = 会话主模型）；上下文窗口/能力按此重新解析
        const effectiveProvider = modelOverride?.provider ?? session.provider;
        const effectiveModel = modelOverride?.model ?? session.model;
        const context = new ContextManager(this.sessions.contextRoot(sessionId));
        // 轮级共享句柄：一轮 load 一次（克隆 1 次），本轮 budgetStatus/buildView/记账/驱逐共用，
        // 出口处 commitTurn 统一落盘（有变更才写）——替代过去每轮 ~6 次全量克隆 + 2 次落盘。
        const turnLedger = await context.beginTurn();
        activeTurn = { context, ledger: turnLedger };
        const budget = await context.budgetStatus(turnLedger);
        if (budget.paused) {
          await this.state(sessionId, "budget_paused");
          this.events.publish({ source: "agent", type: "agent.budget_paused", sessionId, payload: budget });
          activeTurn = undefined;
          return;
        }
        // 选择性上下文（§4.4）：pin 不被驱逐、排除不进组装；配置持久化在会话 meta。
        // 选择性上下文是 context-saver 扩展能力：扩展关闭时 pins/excludes 不生效（传空）。
        const saverOn = !this.extensions || this.extensions.isEnabled("context-saver");
        const contextSelection = saverOn
          ? { pins: session.contextPins ?? [], excludes: session.contextExcludes ?? [] }
          : { pins: [] as string[], excludes: [] as string[] };
        const ctxBuildStart = performance.now();
        // 消息树：上下文只组装活动路径（根→活动叶子），checkout/retry 出的旧分支不进 provider 历史。
        const view = await context.buildView(activePathMessages(session.messages, session.activeLeafId), { selection: contextSelection }, turnLedger);
        // 首轮判定的用户消息计数在 hook 变换（transformContext/beforeSend）之前采样：
        // 扩展注入/改写的 user 消息不影响首轮形态判定；/clear 与压缩的视图裁剪仍生效
        //（clear 后重新计为首回合）。压缩摘要头（id 以 compaction: 开头的 user 角色占位
        // 消息）不计入——否则首回合工具循环内触发压缩会让形态在同一回合中途翻转。
        const visibleUserTurns = view.messages.filter((message) => message.role === "user" && !message.id.startsWith("compaction:")).length;
        perfContextBuildMs += performance.now() - ctxBuildStart;
        if (this.extensions) {
          // transformContext 与 beforeSend 共用同一份 ledger 摘要：entries 的 O(n) 映射与
          // compacted/cleared 条件展开只构造一次，避免每轮两遍全量 entries 拷贝。
          const ledgerSummary = {
            round: view.ledger.round,
            entries: view.ledger.entries.map((entry) => ({ messageId: entry.messageId, state: entry.state, pinnedUntilRound: entry.pinnedUntilRound })),
            ...(view.ledger.compacted ? { compacted: { summary: view.ledger.compacted.summary, instructions: view.ledger.compacted.instructions, mode: view.ledger.compacted.mode } } : {}),
            ...(view.ledger.cleared ? { cleared: { at: view.ledger.cleared.at } } : {}),
          };
          const transformed = await this.extensions.transformContext({
            sessionId,
            cwd: session.cwd,
            messages: view.messages,
            ledger: ledgerSummary,
          });
          view.messages = transformed.messages;
          if (transformed.metadata) this.events.publish({ source: "agent", type: "extension.context_transformed", sessionId, payload: transformed.metadata });
          const beforeSend = await this.extensions.beforeSend({
            sessionId,
            cwd: session.cwd,
            messages: view.messages,
            ledger: ledgerSummary,
          });
          view.messages = beforeSend.messages;
        }
        const cacheBreakpoints = selectCacheBreakpoints(view.messages, view.ledger);
        await context.recordCacheBreakpoints(cacheBreakpoints, turnLedger);
        // 断点策略写入 run 诊断：事件流可查，ledger.cacheBreakpoints 持久化供 Context 面板展示；
        // providerCaching 为 null 表示该 Provider 无显式断点（如 OpenAI 兼容的自动缓存）。
        this.events.publish({
          source: "agent",
          type: "context.cache_strategy",
          sessionId,
          payload: {
            provider: effectiveProvider,
            providerCaching: this.providers.get(effectiveProvider)?.promptCaching ?? null,
            messageBreakpoints: cacheBreakpoints,
          },
        });
        const profile = this.getProfile(effectiveModel, effectiveProvider);
        // 索引新鲜度（Phase 2 §4.1）：turn 边界检查。watch 激活时零成本；
        // watch 不可用时 mtime 抽样标滞后。失败/缺失都不阻断运行。
        if (this.indexManager) void this.indexManager.noteTurnBoundary(sessionId, session.cwd).catch(() => undefined);
        // repo map 预算段（§4.1 Phase 1）：默认不注入：显式开启（repoMapEnabled === true）才注入；
        // 生成失败降级为空段，不阻断运行。
        // 注入位置在稳定 system 前缀之后的动态侧（systemSuffix），避免其逐 turn 变化污染
        // cache 断点；token 归因到 segments.system（系统提示词桶），Context 面板按段可见。
        // repo map 内容段与 repo_map 工具联动：预设 hideBuiltIns 隐藏 repo_map 工具时，
        // 内容段也不注入（否则模型仍能看到仓库结构，违背工具隐藏意图）。预设仅在显式开启
        // 注入后惰性解析（repo map 默认关，避免每轮空解析/读用户预设目录）；解析失败按
        // 未隐藏处理，不阻断。
        let repoMapSection = "";
        if (session.repoMapEnabled === true) {
          const repoMapToolHidden = this.extensions
            ? (await this.extensions.activeEnvSimPersonaPreset(resolveSessionPersona(session)).catch(() => null))?.hideBuiltIns.includes("repo_map") ?? false
            : false;
          if (!repoMapToolHidden) {
            try {
              const map = await this.repoMap.generate({
                sessionId,
                cwd: session.cwd,
                budget: session.repoMapBudget ?? DEFAULT_REPO_MAP_BUDGET,
                excludes: contextSelection.excludes,
              });
              view.stats.segments.system += map.tokens;
              repoMapSection = `## Repository map (workspace structure; budget-bounded; key files carry symbol summaries when the index is available)\n${map.text}`;
            } catch (error) {
              this.events.publish({ source: "agent", type: "context.repo_map_failed", sessionId, payload: { message: errorMessage(error) } });
            }
          }
        }
        // 增量构建的 token 估算与 estimateMessageTokens 同规则；等价性由 server 测试断言。
        const estimatedTokens = view.stats.totalTokens;
        // 输出预留：主循环不给 provider 请求下发 maxTokens（provider 用各自默认/端点默认），
        // 水位按窗口的 1/8 预留输出空间（与 extended thinking 为正文留 1/8 余量同口径），
        // 避免估算顶到窗口上限才触发压缩。
        const outputReserve = Math.max(1, Math.floor(profile.contextWindow / 8));
        // 工作预算扣除系统侧占用与输出预留（F3）：repo map 段已计入 segments.system（上方归因），
        // 且必须在其之后计算水位，保证顺序一致。
        const workingBudget = Math.max(1, profile.contextWindow - view.stats.segments.system - outputReserve);
        const utilization = estimatedTokens / workingBudget;
        // 自动压缩水位（设置页可调，热生效）：强制 = threshold%，建议 = threshold−15%；
        // 100 = 关闭阈值型强制压缩（Provider overflow 的一次性安全恢复不受影响，见 catch 段）
        const thresholdPercent = this.compactionThresholdPercent();
        const forcedCompactionEnabled = thresholdPercent < 100;
        const compactionThreshold = thresholdPercent / 100;
        const compactionRecommend = (thresholdPercent - 15) / 100;
        // pin 占用如实上报：超预算时给明确警告，不悄悄驱逐 pin 的消息。
        const pinWarning = view.stats.pinnedTokens >= workingBudget ? "pins_over_budget" : undefined;
        this.events.publish({ source: "agent", type: "context.watermark", sessionId, payload: { estimatedTokens, contextWindow: profile.contextWindow, workingBudget, utilization, warning: forcedCompactionEnabled && utilization >= compactionThreshold ? "force_compact" : utilization >= compactionRecommend ? "compact_recommended" : undefined, segments: view.stats.segments, pinnedTokens: view.stats.pinnedTokens, buildMs: view.stats.buildMs, incremental: view.stats.incremental, ...(pinWarning ? { pinWarning } : {}) } });
        // 水位强制压缩（核心安全网，不随 context-saver 扩展开关）：压缩成功后重建视图（消耗一个 turn 防止死循环）。
        // compact-vault 扩展启用时走档案库压缩（与手动 /compact 同口径）；compactor 缺失时 vault 单独兜底。
        const vaultForce = this.vaultService !== undefined && this.extensions?.isEnabled("compact-vault") === true;
        if (forcedCompactionEnabled && utilization >= compactionThreshold && (this.compactor || vaultForce) && !forceCompacted) {
          forceCompacted = true;
          try {
            // 本轮触发用户消息受保护：压缩区段到触发消息之前为止（见 Compactor protectFromMessageId）
            const compacted = await this.runForcedCompaction(sessionId, session, vaultForce, triggerMessage.id);
            if (compacted.changed) {
              // 压缩自身已落盘；commitTurn 检测到外部落盘会把本轮断点变更重放到最新账本
              await context.commitTurn(turnLedger);
              activeTurn = undefined;
              continue;
            }
          } catch (error) {
            // 压缩失败不阻断运行：记录后按未压缩视图继续
            this.events.publish({ source: "agent", type: "context.compact_failed", sessionId, payload: { message: errorMessage(error) } });
          }
        }
        const provider = this.providers.get(effectiveProvider);
        if (!provider) throw new Error(`Provider ${effectiveProvider} is not configured`);

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
        // 会话级 toolsAllow/toolsDeny 先作用于内置工具表（交互类始终保留；MCP/扩展工具不受影响）。
        const builtIns = filterBuiltInTools(builtInTools({
          skillsAvailable: skillCatalog.length > 0,
          backgroundTasksEnabled: Boolean(this.backgroundTasks),
          fetchAvailable: Boolean(this.webFetchProvider),
          // model-api 模式下本地 web_search 不注入（搜索由模型服务端执行）；web_fetch 不受影响
          searchAvailable: this.getWebSearchMode() === "local" && Boolean(this.searchProvider),
          shell: resolveShell(session.shellBackend ?? "default"),
          pythonEnv: effectivePythonEnv(session.pythonEnv, this.getPythonEnvDefault()),
          swarmEnabled: session.swarmEnabled === true,
          cronEnabled: Boolean(this.cronScheduler),
          // read_media 按当前模型的媒体输入模态门控（fallback 切换后下一轮自动跟随）
          media: {
            image: profile.capabilities.modalities.includes("image"),
            video: profile.capabilities.modalities.includes("video"),
          },
        }), session.toolsAllow, session.toolsDeny);
        const shaping = toolsEnabled && this.extensions
          ? await this.extensions.activeToolShaping(builtIns.map((tool) => tool.name), resolveSessionPersona(session))
          : undefined;
        // 工具拟态应用（hideBuiltIns 过滤 + 别名重命名/克隆，含同源多别名）抽到
        // tool-schemas.applyToolShaping：纯函数、可单测，主循环只消费结果。
        const shapingApplication = shaping
          ? applyToolShaping(builtIns, shaping)
          : { tools: builtIns, aliasMap: new Map<string, string>(), aliasArgMaps: new Map<string, Record<string, string>>() };
        let shapedBuiltIns = shapingApplication.tools;
        // 首轮形态：预设可声明 firstTurnOnlyTools——用户消息数 <= 1（第一条用户消息
        // 之后、用户发出第二条消息之前）只注入声明的内置工具；模型在同一回合内的
        // 多轮工具调用循环保持该形态，用户发出第二条消息后才恢复完整保留形态。
        // 计数用 hook 变换前采样的 visibleUserTurns（压缩摘要头与扩展注入均不计入）。
        // 仅首轮解析一次预设（读用户预设目录），后续轮次零成本。
        const isFirstTurn = visibleUserTurns <= 1;
        let firstTurnOnly: string[] | undefined;
        if (isFirstTurn && this.extensions) {
          const persona = await this.extensions.activeEnvSimPersonaPreset(resolveSessionPersona(session)).catch(() => null);
          firstTurnOnly = persona?.firstTurnOnlyTools;
        }
        if (firstTurnOnly && isFirstTurn) {
          // 旧用户预设 firstTurnOnlyTools 里的 spawn_task 归一为 subagent（兼容匹配）
          const allow = new Set(firstTurnOnly.map((name) => (isSubagentToolName(name) ? SUBAGENT_TOOL : name)));
          shapedBuiltIns = shapedBuiltIns.filter((tool) => allow.has(tool.name));
        }
        // 首轮极简提示词：firstTurnOnlyTools 生效时（首轮形态），系统提示词只保留 persona
        // 基础提示词与工具表渲染——项目上下文、安全边界、技能段、自定义指令、尾注、后台
        // 通知等段落一律跳过，用户发出第二条消息后恢复完整形态。
        const minimalPromptTurn = isFirstTurn && firstTurnOnly !== undefined;
        // 自动驱逐联动：驱逐把被逐出的消息替换为 artifact 占位符（占位符指引模型用
        // read_artifact 恢复），若预设形态隐藏了 read_artifact 而会话驱逐策略开启
        //（enabled 且非 off），强制放行 read_artifact——否则占位符成为死胡同。
        // 会话 toolsDeny 显式禁止时仍尊重拒绝；ledger 缺失/损坏视为驱逐关闭；
        // 首轮双工具形态（firstTurnOnlyTools）期间不联动，用户发第二条消息后生效。
        // 驱逐是 context-saver 扩展能力：扩展关闭（saverOn=false）时不联动。
        if (saverOn && (!firstTurnOnly || !isFirstTurn) && !shapedBuiltIns.some((tool) => tool.name === "read_artifact") && !(session.toolsDeny ?? []).includes("read_artifact")) {
          // 驱逐策略直读本轮 beginTurn 的轮级句柄（同一磁盘账本的 working 副本），
          // 免去每轮二次 new ContextManager().load() 全量加载 ledger 只为读 policy。
          const evictionOn = turnLedger.working.policy.enabled && turnLedger.working.policy.strategy !== "off";
          if (evictionOn) shapedBuiltIns = [...shapedBuiltIns, READ_ARTIFACT_TOOL];
        }
        this.toolAliases.setShaping(sessionId, shapingApplication.aliasMap, shapingApplication.aliasArgMaps);

        const tools = toolsEnabled
          ? [
              ...shapedBuiltIns,
              // plan 模式专属批准出口：仅主 agent、仅 plan 模式下发（子代理工具集由 SUB_AGENT_TOOL_NAMES 过滤，不含此项）
              ...(session.agentMode === "plan" ? [EXIT_PLAN_MODE_TOOL] : []),
              ...mcpBinding.tools,
              ...extensionTools,
            ]
          : [];
        const availableToolNames = new Set(tools.map((tool) => tool.name));
        const skillSection = availableToolNames.has("load_skill")
          ? `\n\nAvailable skills (load full text with the load_skill tool when relevant; the user can also trigger one with /name):\n${skillCatalog.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
          : "";
        const agentSection = (availableToolNames.has(SUBAGENT_TOOL) || availableToolNames.has(SUBAGENT_LEGACY_NAME)) && agentCatalog.length > 0
          ? `\n\nAvailable sub-agents (pass agent=<name> to subagent; built-in types explore (default, read-only) and general (write-capable, via the session permission chain) are always available; the custom agents below are read-only):\n${agentCatalog.map((agent) => {
            const ignored = (agent.tools ?? []).filter((tool) => !(SUB_AGENT_TOOL_NAMES as readonly string[]).includes(tool));
            return `- ${agent.name}: ${agent.description}${ignored.length > 0 ? ` (unsupported tools ignored: ${ignored.join(", ")})` : ""}`;
          }).join("\n")}\nSub-agents cannot see this conversation, the project's convention files, or current session state: make each task prompt self-contained (exact task, relevant file paths to read, project conventions, expected language, what to report back). If a sub-agent must read specific files, list them explicitly.`
          : "";
        // 子代理角色档映射段：动态构建、随 settings 热更新（resolver 每轮现读 effective()）；
        // 未配置的档标注回落目标，引导主模型按任务难度选档。
        const roleSection = (availableToolNames.has(SUBAGENT_TOOL) || availableToolNames.has(SUBAGENT_LEGACY_NAME)) && this.modelRoles
          ? `\n\nSub-agent model roles (pass role=<tier> to subagent/spawn_swarm to route the sub-agent to the configured model tier; choose the tier that fits the task):\n${MODEL_ROLES.map((role) => {
            const selection = this.modelRoles!.resolve(role);
            const current = selection
              ? `${selection.model} [${selection.provider}]`
              : role === "balanced"
                ? "not configured, falls back to the session model"
                : "not configured, falls back to balanced";
            return `- ${role}: ${SUB_AGENT_ROLE_GUIDANCE[role]} (current: ${current})`;
          }).join("\n")}\nAn explicit provider:/model: in a custom sub-agent's frontmatter overrides any role; without a role, sub-agents default to the balanced tier (falling back to the session model when balanced is not configured).`
          : "";

        // 长期记忆注入（§2.3/§7.5）：CLAUDE.md/AGENTS.md + 项目/全局 memory.md，每轮现读
        const memorySection = await this.memorySections.build(session.cwd);

        // 可编辑提示词覆盖：按 cwd 缓存一次（首次读取文件，后续复用）
        let promptOverride = this.promptOverrideCache.get(session.cwd);
        if (!promptOverride && this.dataDir) {
          promptOverride = await loadPromptOverride(this.dataDir, session.cwd);
          this.promptOverrideCache.set(session.cwd, promptOverride);
        }

        // 后台任务完成提示（读后即清）
        // 后台任务是工具能力的一部分；不支持工具的模型既不注入也不消费待发送通知。
        // 首轮极简提示词（minimalPromptTurn）不消费也不注入后台通知：通知保留到下一轮，
        // 避免首轮形态泄漏后台信息。
        const bgNotices = toolsEnabled && !minimalPromptTurn ? (this.backgroundTasks?.drainNotices(sessionId) ?? []) : [];
        const bgNoticeSection = bgNotices.length > 0 ? `\n\n${bgNotices.join("\n")}` : "";

        const baseProductSections = [
          workDisciplineSection(availableToolNames),
          communicationSection(this.defaultLanguage),
          session.agentMode === "plan" ? planModeSection(toolsEnabled) : "",
          session.agentMode === "goal" ? goalModeSection() : "",
          availableToolNames.has("spawn_swarm")
            ? "## Parallel exploration\nspawn_swarm is enabled: when a task fans out into many independent subtasks of the same kind, launch them in one spawn_swarm call instead of serial subagent calls. Members of a swarm coordinate via the shared discussion board (swarm_board_post/swarm_board_read)."
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
            // 会话级扩展状态随载荷下发，扩展可在 prompt.beforeBuild 里读取自己的会话级配置
            ...(session.extensionState ? { extensionState: session.extensionState } : {}),
          }, resolveSessionPersona(session));
        }
        const effectiveBaseOverride = promptTransform.basePromptOverride ?? promptOverride?.baseOverride;
        // 身份行优先级：env-sim persona 身份（transformPrompt）> identity 覆盖文件 > 默认行
        const effectiveIdentity = promptTransform.identity ?? promptOverride?.identityOverride;

        const system = buildSystemPrompt({
          cwd: session.cwd,
          tools,
          ...(effectiveIdentity ? { identity: effectiveIdentity } : {}),
          productSections: [...(promptTransform.prependSections ?? []), ...(promptTransform.productSections ?? baseProductSections)],
          // 首轮极简提示词：跳过安全边界段（finalConstraints），第二轮起恢复
          finalConstraints: minimalPromptTurn ? [] : [SAFETY_BOUNDARY_SECTION],
          // 首轮极简提示词：跳过技能/代理/角色段（skillsSection），第二轮起恢复
          skillsSection: minimalPromptTurn ? "" : `${skillSection}${agentSection}${roleSection}`,
          // 首轮极简提示词：跳过项目上下文段（project_instructions），第二轮起恢复
          projectContext: minimalPromptTurn ? [] : (memorySection ? [{ path: "workspace instructions and memory", content: memorySection }] : []),
          ...(effectiveBaseOverride ? { basePromptOverride: effectiveBaseOverride } : {}),
          // 首轮极简提示词：跳过用户自定义指令（customAppend），第二轮起恢复
          ...(promptOverride?.customAppend && !minimalPromptTurn ? { customAppend: promptOverride.customAppend } : {}),
          // 首轮极简提示词：跳过尾注（Prompt version / Current date / Current working directory）
          ...(minimalPromptTurn ? { suppressTrailer: true } : {}),
        });
        await this.state(sessionId, "streaming");
        const providerCallStart = performance.now();
        // thinking/effort 用户优先、不设限透传（1.9.5 起不做模型级白名单过滤；
        // 全局枚举合法性校验在路由层已完成；fallback 模型能力差异不影响此处）
        const reasoning = {
          ...(session.thinking ? { thinking: session.thinking } : {}),
          ...(session.effort ? { effort: session.effort } : {}),
        };
        let turn: { attemptId: string; events: ProviderEvent[] };
        try {
          turn = await collectProviderTurn(
            provider,
            {
              model: effectiveModel,
              ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
              ...(reasoning.effort ? { effort: reasoning.effort } : {}),
              // 思考方式声明（模型目录 capabilities.thinkingStyle 内置默认，用户可覆盖）：
              // provider 按此分发各端点思考参数 key（thinking:{type} / enable_thinking /
              // effort_only / fixed / anthropic extended-adaptive）
              ...(profile.capabilities.thinkingStyle ? { thinkingStyle: profile.capabilities.thinkingStyle } : {}),
              // 思维链回传按模型能力声明下发（未声明 = 默认开；gpt/claude 前缀元数据已声明关）
              reasoningContent: profile.capabilities.reasoningContent !== false,
              // 官方 OpenAI Responses 加密思维链回放按模型能力声明下发（仅 gpt/o 系元数据开启）
              ...(profile.capabilities.responsesEncryptedReplay ? { responsesEncryptedReplay: true } : {}),
              // 联网搜索模式：model-api 时下发请求级标记（仅 OpenAI Responses 接口消费，其他 provider 忽略）
              serverWebSearch: this.getWebSearchMode() === "model-api",
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
                // 重试会从头重推 delta：先让前端丢弃上一 attempt 的增量，避免重复文本
                this.events.publish({ source: "agent", type: "message.stream_reset", sessionId, payload: {} });
                this.events.publish({
                  source: "agent",
                  type: "provider.retry",
                  sessionId,
                  payload: { attemptId, attempt, delayMs, kind: error.kind, message: error.message },
                });
              },
              // 流式显示：事件到达即发布，不再等整轮收集完毕后补发
              onEvent: (event) => {
                if (event.type === "text_delta") {
                  this.events.publish({ source: "agent", type: "message.delta", sessionId, payload: { text: event.text } });
                } else if (event.type === "thinking_delta") {
                  this.events.publish({ source: "agent", type: "message.thinking_delta", sessionId, payload: { text: event.text } });
                } else if (event.type === "tool_call_delta") {
                  this.events.publish({ source: "agent", type: "message.tool_call_delta", sessionId, payload: { id: event.id, ...(event.name ? { name: event.name } : {}), text: event.argumentsDelta } });
                } else if (event.type === "server_tool") {
                  // 服务端工具活动（如 DeepSeek web_search）：合成 tool.start/end 复用
                  // LiveActivity 现有链路展示，toolCallId 固定不入消息历史
                  if (event.phase === "start") {
                    this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId: `server:${event.tool}`, name: event.tool } });
                  } else if (event.phase === "end") {
                    this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId: `server:${event.tool}` } });
                  }
                }
              },
            },
          );
        } catch (error) {
          // Provider 上下文溢出的一次性安全恢复（F4；AGENTS.md：关闭阈值型 auto compact 后
          // overflow 仍可触发一次明确标记的安全恢复——threshold=100 只关水位、不关本路径）。
          // 与水位 forceCompacted 独立：水位已压过仍溢出时这里再兜底一次；反之恢复后水位
          // 标志保持已置位（同 run 内不再重复水位压缩）。恢复后换一轮重建视图重试 provider；
          // 再次溢出（overflowRecovered 已置位）不再进入此分支，按原错误走下方失败路径。
          if (!controller.signal.aborted && !overflowRecovered && isContextOverflowError(error) && (this.compactor || vaultForce)) {
            overflowRecovered = true;
            let recovered: CompactResult | undefined;
            try {
              recovered = await this.runForcedCompaction(sessionId, session, vaultForce, triggerMessage.id, "overflow_recovery");
            } catch (compactError) {
              // 压缩本身失败：记录后以可行动的溢出错误结束本轮（不吞原始错误）
              this.events.publish({ source: "agent", type: "context.compact_failed", sessionId, payload: { message: errorMessage(compactError) } });
            }
            if (recovered?.changed) {
              await context.commitTurn(turnLedger);
              activeTurn = undefined;
              continue;
            }
            throw new Error(`上下文超出模型上下文窗口，自动安全压缩后仍无可裁减区段（最近消息与本轮触发消息受保护）。请用 /clear 清空上下文、压缩范围后重试，或开启新会话。原始错误：${errorMessage(error)}`);
          }
          // 模型 fallback：可恢复 provider 错误（retryable：overloaded/rate_limit/network/
          // stream_interrupted 等）经重试耗尽后仍失败 → 切到 fallbackModels 链下一个未尝试
          // 且 provider 已配置的候选，重建本轮（消耗一个 turn 序号，上下文/工具按新模型重组）。
          // 不可恢复错误（401 鉴权、400 invalid_request 等）与中断不切换，抛给原 catch。
          if (!controller.signal.aborted && error instanceof ProviderError && error.retryable) {
            fallbackTried.add(`${effectiveProvider} ${effectiveModel}`);
            const chain = [{ provider: session.provider, model: session.model }, ...(session.fallbackModels ?? [])];
            const next = chain.find((candidate) =>
              !fallbackTried.has(`${candidate.provider} ${candidate.model}`) && this.providers.get(candidate.provider) !== undefined);
            if (next) {
              modelOverride = { provider: next.provider, model: next.model };
              // 新模型重新推流：丢弃上一模型的增量（同 onRetry 的 stream_reset 语义）
              this.events.publish({ source: "agent", type: "message.stream_reset", sessionId, payload: {} });
              this.events.publish({
                source: "agent",
                type: "agent.model_fallback",
                sessionId,
                payload: {
                  from: { provider: effectiveProvider, model: effectiveModel },
                  to: { provider: next.provider, model: next.model },
                  kind: error.kind,
                  message: error.message,
                },
              });
              await context.commitTurn(turnLedger);
              activeTurn = undefined;
              continue;
            }
          }
          throw error;
        }
        this.events.publish({ source: "agent", type: "message.attempt", sessionId, payload: { attemptId: turn.attemptId } });
        perfProviderCallMs += performance.now() - providerCallStart;
        const assistantContent: MessageContent[] = [];
        let activeThinkingIndex: number | undefined;
        let activeTextIndex: number | undefined;
        let stopReason: string | undefined;
        let lastUsage: Extract<ProviderEvent, { type: "usage" }> | undefined;
        for (const event of turn.events) {
          if (event.type === "text_delta") {
            // Provider 文本以 token/chunk 形式流入。相邻分片属于同一段正文，
            // 落盘前合并，避免前端把每个分片当成独立块而逐词换行。
            // （前端的流式显示由 collectProviderTurn 的 onEvent 实时发布，此处只落盘。）
            const activeText = activeTextIndex === undefined ? undefined : assistantContent[activeTextIndex];
            if (activeText?.type === "text") activeText.text = `${activeText.text ?? ""}${event.text}`;
            else {
              assistantContent.push({ type: "text", text: event.text });
              activeTextIndex = assistantContent.length - 1;
            }
          } else if (event.type === "text_end") {
            // Responses message item 收尾：以权威文本替换 delta 累积块，并固化 v1 textSignature
            // （{v:1,id,phase?}），回放时还原 message item id/phase。
            const completedText: MessageContent = {
              type: "text",
              text: event.text,
              ...(event.signature ? { textSignature: event.signature } : {}),
            };
            if (activeTextIndex === undefined) assistantContent.push(completedText);
            else assistantContent[activeTextIndex] = completedText;
            activeTextIndex = undefined;
          } else if (event.type === "thinking_delta") {
            const activeThinking = activeThinkingIndex === undefined ? undefined : assistantContent[activeThinkingIndex];
            if (activeThinking?.type === "thinking") {
              activeThinking.text = `${activeThinking.text ?? ""}${event.text}`;
            } else {
              assistantContent.push({ type: "thinking", text: event.text, provider: provider.name });
              activeThinkingIndex = assistantContent.length - 1;
            }
          } else if (event.type === "thinking_end") {
            const completedThinking: MessageContent = {
              type: "thinking",
              text: event.text,
              ...(event.signature ? { signature: event.signature } : {}),
              ...(event.redacted ? { redacted: event.redacted } : {}),
              provider: provider.name,
            };
            if (activeThinkingIndex !== undefined) {
              // 活动槽位（thinking_delta 累积中）：原位替换
              assistantContent[activeThinkingIndex] = completedThinking;
            } else if (event.signature !== undefined && replaceThinkingBlockById(assistantContent, event.signature, completedThinking)) {
              // B3（Azure encrypted_content 回填）：同一 reasoning item 的第二次 thinking_end
              // 以 enriched signature 原位替换早期块，避免追加出重复块。
            } else {
              assistantContent.push(completedThinking);
            }
            activeThinkingIndex = undefined;
          } else if (event.type === "tool_call_delta") {
            // 流式分片仅用于实时显示，无落盘内容（完整 tool_call 事件随后到达）
          } else if (event.type === "server_tool") {
            // 服务端工具活动：仅经 onEvent 实时展示，不落盘、不影响 stopReason
          } else if (event.type === "tool_call") {
            assistantContent.push({
              type: "tool_call",
              id: event.id,
              ...(event.itemId ? { itemId: event.itemId } : {}),
              name: event.name,
              input: event.input,
            });
          } else if (event.type === "web_search_call") {
            // 服务端联网搜索完整 item：按流式到达顺序落盘为消息块（与 thinking 同构，
            // 回放时按文档原样回传，服务端自动恢复搜索结果）
            if (typeof event.item?.id === "string") {
              const block: WebSearchCallContent = {
                type: "web_search_call",
                signature: JSON.stringify(event.item),
                id: event.item.id,
                ...(typeof event.item.status === "string" ? { status: event.item.status } : {}),
                provider: provider.name,
              };
              assistantContent.push(block);
            }
          } else if (event.type === "usage") {
            // usage 可能逐 chunk 多次到达（stream_options.include_usage）：每条都实时转发 WS
            // （UI 实时成本不变），但 ledger/usageLog 只记本轮最后一条，避免逐 chunk 重复累加
            if (lastUsage) await this.recordUsageEvent(sessionId, context, effectiveProvider, effectiveModel, lastUsage, { persist: false });
            lastUsage = event;
          } else {
            stopReason = event.stopReason;
          }
        }
        if (lastUsage) await this.recordUsageEvent(sessionId, context, effectiveProvider, effectiveModel, lastUsage, { turn: turnLedger });
        if (assistantContent.length > 0) {
          await this.sessions.appendMessage(sessionId, "assistant", assistantContent, this.messageLineage(sessionId));
        }
        const toolCalls = assistantContent.filter((block) => block.type === "tool_call");
        // Some compatible providers have emitted tool_call blocks with a non-tool stop reason.
        // A persisted tool_call must always receive one matching tool_result; otherwise the next
        // request has an invalid conversation shape and can fail before a user-visible reply.
        if (toolCalls.length === 0 && stopReason !== "tool_use") {
          if (await this.runControl.applySteering(sessionId)) {
            await context.commitTurn(turnLedger);
            activeTurn = undefined;
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
          await context.commitTurn(turnLedger);
          activeTurn = undefined;
          return;
        }
        if (toolCalls.length === 0) throw new Error("Provider stopped for tool use without a tool call");
        await this.state(sessionId, "executing_tools");
        const toolExecStart = performance.now();
        // 同消息 subagent fan-out 并行：仅当设置并行数 ≥2 且本条消息全部为 subagent 类调用时启用
        // （模型一次发起多个子代理的典型形态）；其余形状——混入非子代理工具、并行数 1、单调用——
        // 走下方串行 for 循环，行为与历史完全一致。
        if (this.subAgentConcurrencyLimit() >= 2 && toolCalls.length >= 2 &&
            toolCalls.every((call) => isSubagentToolName(call.name))) {
          await this.executeSubagentFanOut(sessionId, toolCalls, {
            session,
            availableToolNames,
            toolsEnabled,
            controller,
            profile,
            provider,
          });
        } else {
        for (const call of toolCalls) {
          let effectiveInput = call.input;
          let result: Extract<MessageContent, { type: "tool_result" }>;
          // 子代理工具新旧名等价：旧会话/旧测试脚本发出的 spawn_task 调用等价于本轮的 subagent
          const advertisedName = isSubagentToolName(call.name) ? SUBAGENT_TOOL : call.name;
          if (!availableToolNames.has(advertisedName)) {
            // Keep the plan-mode MCP safety boundary ahead of availability diagnostics: an
            // unadvertised MCP name is still opaque and must be described as read/write unknown.
            const externalLabel = call.name.startsWith("mcp__") ? "MCP 工具" : call.name.startsWith("ext__") ? "扩展工具" : undefined;
            const content = session.agentMode === "plan" && externalLabel
              ? `Plan 模式为只读：${externalLabel} ${call.name} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 code 模式执行。`
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
                effectiveInput = this.toolAliases.translateAliasInput(sessionId, call.name, extensionOutcome.input);
                const repeated = this.recordToolCall(sessionId, call.name, effectiveInput);
                if (repeated >= 3) {
                  const content = `Tool call blocked: ${call.name} was requested with identical arguments ${repeated} consecutive times.`;
                  this.events.publish({ source: "agent", type: "tool.repeated", sessionId, payload: { name: call.name, ...boundToolEventInput(effectiveInput), count: repeated } });
                  result = { type: "tool_result", toolCallId: call.id, content, isError: true };
                } else {
                  const permission = await this.authorizeTool(sessionId, call.name, effectiveInput, controller.signal);
                  if (!permission.allowed) {
                    result = { type: "tool_result", toolCallId: call.id, content: permission.reason ?? "Tool permission denied", isError: true };
                  } else {
                    // PreToolUse 钩子：exit 2 否决 → 工具不执行，stderr 回填 LLM。
                    // tool 统一传内置名（与权限判定同名空间，matcher 按内置名配置）；
                    // env-sim 别名激活时另附 toolAlias 供钩子需要时识别展示形态。
                    const builtinName = this.toolAliases.resolveBuiltinToolName(sessionId, call.name);
                    const outcome = this.hooks
                      ? await this.hooks.run("PreToolUse", { sessionId, cwd: session.cwd, tool: builtinName, input: effectiveInput, ...(builtinName !== call.name ? { toolAlias: call.name } : {}) })
                      : undefined;
                    result = outcome?.blocked
                      ? { type: "tool_result", toolCallId: call.id, content: outcome.reason ?? "Blocked by hook", isError: true }
                      : await this.executeTool(sessionId, call.name, call.id, effectiveInput, controller.signal, {
                        // read_media 执行期门控：本轮有效模型的媒体模态 + provider 接口形态
                        image: profile.capabilities.modalities.includes("image"),
                        video: profile.capabilities.modalities.includes("video"),
                        providerInterface: provider.interfaceType,
                      });
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
          // PostToolUse 钩子：仅写类工具成功后触发（format-on-write 等），不阻断；
          // tool 按内置名判定与透传（matcher 与权限同名空间），别名经 toolAlias 附带
          const builtinToolName = this.toolAliases.resolveBuiltinToolName(sessionId, call.name);
          if (!result.isError && ["write_file", "edit_file", "bash"].includes(builtinToolName)) {
            const summary = result.content.slice(0, 300);
            await this.runNotificationHook("PostToolUse", { sessionId, cwd: session.cwd, tool: builtinToolName, input: effectiveInput, result: { summary }, ...(builtinToolName !== call.name ? { toolAlias: call.name } : {}) });
          }
          // agent 写文件成功后广播 scm.updated（与 ScmService.publish 同型），驱动 web 端 SCM 面板刷新
          if (!result.isError && ["write_file", "edit_file"].includes(this.toolAliases.resolveBuiltinToolName(sessionId, call.name))) {
            this.events.publish({ source: "agent", type: "scm.updated", sessionId, payload: { sessionId, reason: "file.write", ...(typeof effectiveInput.path === "string" ? { path: effectiveInput.path } : {}) } });
          }
        }
        }
        perfToolExecMs += performance.now() - toolExecStart;
        perfTurnCount++;
        await this.state(sessionId, "advancing_turn");
        await context.advanceRound(turnLedger);
        const afterTools = await this.sessions.get(sessionId);
        if (afterTools && saverOn) {
          // evict 经句柄延迟到 commitTurn 统一判定/落盘（期间的外部落盘会触发重放，两侧变更都不丢）；
          // 与 buildView 一致只按活动路径记账，避免旧分支消息污染 ledger。
          // 驱逐是 context-saver 扩展能力（extensions/context-saver），扩展关闭时跳过。
          await evictContext(context, this.sessions.contextRoot(sessionId), activePathMessages(afterTools.messages, afterTools.activeLeafId), new Set(afterTools.contextPins ?? []), turnLedger);
          const evictedLedger = await context.commitTurn(turnLedger);
          activeTurn = undefined;
          // 事件瘦身：面板只按事件类型刷新后经 REST 拉全量，payload 只带统计摘要——
          // 不再把含 read_file excerpt 的全量 entries 写进事件历史并扇出到所有 WS 客户端。
          let evictedCount = 0;
          let restoredCount = 0;
          let pinnedCount = 0;
          for (const entry of evictedLedger.entries) {
            if (entry.state === "evicted") evictedCount += 1;
            else if (entry.state === "restored") restoredCount += 1;
            if (entry.pinnedUntilRound > evictedLedger.round) pinnedCount += 1;
          }
          this.events.publish({ source: "agent", type: "context.evicted", sessionId, payload: { round: evictedLedger.round, total: evictedLedger.entries.length, evicted: evictedCount, restored: restoredCount, pinned: pinnedCount } });
        } else {
          await context.commitTurn(turnLedger);
          activeTurn = undefined;
        }
        await this.runControl.applySteering(sessionId);
        this.state(sessionId, "thinking");
      }
      throw new Error(`Agent exceeded ${maxTurns} turns`);
    } catch (error) {
      if (followUpQueueItemId) await this.runControl.requeueFollowUp(sessionId, followUpQueueItemId);
      if (controller.signal.aborted) {
        // 中断可能留下已落盘 tool_call 但结果未落盘（executeTool 因 abort 抛出，
        // 跳过循环内正常落盘）；不补齐则下一次请求被 provider 以非法历史形状拒绝。
        await this.backfillAbortedToolResults(sessionId);
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
      // 轮级账本兜底提交：正常出口已在循环内提交并清空 activeTurn；异常/中断路径在此把
      // 已记账的 usage/断点落盘（对齐原 recordUsage 即落盘的持久化语义），失败不掩盖原始结果。
      if (activeTurn) await activeTurn.context.commitTurn(activeTurn.ledger).catch(() => undefined);
      // goal 模式自动续跑：仅 run 正常结束（scheduleFollowUp 为 true 即未走 catch 的
      // abort/failed 路径）才按末条 assistant 消息的自评标记决定是否续跑。必须排在
      // running.delete 之前——enqueueFollowUp 要求会话仍处于 running 状态。
      if (scheduleFollowUp && !controller.signal.aborted) {
        try {
          await this.runControl.maybeScheduleGoalContinuation(sessionId);
        } catch { /* 续跑调度失败不掩盖 run 结果；队列事件已由 enqueueFollowUp 发布 */ }
      }
      this.settling.delete(sessionId);
      this.running.delete(sessionId);
      this.repeatedCalls.delete(sessionId);
      this.toolAliases.discard(sessionId);
      // abort 与正常结束都保留未消费队列；queue.json 是用户可恢复状态。
      // 任务清单不随 run 结束清除：保留到下一次 run 的 setTodos 整组替换（或会话删除），
      // 供用户查看历史任务；停止发送内容后前端 chip 不消失。
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
      if (scheduleFollowUp && !controller.signal.aborted) void this.runControl.startFollowUp(sessionId).catch(() => { /* follow-up failures are logged via queue.run_failed */ });
    }
  }

  listTodos(sessionId: string): TodoItem[] {
    return [...(this.todos.get(sessionId) ?? [])];
  }

  /** /clear 清空上下文时同步清空任务清单（内存态 todo_write 状态），并通知前端。 */
  clearTodos(sessionId: string): void {
    this.todos.delete(sessionId);
    this.events.publish({ source: "agent", type: "todos.updated", sessionId, payload: { items: [] } });
  }

  listPendingPermissions(sessionId: string): Array<{ requestId: string; tool: string; input: Record<string, unknown> }> {
    return this.permissions.listPending(sessionId);
  }

  async preparePermissionResponse(sessionId: string, requestId: string, decision: PermissionDecision, reason?: string): Promise<(() => void) | undefined> {
    const response = this.permissions.respond(sessionId, requestId, decision, reason);
    if (!response) return undefined;
    try {
      if (response.persist) {
        const session = await this.sessions.getMeta(sessionId);
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
    // ask_user 挂起等待：与权限挂起同样主动解除，避免 signal 事件注册竞态导致永久挂起
    // （controller.abort() 触发 signal abort 事件，但 listener 可能在事件之后才注册而漏掉）。
    this.runControl.cancelInteractionWaiters(sessionId);
    // 前台 `!cmd`（runShell）不进 running Map，其 controller 同样要响应停止
    const shell = this.shells.get(sessionId);
    shell?.abort();
    if (!controller) return shell !== undefined;
    controller.abort();
    this.workspaceWrites.get(sessionId)?.abort();
    return true;
  }

  /**
   * 解析子代理引用：内置类型（explore/general）优先，其次自定义 markdown 子代理。
   * agentName 为空时返回默认 explore（不回显 name，保持历史行为）。
   * 自定义子代理维持只读子集；其 frontmatter tools 优先于调用方 tools 参数。
   *
   * 模型/provider 选择优先级（frontmatter 优先惯例）：
   * frontmatter provider:/model: 显式值 > frontmatter role: > 调用参数 role > 会话默认。
   * role 经 ModelRoleResolver 回落链解析（角色未配置 → balanced → 会话默认）；
   * frontmatter 给出 provider: 或 model: 任一显式值时 role 整体不生效。
   * requestedRole 非法值直接报错（与 Unknown sub-agent 同一显式风格）。
   * 会话级 fallbackModels 不继承到子代理：fallback 是主循环 run 级机制，
   * 子代理模型路由固定走上述角色链。
   */
  private async resolveSubAgent(cwd: string, sessionId: string, agentName: string, requestedTools?: string[], requestedRole?: string): Promise<ResolvedSubAgent> {
    if (requestedRole !== undefined && !isModelRole(requestedRole)) {
      throw new Error(`Unknown model role: ${requestedRole} (expected one of ${MODEL_ROLES.join("/")})`);
    }
    // 会话级 toolsAllow/toolsDeny 由子代理自动继承（filterSubAgentTools 内套 toolAllowedBySession）
    const session = await this.sessions.getMeta(sessionId);
    const toolsAllow = session?.toolsAllow;
    const toolsDeny = session?.toolsDeny;
    /** 角色档解析为 provider+model 覆盖；未配置时留空，由调用方 ?? 回落会话模型。
     *  未显式指定 role 时默认 balanced 档（resolveWithFallback 未配置返回 undefined，自然回落会话模型）。 */
    const applyRole = (base: ResolvedSubAgent, role: ModelRole | undefined): ResolvedSubAgent => {
      const effectiveRole = role ?? "balanced";
      if (!this.modelRoles) return base;
      const selection = this.modelRoles.resolveWithFallback(effectiveRole, undefined);
      return selection ? { ...base, providerOverride: selection.provider, modelOverride: selection.model } : base;
    };
    const builtin = agentName ? getBuiltinSubAgent(agentName) : undefined;
    if (builtin) {
      const requested = requestedTools ?? [...builtin.toolNames];
      return applyRole(
        // 内置类型默认轮次跟随设置（subAgentMaxTurns 热生效）；builtin.maxTurns 仅作 runSubAgent 兜底
        { name: builtin.id, kind: builtin.id, toolNames: this.filterSubAgentTools(sessionId, requested, builtin, toolsAllow, toolsDeny), maxTurns: this.subAgentMaxTurnsLimit() },
        requestedRole as ModelRole | undefined,
      );
    }
    const definition = agentName && this.agents ? await this.agents.find(cwd, agentName) : undefined;
    if (agentName && !definition) throw new Error(`Unknown sub-agent: ${agentName}`);
    const requested = definition?.tools ?? requestedTools ?? [...SUB_AGENT_TOOL_NAMES];
    const explicit = definition?.provider !== undefined || definition?.model !== undefined;
    const resolved: ResolvedSubAgent = {
      ...(definition ? {
        name: definition.name,
        systemExtra: definition.body,
        ...(definition.model ? { modelOverride: definition.model } : {}),
        ...(definition.provider ? { providerOverride: definition.provider } : {}),
      } : {}),
      kind: "explore",
      toolNames: this.filterSubAgentTools(sessionId, requested, undefined, toolsAllow, toolsDeny),
    };
    // frontmatter 显式 provider:/model: 优先；否则 frontmatter role: > 调用参数 role
    return explicit ? resolved : applyRole(resolved, definition?.role ?? (requestedRole as ModelRole | undefined));
  }

  /** allowlist 以内置名为准：先把可能的工具形态别名解析回内置名再过滤；再套会话级 toolsAllow/toolsDeny。 */
  private filterSubAgentTools(sessionId: string, requested: string[], builtin: BuiltinSubAgent | undefined, toolsAllow?: string[], toolsDeny?: string[]): string[] {
    const allowlist: readonly string[] = builtin ? builtin.toolNames : SUB_AGENT_TOOL_NAMES;
    return requested
      .map((tool) => this.toolAliases.resolveBuiltinToolName(sessionId, tool))
      .filter((tool) => allowlist.includes(tool) && toolAllowedBySession(tool, toolsAllow, toolsDeny));
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
   * toolCallId 固定为 `manual-<taskId>`；事件负载与 subagent 相同，started 额外带 manual: true。
   */
  async launchManualSubagent(sessionId: string, input: { prompt: string; agent?: string }): Promise<{ taskId: string; toolCallId: string }> {
    const session = await this.sessions.getMeta(sessionId);
    if (!session) throw new SubAgentLaunchError("Session not found", "invalid_agent");
    const agentName = input.agent?.trim() ?? "";
    let resolved: ResolvedSubAgent;
    try {
      resolved = await this.resolveSubAgent(session.cwd, sessionId, agentName, undefined);
    } catch (error) {
      throw new SubAgentLaunchError(errorMessage(error), "invalid_agent");
    }
    const providerName = resolved.providerOverride ?? session.provider;
    const provider = this.providers.get(providerName);
    if (!provider) throw new SubAgentLaunchError(`Provider ${providerName} is not configured`, "invalid_agent");
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
      providerName,
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
      const session = await this.sessions.getMeta(sessionId);
      if (!session) throw new Error("Session not found");
      // 与 runShell 同款幂等沙盒配置：手动子代理可能在主循环之外首次触达 core
      await this.core.configureSession({
        sessionId,
        cwd: session.cwd,
        sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd),
      });
      const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
      const systemExtra = await this.withSubAgentAppend(session.cwd, resolved.systemExtra);
      // 能力档案解析一次复用（同一 model+provider 多次 getProfile 会重复走目录分层查找）
      const subCapabilities = this.getProfile(resolved.modelOverride ?? session.model, context.providerName).capabilities;
      const result = await runSubAgent({
        provider: context.provider,
        model: session.model,
        reasoningContent: subCapabilities.reasoningContent !== false,
        ...(subCapabilities.responsesEncryptedReplay
          ? { responsesEncryptedReplay: true }
          : {}),
        ...(subCapabilities.thinkingStyle
          ? { thinkingStyle: subCapabilities.thinkingStyle }
          : {}),
        serverWebSearch: this.getWebSearchMode() === "model-api",
        ...(resolved.modelOverride ? { modelOverride: resolved.modelOverride } : {}),
        ...(systemExtra ? { systemExtra } : {}),
        ...(resolved.name ? { agent: resolved.name } : {}),
        agentKind: resolved.kind,
        prompt,
        toolNames: resolved.toolNames,
        // 手动启动无显式参数：内置类型已带设置默认，自定义类型回落设置全局默认
        maxTurns: resolved.maxTurns ?? this.subAgentMaxTurnsLimit(),
        shell: resolveShell(session.shellBackend ?? "default"),
        // general 类型：工具调用经会话权限链 + 主循环同一沙盒执行（见 executeSubAgentTool）。
        // 手动启动保持 authContext="main"：随会话权限档（手动路径后续计划归档，行为不变）
        ...(resolved.kind === "general" ? { executeTool: (call: { name: string; input: Record<string, unknown> }) => this.executeSubAgentTool(sessionId, call.name, call.input, signal) } : {}),
        core: this.core,
        sessionId,
        cwd: session.cwd,
        contextRoot: this.sessions.contextRoot(sessionId),
        signal,
        taskId,
        onStart: async (id) => {
          this.events.publish({
            source: "agent",
            type: "subagent.started",
            sessionId,
            payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), manual: true, ...(resolved.name ? { agent: resolved.name } : {}) },
          });
          await this.runSubagentHook("SubagentStart", sessionId, session.cwd, { taskId: id, agent: resolved.name, kind: resolved.kind, prompt: prompt.slice(0, 200) });
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
      await this.runSubagentHook("SubagentStop", sessionId, session.cwd, { taskId: result.taskId, agent: resolved.name, kind: resolved.kind, status: "done" });
    } catch (error) {
      const message = errorMessage(error);
      this.events.publish({ source: "agent", type: "subagent.finished", sessionId, payload: { toolCallId, taskId, status: "failed", error: message } });
      // SubagentStop 尽力触发：会话已不可读时跳过（此时子代理多半未真正启动）
      const session = await this.sessions.getMeta(sessionId).catch(() => undefined);
      if (session) await this.runSubagentHook("SubagentStop", sessionId, session.cwd, { taskId, agent: resolved.name, kind: resolved.kind, status: "failed", error: message });
    }
  }

  /**
   * general 子代理的工具执行入口：与主循环工具相同的权限链（authorizeTool：
   * plan 只读门禁 + 权限模式/规则 + permission.request 挂起与 respond 恢复），
   * 执行复用主循环同一 core/沙盒配置。不发布 tool.start/end、不改变 run 状态——
   * 子代理进度只经 subagent.progress 暴露。
   * authContext 区分权限档推导：主循环发起的 subagent / spawn_swarm 成员传 "subagent"
   * （内部工具默认模型审核 review，主档 yolo 时跟随 yolo）；手动启动子代理保持 "main"
   * （随会话档，行为不变——手动路径后续计划归档）。
   */
  private async executeSubAgentTool(sessionId: string, name: string, input: Record<string, unknown>, signal: AbortSignal, authContext: "main" | "subagent" = "main"): Promise<{ content: string; isError: boolean }> {
    const permission = await this.authorizeTool(sessionId, name, input, signal, authContext);
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
      const raw = await this.callCoreFileTool(sessionId, name, input, signal);
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
      return this.executeBash(sessionId, cmd, `subagent-${randomUUID().slice(0, 8)}`, signal, { quiet: true, sessionEnv: true });
    }
    if (name === "repo_map") {
      const session = await this.sessions.getMeta(sessionId);
      if (!session) throw new Error("Session not found");
      if (input.budget !== undefined && (!Number.isInteger(Number(input.budget)) || Number(input.budget) < 64)) {
        throw new Error("repo_map budget must be an integer >= 64");
      }
      const map = await this.repoMap.generate({
        sessionId,
        cwd: session.cwd,
        budget: input.budget === undefined ? (session.repoMapBudget ?? DEFAULT_REPO_MAP_BUDGET) : Number(input.budget),
        // 排除路径是 context-saver 扩展的选择性上下文能力：扩展关闭时不生效
        excludes: !this.extensions || this.extensions.isEnabled("context-saver") ? session.contextExcludes ?? [] : [],
      });
      const bounded = await boundToolResult(contextRoot, name, map.text);
      return { content: bounded.content, isError: false };
    }
    if (name === "code_search") {
      const session = await this.sessions.getMeta(sessionId);
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
      const session = await this.sessions.getMeta(sessionId);
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
  /**
   * read_media 执行（仅主循环）：本地路径走 core fs.readBase64（路径策略/沙盒在 core 强制），
   * http(s) URL 走 media-fetch（SSRF 链 + content-type 白名单 + 魔数确认）。
   * 媒体本体经 tool_result.media 附带（投递由各 provider 适配层按端点能力完成），
   * 文本 content 是模型可见的说明行（来源/mime/大小）。错误一律抛给调用方转 isError。
   */
  private async executeReadMedia(
    sessionId: string,
    toolCallId: string,
    input: Record<string, unknown>,
    mediaCapability: { image: boolean; video: boolean; providerInterface?: Provider["interfaceType"] },
    signal: AbortSignal,
  ): Promise<{ result: MessageContent & { type: "tool_result" }; eventResult: Record<string, unknown> }> {
    const requested = typeof input.path === "string" ? input.path.trim() : "";
    if (!requested) throw new Error("read_media requires a non-empty path");
    let bytes: Uint8Array;
    let base64: string;
    let label = requested;
    let sniffHint = requested;
    if (/^https?:\/\//i.test(requested)) {
      const fetched = await fetchMedia(requested, { ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), signal });
      bytes = fetched.bytes;
      base64 = Buffer.from(bytes).toString("base64");
      label = fetched.finalUrl;
      sniffHint = fetched.finalUrl;
    } else {
      if (!this.core.readFileBase64) throw new Error("The core executor does not support binary media reads (fs.readBase64); upgrade the core binary.");
      const read = await this.core.readFileBase64({ sessionId, path: requested });
      if (read.truncated) {
        throw new Error(`Media file exceeds the ${MAX_VIDEO_BYTES / (1024 * 1024)} MiB read limit: ${requested}. Downscale or trim the file first, then retry.`);
      }
      bytes = Buffer.from(read.base64, "base64");
      base64 = read.base64;
    }
    // 魔数权威（扩展名仅视频兜底）：伪装/错配的扩展名不改变实际投递类型
    const sniffed = sniffMedia(bytes, sniffHint);
    if (!sniffed) throw new Error(`Unrecognized media format (not a supported image or video): ${requested}`);
    if (sniffed.kind === "image" && !mediaCapability.image) {
      throw new Error("The current model does not declare image input. Switch to a vision-capable model, or enable the vision-tools extension.");
    }
    if (sniffed.kind === "video" && !mediaCapability.video) {
      throw new Error("The current model does not declare video input. Switch to a video-capable model, or enable the vision-tools extension.");
    }
    // 视频仅 openai 兼容（chat/completions）端点可投递（video_url data URL）；其余端点无视频形态
    if (sniffed.kind === "video" && mediaCapability.providerInterface !== "openai-chat-completions") {
      throw new Error("Video tool results can only be delivered to OpenAI-compatible (chat/completions) providers. Switch to such a provider, or extract frames and read them as images.");
    }
    if (sniffed.kind === "image" && base64.length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error(`Image is too large to attach (${Math.round(bytes.length / 1024)} KB; the limit is about 5 MB). Downscale or crop the image first, then retry.`);
    }
    if (sniffed.kind === "video" && bytes.length > MAX_VIDEO_BYTES) {
      throw new Error(`Video exceeds the ${MAX_VIDEO_BYTES / (1024 * 1024)} MiB limit (${Math.round(bytes.length / (1024 * 1024))} MiB). Trim or transcode the file first, then retry.`);
    }
    const sizeNote = `~${Math.max(1, Math.round(bytes.length / 1024))} KB`;
    const note = `[${sniffed.kind}] ${label} (${sniffed.mediaType}, ${sizeNote}) — attached for the model to view`;
    return {
      result: {
        type: "tool_result",
        toolCallId,
        content: note,
        isError: false,
        media: [{ type: sniffed.kind, mediaType: sniffed.mediaType, data: base64 }],
      },
      eventResult: { kind: sniffed.kind, mediaType: sniffed.mediaType, sizeBytes: bytes.length },
    };
  }

  private async callCoreFileTool(sessionId: string, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    // glob/grep 的 path 可选（schema 未列入 required），缺省从会话根开始；
    // read/write/edit 必须显式给出文件路径。
    const path = typeof input.path === "string" && input.path ? input.path : (name === "glob" || name === "grep" ? "." : "");
    if (!path) throw new Error(`${name} requires a non-empty path`);
    let value: unknown;
    if (name === "read_file") value = await this.core.readFile({ sessionId, path, ...(input.offset === undefined ? {} : { offset: Number(input.offset) }), ...(input.limit === undefined ? {} : { limit: Number(input.limit) }) });
    else if (name === "write_file") value = await this.core.writeFile({ sessionId, path, content: String(input.content ?? ""), ...(input.createDirs === undefined ? {} : { createDirs: Boolean(input.createDirs) }) });
    else if (name === "edit_file") value = await this.core.editFile({ sessionId, path, oldText: String(input.oldText ?? ""), newText: String(input.newText ?? ""), ...(input.replaceAll === undefined ? {} : { replaceAll: Boolean(input.replaceAll) }) });
    else if (name === "glob" || name === "grep") {
      const pattern = String(input.pattern ?? "");
      // 优先走 core 并行 search job（4 工作线程，不阻塞 core 主循环）；core 无 searchJob
      // 实现或 features 缺 grepJob/globJob 时在 CoreClient/CoreRouter 内回退同步 RPC。
      // 两种路径返回形状一致，对模型透明。
      if (this.core.searchJob) {
        const session = await this.sessions.getMeta(sessionId);
        if (!session) throw new Error("Session not found");
        const base = { sessionId, cwd: session.cwd, path, pattern, ...(signal ? { signal } : {}) };
        value = name === "glob"
          ? await this.core.searchJob({ ...base, kind: "glob" })
          : await this.core.searchJob({ ...base, kind: "grep" });
      } else if (name === "glob") value = await this.core.globFiles({ sessionId, path, pattern });
      else value = await this.core.grepFiles({ sessionId, path, pattern });
    }
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
      const session = await this.sessions.getMeta(sessionId);
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

  /** 权限模式运行中热切换后，按最新 mode/rules 结算该会话挂起的权限请求
   * （新档下不再需要审批的自动放行；本机会话 HOME 外路径门不受影响）。 */
  async reconcilePermissions(sessionId: string): Promise<void> {
    const session = await this.sessions.getMeta(sessionId);
    if (!session) return;
    this.permissions.reconcile(sessionId, session.permissionMode ?? "ask", session.permissionRules ?? []);
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
      const session = await this.sessions.getMeta(sessionId);
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
      // 编辑器/DiffPane 保存成功同样广播 scm.updated（与 ScmService.publish 同型）
      this.events.publish({ source: "agent", type: "scm.updated", sessionId, payload: { sessionId, reason: "file.write", path } });
    } finally {
      this.workspaceWrites.delete(sessionId);
    }
  }

  async enqueueSteering(sessionId: string, content: string, requestId?: string): Promise<{ id: string; position: number; reused: boolean }> {
    return this.runControl.enqueueSteering(sessionId, content, requestId);
  }

  async enqueueFollowUp(sessionId: string, content: string, requestId?: string): Promise<{ id: string; position: number; reused: boolean }> {
    return this.runControl.enqueueFollowUp(sessionId, content, requestId);
  }

  /**
   * cron 触发注入（提交⑫）：与 enqueueFollowUp 不同，不要求会话 running——
   * 运行中自然排队（run 收尾的 startFollowUp 消费），空闲/settling 由这里立即补一轮。
   * 队列项标记 source:"cron" 随 queue.json 持久化。
   */
  async fireCronFollowUp(sessionId: string, content: string): Promise<{ id: string; position: number }> {
    return this.runControl.fireCronFollowUp(sessionId, content);
  }

  async listSteering(sessionId: string): Promise<QueueItem[]> {
    return this.runControl.listSteering(sessionId);
  }
  async listQueue(sessionId: string): Promise<QueueItem[]> { return this.runControl.listQueue(sessionId); }
  async updateQueue(sessionId: string, id: string, change: { content?: string; kind?: "steer" | "follow_up" }): Promise<QueueItem | undefined> {
    return this.runControl.updateQueue(sessionId, id, change);
  }
  async removeQueue(sessionId: string, id: string): Promise<boolean> {
    return this.runControl.removeQueue(sessionId, id);
  }

  async listInteractions(sessionId: string): Promise<InteractionRequest[]> { return this.runControl.listInteractions(sessionId); }
  async createInteraction(sessionId: string, input: { runId: string; toolCallId?: string; kind: InteractionKind; title: string; prompt: string; options?: Array<{ id: string; label: string; description?: string }> }): Promise<InteractionRequest> {
    return this.runControl.createInteraction(sessionId, input);
  }
  async respondInteraction(sessionId: string, id: string, answer: unknown): Promise<InteractionRequest | undefined> {
    return this.runControl.respondInteraction(sessionId, id, answer);
  }

  /**
   * exit_plan_mode 批准后切回 build 并持久化（沿用 PUT config 的 updateConfig 语义：
   * build 不落盘，其余配置项原样透传避免被清除）。计划批准独立于权限档，
   * 不经 permission-coordinator，yolo/自动批准不会跳过。完成后发 session.config_updated
   * 事件，web 端沿用既有刷新链路更新会话配置。
   */
  private async switchToBuildMode(sessionId: string): Promise<void> {
    const session = await this.sessions.getMeta(sessionId);
    if (!session || session.agentMode !== "plan") return;
    const updated = await this.sessions.updateConfig(sessionId, {
      provider: session.provider,
      model: session.model,
      agentMode: "code",
      ...(session.thinking ? { thinking: session.thinking } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      ...(session.snapshotMode ? { snapshotMode: session.snapshotMode } : {}),
      ...(session.shellBackend ? { shellBackend: session.shellBackend } : {}),
      ...(session.pythonEnv ? { pythonEnv: session.pythonEnv } : {}),
      ...(session.nodeEnv ? { nodeEnv: session.nodeEnv } : {}),
      ...(session.persona ? { persona: session.persona } : {}),
      ...(session.swarmEnabled ? { swarmEnabled: true } : {}),
      ...(session.reviewModel ? { reviewModel: session.reviewModel } : {}),
      ...(session.toolsAllow ? { toolsAllow: session.toolsAllow } : {}),
      ...(session.toolsDeny ? { toolsDeny: session.toolsDeny } : {}),
    });
    this.events.publish({ source: "session", type: "session.config_updated", sessionId, payload: updated });
  }

  async removeSteering(sessionId: string, id: string): Promise<boolean> {
    return this.runControl.removeSteering(sessionId, id);
  }

  /**
   * 同消息 subagent fan-out 并行执行（设置 subAgentConcurrency>1 且消息全为 subagent 类调用时启用）。
   *
   * 与串行路径（run() 内 for 循环）的分工：可用性检查/扩展前处理/别名/重复守卫/授权/PreToolUse
   * 钩子按调用顺序**串行**执行——守卫计数、权限卡与钩子语义与串行路径一致，不引入并发权限卡；
   * 通过预检的调用经 worker 池并发调 executeTool（上限 = min(并行数, 调用数)），超出的调用在池内
   * 排队依次执行（并行数只限并发、不截断调用总量）。全部就绪后按**原调用顺序**逐条落盘 tool_result，
   * 满足 DeepSeek 并行回放 fc…fc → fco…fco 的历史布局约束。中断语义与串行路径一致：在途调用经
   * signal 收尾（executeTool 内部 catch 转为失败结果并保留 taskId），未启动的排队项在此抛出让外层
   * catch 的 backfillAbortedToolResults 补齐占位结果。
   */
  private async executeSubagentFanOut(
    sessionId: string,
    toolCalls: Array<Extract<MessageContent, { type: "tool_call" }>>,
    context: {
      session: SessionMeta;
      availableToolNames: Set<string>;
      toolsEnabled: boolean;
      controller: AbortController;
      profile: ModelProfile;
      provider: Provider;
    },
  ): Promise<void> {
    const { session, availableToolNames, toolsEnabled, controller, profile, provider } = context;
    type ToolResult = MessageContent & { type: "tool_result" };
    const prepared: Array<{ call: (typeof toolCalls)[number]; result?: ToolResult; run?: () => Promise<ToolResult> }> = [];
    for (const call of toolCalls) {
      const entry: { call: (typeof toolCalls)[number]; result?: ToolResult; run?: () => Promise<ToolResult> } = { call };
      try {
        // 1) 可用性 + 扩展前处理 + 重复守卫：与串行路径同一顺序与判定
        const advertisedName = isSubagentToolName(call.name) ? SUBAGENT_TOOL : call.name;
        if (!availableToolNames.has(advertisedName)) {
          const externalLabel = call.name.startsWith("mcp__") ? "MCP 工具" : call.name.startsWith("ext__") ? "扩展工具" : undefined;
          const content = session.agentMode === "plan" && externalLabel
            ? `Plan 模式为只读：${externalLabel} ${call.name} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 code 模式执行。`
            : toolsEnabled
              ? `Tool is not available in this turn: ${call.name}`
              : `Tool calls are disabled for the selected model: ${call.name}`;
          this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId: call.id, error: content } });
          entry.result = { type: "tool_result", toolCallId: call.id, content, isError: true };
          continue;
        }
        const extensionOutcome = this.extensions
          ? await this.extensions.beforeTool({ sessionId, cwd: session.cwd, tool: call.name, input: call.input })
          : { sessionId, cwd: session.cwd, tool: call.name, input: call.input };
        if (extensionOutcome.blocked) {
          entry.result = { type: "tool_result", toolCallId: call.id, content: extensionOutcome.reason ?? "Blocked by extension", isError: true };
          continue;
        }
        const effectiveInput = this.toolAliases.translateAliasInput(sessionId, call.name, extensionOutcome.input);
        const repeated = this.recordToolCall(sessionId, call.name, effectiveInput);
        if (repeated >= 3) {
          const content = `Tool call blocked: ${call.name} was requested with identical arguments ${repeated} consecutive times.`;
          this.events.publish({ source: "agent", type: "tool.repeated", sessionId, payload: { name: call.name, ...boundToolEventInput(effectiveInput), count: repeated } });
          entry.result = { type: "tool_result", toolCallId: call.id, content, isError: true };
          continue;
        }
        // 2) 授权（plan 门禁/权限链，可挂起）与 PreToolUse 钩子：逐调用串行
        const permission = await this.authorizeTool(sessionId, call.name, effectiveInput, controller.signal);
        if (!permission.allowed) {
          entry.result = { type: "tool_result", toolCallId: call.id, content: permission.reason ?? "Tool permission denied", isError: true };
          continue;
        }
        const builtinName = this.toolAliases.resolveBuiltinToolName(sessionId, call.name);
        const outcome = this.hooks
          ? await this.hooks.run("PreToolUse", { sessionId, cwd: session.cwd, tool: builtinName, input: effectiveInput, ...(builtinName !== call.name ? { toolAlias: call.name } : {}) })
          : undefined;
        if (outcome?.blocked) {
          entry.result = { type: "tool_result", toolCallId: call.id, content: outcome.reason ?? "Blocked by hook", isError: true };
          continue;
        }
        entry.run = () => this.executeTool(sessionId, call.name, call.id, effectiveInput, controller.signal, {
          // read_media 执行期门控：与本轮调用链一致（本轮均为子代理工具，实际不消费图片/视频模态）
          image: profile.capabilities.modalities.includes("image"),
          video: profile.capabilities.modalities.includes("video"),
          providerInterface: provider.interfaceType,
        });
      } catch (error) {
        // Abort 仍按原语义结束整个 run；其他前置失败必须回填给 provider（同串行路径 catch）
        if (controller.signal.aborted) throw error;
        const content = errorMessage(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId: call.id, error: content } });
        entry.result = { type: "tool_result", toolCallId: call.id, content, isError: true };
      }
      prepared.push(entry);
    }
    // 3) worker 池并发执行：executeTool 内部自带 try/catch（非中断失败转 error result、保留 taskId）；
    //    中断后在途调用以失败结果收尾，不再启动排队项
    const runnables = prepared.filter((entry): entry is typeof entry & { run: () => Promise<ToolResult> } => entry.run !== undefined);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.subAgentConcurrencyLimit(), runnables.length)) }, async () => {
      while (!controller.signal.aborted && next < runnables.length) {
        const index = next;
        next += 1;
        try {
          runnables[index]!.result = await runnables[index]!.run();
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const content = errorMessage(error);
          this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId: runnables[index]!.call.id, error: content } });
          runnables[index]!.result = { type: "tool_result", toolCallId: runnables[index]!.call.id, content, isError: true };
        }
      }
    }));
    // 4) 按原调用顺序落盘 tool_result（appendMessage 对同会话串行化，逐条等待保证顺序）
    for (const entry of prepared) {
      if (entry.result) {
        await this.sessions.appendMessage(sessionId, "tool", [entry.result], this.messageLineage(sessionId));
      }
    }
    // 排队项因中断未启动：抛出走外层 catch，由 backfillAbortedToolResults 补齐占位结果
    if (controller.signal.aborted) throw new Error("Agent run aborted");
  }

  private async authorizeTool(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal, context: "main" | "subagent" = "main"): Promise<{ allowed: boolean; reason?: string }> {
    const session = await this.sessions.getMeta(sessionId);
    if (!session) return { allowed: false, reason: "Session not found" };
    // 工具形态别名按原内置工具的权限类处理（不降级为 external）
    tool = this.toolAliases.resolveBuiltinToolName(sessionId, tool);
    // Plan 模式门禁：只读工具放行，其余一律拦截
    const PLAN_READONLY = new Set(["read_file", "read_media", "glob", "grep", "read_artifact", "load_skill", "subagent", "spawn_task", "spawn_swarm", "todo_write", "web_fetch", "web_search", "task_output", "repo_map", "code_search", "git_status", "git_diff", "ask_user", "exit_plan_mode", "cron_list"]);
    if (session.agentMode === "plan") {
      if (tool.startsWith("mcp__")) return { allowed: false, reason: `Plan 模式为只读：MCP 工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 code 模式执行。` };
      if (tool.startsWith("ext__")) return { allowed: false, reason: `Plan 模式为只读：扩展工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 code 模式执行。` };
      if (!PLAN_READONLY.has(tool)) return { allowed: false, reason: `Plan 模式为只读：${tool} 被拦截。请输出实施计划并请用户切换到 code 模式执行。` };
    }
    const baseMode = session.permissionMode ?? "ask";
    // 子代理（subagent/spawn_swarm 成员，手动路径除外——authContext 由注入点区分）内部工具授权的
    // 有效权限档：默认模型审核（review）；主 agent 切 yolo 时同步 yolo（yolo 只跳确认、不扩沙盒）。
    // 只读白名单/allow 规则命中仍不经审核（下方 needsApproval 前置不变）。
    const mode = context === "subagent" && baseMode !== "yolo" ? "review" : baseMode;
    const rules = session.permissionRules ?? [];
    // 本机会话（kind=local）文件工具路径门：cwd=HOME、core 路径根放宽到文件系统根，
    // HOME 之外的 read/write/edit/glob/grep 必须先命中 allow 规则或经人工审批——
    // 与权限模式无关（read_file 在 needsApproval 白名单中本免批，HOME 外读同样要人批）。
    // 门通过后直接放行，不再走下方 needsApproval（避免 write/edit 在 ask 模式重复确认）；
    // HOME 内路径不拦截，维持原权限链语义。
    // read_media 的 http(s) URL 不是本地路径：跳过 HOME 路径门（URL 安全由 media-fetch 的 SSRF 链负责）
    const mediaUrlInput = tool === "read_media" && typeof input.path === "string" && /^https?:\/\//i.test(input.path);
    if (session.kind === "local" && LOCAL_PATH_GATED_TOOLS.has(tool) && !mediaUrlInput) {
      let rawPath = typeof input.path === "string" && input.path ? input.path : ".";
      try {
        if (this.core.normalizePath) {
          const normalized = await this.core.normalizePath({
            sessionId,
            path: rawPath,
            purpose: tool === "write_file" || tool === "edit_file" ? "write" : "read",
          });
          rawPath = normalized.path;
        }
      } catch { /* 回退原始路径 */ }
      // normalizePath 已产出含 cwd 的绝对路径：仅对仍为相对路径的原始输入 resolve，
      // 避免对绝对路径二次拼 cwd（/x 被拼成 ${cwd}/x）
      const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(session.cwd, rawPath);
      // 归一化绝对路径就地写回 input：调用点的 effectiveInput 与本对象同引用，executeTool 直接消费，
      // 不写回则 HOME 内的相对路径（如 notes.txt）会以相对形态到达 core，与归一化语义不一致
      input.path = abs;
      // HOME 判定按分隔符归一比较：abs 来自 core normalizePath 的 canonical 形态（正斜杠），
      // 而 os.homedir()/session.cwd 在 Windows 是反斜杠——直接 startsWith(home + path.sep)
      // 在 Windows 上永假，会把 HOME 内路径误判为 HOME 外触发审批。统一转 / 后比较（POSIX 恒等）。
      const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const absC = slash(abs);
      const homeC = slash(os.homedir());
      const insideHome = absC === homeC || absC.startsWith(`${homeC}/`);
      if (!insideHome && !rules.some((rule) => matchesRule(rule, tool, { path: abs }))) {
        this.state(sessionId, "waiting_permission");
        // Notification 钩子：权限待批（与下方 needsApproval 审批路径同一挂点）
        await this.runNotificationHook("Notification", { sessionId, cwd: session.cwd, tool, input: { ...input, path: abs }, notification: { kind: "permission", summary: summarizeToolInput(tool, { ...input, path: abs }) } });
        const result = await this.permissions.request(sessionId, tool, { ...input, path: abs }, signal, { alwaysManual: true });
        this.state(sessionId, "tool_running");
        if (!result.allowed) return { allowed: false, reason: `访问 HOME 外路径未获允许：${abs}${result.reason ? `（${result.reason}）` : ""}` };
        return { allowed: true };
      }
    }
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
      this.events.publish({ source: "agent", type: "permission.reviewed", sessionId, payload: { tool, ...boundToolEventInput(input), verdict: reviewed.verdict, rationale: reviewed.rationale, model: reviewed.model } });
      if (reviewed.verdict === "low") return { allowed: true };
      // 审核窗口（最长 30s）内用户可能已热切权限档：按最新 mode/rules 复查，
      // 不再需要审批则直接放行，避免挂出一张新档下本不该存在的权限卡。
      const fresh = await this.sessions.getMeta(sessionId);
      if (fresh && !this.permissions.needsApproval(fresh.permissionMode ?? "ask", fresh.permissionRules ?? [], tool, input)) {
        return { allowed: true };
      }
    }
    this.state(sessionId, "waiting_permission");
    // Notification 钩子：权限待批（仅通知不阻断，桌面通知/IM 机器人等外接提醒的挂点）
    await this.runNotificationHook("Notification", { sessionId, cwd: session.cwd, tool, input, notification: { kind: "permission", summary: summarizeToolInput(tool, input) } });
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
    const combined = withTimeout(signal, 30_000);
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

  /**
   * SubagentStart/SubagentStop 钩子：仅通知不阻断。payload 带 taskId、agent 类型
   * （内置 explore/general 或自定义名）、swarm 成员位置与终态（Stop）。
   */
  private async runSubagentHook(
    event: "SubagentStart" | "SubagentStop",
    sessionId: string,
    cwd: string,
    info: {
      taskId: string;
      agent?: string | undefined;
      kind?: string | undefined;
      swarm?: { index: number; total: number } | undefined;
      prompt?: string | undefined;
      status?: "done" | "failed" | undefined;
      error?: string | undefined;
    },
  ): Promise<void> {
    await this.runNotificationHook(event, {
      sessionId,
      cwd,
      ...(info.prompt !== undefined ? { prompt: info.prompt } : {}),
      subagent: { taskId: info.taskId, agent: info.agent, kind: info.kind, swarm: info.swarm, status: info.status, error: info.error },
    });
  }

  /** 非拦截型 Hook（用户提交、工具后、正常结束、通知/子代理/压缩后等）绝不能让已接受的会话卡住。 */
  private async runNotificationHook(
    event: Exclude<HookEvent, "PreToolUse" | "PreCompact" | "SessionStart">,
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
    this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
    this.state(sessionId, "tool_running");
    try {
      const session = await this.sessions.getMeta(sessionId);
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
    /** 本轮有效模型的媒体输入模态与 provider 接口形态（read_media 执行期门控用）。 */
    mediaCapability: { image: boolean; video: boolean; providerInterface?: Provider["interfaceType"] } = { image: false, video: false },
  ): Promise<MessageContent & { type: "tool_result" }> {
    // 工具形态别名回调到内置实现：权限分级/事件/分发统一按内置名。
    name = this.toolAliases.resolveBuiltinToolName(sessionId, name);
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
      return this.executeExternalTool(sessionId, name, toolCallId, input, () => extensions.invokeTool(name, input, sessionId));
    }
    if (name === "web_fetch" || name === "web_search") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.getMeta(sessionId);
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
    if (isSubagentToolName(name)) {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      // catch 分支需引用（子代理启动后失败补发 subagent.finished），声明在 try 之外
      let taskId = "";
      // SubagentStop 钩子在 catch 也需引用（cwd/agent 类型），与 taskId 同步声明
      let hookContext: { cwd: string; agent?: string | undefined; kind?: string | undefined } | undefined;
      try {
        const session = await this.sessions.getMeta(sessionId);
        if (!session) throw new Error("Session not found");
        const prompt = String(input.prompt ?? "");
        if (!prompt) throw new Error("subagent requires a non-empty prompt");
        const agentName = typeof input.agent === "string" ? input.agent.trim() : "";
        const requestedTools = Array.isArray(input.tools) ? input.tools.map((item) => String(item)) : undefined;
        const requestedRole = typeof input.role === "string" && input.role.trim() ? input.role.trim() : undefined;
        const requestedMaxTurns = parseMaxTurns(input.maxTurns);
        const resolved = await this.resolveSubAgent(session.cwd, sessionId, agentName, requestedTools, requestedRole);
        hookContext = { cwd: session.cwd, agent: resolved.name, kind: resolved.kind };
        // 生效 provider：角色档/frontmatter provider: 覆盖优先，缺省会话 provider
        const providerName = resolved.providerOverride ?? session.provider;
        const provider = this.providers.get(providerName);
        if (!provider) throw new Error(`Provider ${providerName} is not configured`);
        const effectiveModel = resolved.modelOverride ?? session.model;
        // 子代理期间不发布 message.delta/thinking_delta，避免污染主聊天流；
        // 子代理 token 经 onUsage 复用主循环记账路径，计入会话成本
        const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
        const systemExtra = await this.withSubAgentAppend(session.cwd, resolved.systemExtra);
        // 能力档案解析一次复用（同一 model+provider 多次 getProfile 会重复走目录分层查找）
        const subCapabilities = this.getProfile(effectiveModel, providerName).capabilities;
        const result = await runSubAgent({
          provider,
          model: session.model,
          reasoningContent: subCapabilities.reasoningContent !== false,
          ...(subCapabilities.responsesEncryptedReplay
            ? { responsesEncryptedReplay: true }
            : {}),
          ...(subCapabilities.thinkingStyle
            ? { thinkingStyle: subCapabilities.thinkingStyle }
            : {}),
          serverWebSearch: this.getWebSearchMode() === "model-api",
          ...(resolved.modelOverride ? { modelOverride: resolved.modelOverride } : {}),
          ...(systemExtra ? { systemExtra } : {}),
          ...(resolved.name ? { agent: resolved.name } : {}),
          agentKind: resolved.kind,
          prompt,
          toolNames: resolved.toolNames,
          // 显式 maxTurns 参数优先，其次设置全局默认（resolveSubAgent 已按内置/设置解析），最后 runSubAgent 兜底
          maxTurns: requestedMaxTurns ?? resolved.maxTurns ?? this.subAgentMaxTurnsLimit(),
          shell: resolveShell(session.shellBackend ?? "default"),
          // general 类型：工具调用经会话权限链 + 主循环同一沙盒执行（见 executeSubAgentTool）。
          // 子代理内部工具权限档默认模型审核（review），主 agent 切 yolo 时跟随 yolo
          ...(resolved.kind === "general" ? { executeTool: (call: { name: string; input: Record<string, unknown> }) => this.executeSubAgentTool(sessionId, call.name, call.input, signal, "subagent") } : {}),
          core: this.core,
          sessionId,
          cwd: session.cwd,
          contextRoot: this.sessions.contextRoot(sessionId),
          signal,
          onStart: async (id) => {
            taskId = id;
            this.events.publish({
              source: "agent",
              type: "subagent.started",
              sessionId,
              payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), ...(resolved.name ? { agent: resolved.name } : {}) },
            });
            await this.runSubagentHook("SubagentStart", sessionId, session.cwd, { taskId: id, agent: resolved.name, kind: resolved.kind, prompt: prompt.slice(0, 200) });
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
          onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, providerName, effectiveModel, usage),
        });
        this.events.publish({
          source: "agent",
          type: "subagent.finished",
          sessionId,
          payload: { toolCallId, taskId: result.taskId, status: "done", turns: result.turns, toolsUsed: result.toolsUsed },
        });
        await this.runSubagentHook("SubagentStop", sessionId, session.cwd, { taskId: result.taskId, agent: resolved.name, kind: resolved.kind, status: "done" });
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
          if (hookContext) await this.runSubagentHook("SubagentStop", sessionId, hookContext.cwd, { taskId, agent: hookContext.agent, kind: hookContext.kind, status: "failed", error: content });
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      // catch 分支需引用（中断/整体失败仍回报已启动项的 taskId 与逐项终态），声明在 try 之外
      interface SwarmTaskStatus { taskId: string; index: number; status: "done" | "failed"; error?: string }
      const subagentTaskIds: string[] = [];
      const subagentTasks: SwarmTaskStatus[] = [];
      try {
        const session = await this.sessions.getMeta(sessionId);
        if (!session) throw new Error("Session not found");
        const template = String(input.prompt_template ?? "");
        if (!template.includes("{{item}}")) throw new Error("spawn_swarm requires prompt_template to contain the {{item}} placeholder");
        // items 兼容两种形态：纯字符串，或 { task, agent?, role?, maxTurns? }（agent/role/maxTurns 覆盖本次调用的整体值）
        interface SwarmItemSpec { task: string; agent?: string; role?: string; maxTurns?: number }
        const items: SwarmItemSpec[] = (Array.isArray(input.items) ? input.items : []).map((raw) => {
          if (typeof raw === "string") return { task: raw };
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            const record = raw as Record<string, unknown>;
            const agent = typeof record.agent === "string" ? record.agent.trim() : "";
            const role = typeof record.role === "string" ? record.role.trim() : "";
            return { task: String(record.task ?? ""), ...(agent ? { agent } : {}), ...(role ? { role } : {}), ...(record.maxTurns !== undefined ? { maxTurns: parseMaxTurns(record.maxTurns) as number } : {}) };
          }
          return { task: String(raw) };
        });
        if (items.length < 2) throw new Error("spawn_swarm requires at least 2 items; for a single task use subagent");
        if (items.length > SPAWN_SWARM_MAX_ITEMS) throw new Error(`spawn_swarm supports at most ${SPAWN_SWARM_MAX_ITEMS} items (got ${items.length})`);
        if (items.some((item) => !item.task.trim())) throw new Error("spawn_swarm items require a non-empty task");
        const prompts = items.map((item) => template.split("{{item}}").join(item.task));
        if (new Set(prompts).size !== prompts.length) throw new Error("spawn_swarm items must produce distinct filled-in prompts");
        const agentName = typeof input.agent === "string" ? input.agent.trim() : "";
        const callRole = typeof input.role === "string" && input.role.trim() ? input.role.trim() : undefined;
        const callMaxTurns = parseMaxTurns(input.maxTurns);
        const resolvedDefault = await this.resolveSubAgent(session.cwd, sessionId, agentName, undefined, callRole);
        // 预解析逐项 agent/role/maxTurns 覆盖：未知名称或非法 role 直接拒绝整次调用（与调用级 agent 一致）
        const itemResolutions = new Map<number, ResolvedSubAgent>();
        for (const [index, item] of items.entries()) {
          if (item.agent === undefined && item.role === undefined && item.maxTurns === undefined) continue;
          try {
            const resolved = await this.resolveSubAgent(session.cwd, sessionId, item.agent ?? agentName, undefined, item.role ?? callRole);
            itemResolutions.set(index, item.maxTurns !== undefined ? { ...resolved, maxTurns: item.maxTurns } : resolved);
          } catch (error) {
            const message = errorMessage(error);
            throw new Error(`${message} (item ${index + 1})`);
          }
        }
        const subUsageContext = new ContextManager(this.sessions.contextRoot(sessionId));
        const contextRoot = this.sessions.contextRoot(sessionId);
        // 本次 swarm 的共享讨论板（<sessionDir>/subagents/swarm-<swarmId>-board.jsonl）：
        // swarmId 取 toolCallId，含文件名异字符时回落 uuid
        const swarmId = /^[\w-]+$/.test(toolCallId) ? toolCallId : randomUUID();
        const boardPath = swarmBoardPath(contextRoot, swarmId);
        interface SwarmItemOutcome { ok: boolean; conclusion?: string; error?: string }
        const runOne = async (prompt: string, index: number): Promise<SwarmItemOutcome> => {
          const swarm = { index: index + 1, total: prompts.length };
          const effective = itemResolutions.get(index) ?? resolvedDefault;
          let taskId = "";
          try {
            // 生效 provider 按 effective resolution 逐项解析（角色档/frontmatter provider: 覆盖优先）
            const providerName = effective.providerOverride ?? session.provider;
            const provider = this.providers.get(providerName);
            if (!provider) throw new Error(`Provider ${providerName} is not configured`);
            const effectiveModel = effective.modelOverride ?? session.model;
            const systemExtra = await this.withSubAgentAppend(session.cwd, effective.systemExtra);
            // maxTurns 优先级：逐项显式 > 调用级 > 设置全局默认 > runSubAgent 兜底
            const itemMaxTurns = items[index]?.maxTurns;
            const maxTurns = itemMaxTurns ?? callMaxTurns ?? effective.maxTurns ?? this.subAgentMaxTurnsLimit();
            // 能力档案解析一次复用（同一 model+provider 多次 getProfile 会重复走目录分层查找）
            const subCapabilities = this.getProfile(effectiveModel, providerName).capabilities;
            const result = await runSubAgent({
              provider,
              model: session.model,
              reasoningContent: subCapabilities.reasoningContent !== false,
              ...(subCapabilities.responsesEncryptedReplay
                ? { responsesEncryptedReplay: true }
                : {}),
              ...(subCapabilities.thinkingStyle
                ? { thinkingStyle: subCapabilities.thinkingStyle }
                : {}),
              serverWebSearch: this.getWebSearchMode() === "model-api",
              ...(effective.modelOverride ? { modelOverride: effective.modelOverride } : {}),
              ...(systemExtra ? { systemExtra } : {}),
              ...(effective.name ? { agent: effective.name } : {}),
              agentKind: effective.kind,
              prompt,
              toolNames: effective.toolNames,
              maxTurns,
              shell: resolveShell(session.shellBackend ?? "default"),
              // general 类型：工具调用经会话权限链 + 主循环同一沙盒执行（见 executeSubAgentTool）。
              // swarm 成员同 subagent：内部工具默认模型审核（review），主 agent 切 yolo 时跟随 yolo
              ...(effective.kind === "general" ? { executeTool: (call: { name: string; input: Record<string, unknown> }) => this.executeSubAgentTool(sessionId, call.name, call.input, signal, "subagent") } : {}),
              core: this.core,
              sessionId,
              cwd: session.cwd,
              contextRoot,
              signal,
              // swarm 成员共享讨论板：member 缺省由子代理回落 taskId
              swarm: { boardPath, ...(effective.name ? { member: effective.name } : {}) },
              onStart: async (id) => {
                taskId = id;
                subagentTaskIds[index] = id;
                this.events.publish({
                  source: "agent",
                  type: "subagent.started",
                  sessionId,
                  payload: { toolCallId, taskId: id, prompt: prompt.slice(0, 200), swarm, ...(effective.name ? { agent: effective.name } : {}) },
                });
                await this.runSubagentHook("SubagentStart", sessionId, session.cwd, { taskId: id, agent: effective.name, kind: effective.kind, swarm, prompt: prompt.slice(0, 200) });
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
              onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, providerName, effectiveModel, usage),
            });
            this.events.publish({
              source: "agent",
              type: "subagent.finished",
              sessionId,
              payload: { toolCallId, taskId: result.taskId, status: "done", turns: result.turns, toolsUsed: result.toolsUsed, swarm },
            });
            await this.runSubagentHook("SubagentStop", sessionId, session.cwd, { taskId: result.taskId, agent: effective.name, kind: effective.kind, swarm, status: "done" });
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
            // 仅真正启动过的成员补 SubagentStop（与逐项终态口径一致）
            if (taskId) await this.runSubagentHook("SubagentStop", sessionId, session.cwd, { taskId, agent: effective.name, kind: effective.kind, swarm, status: "failed", error: message });
            // 启动前失败的项没有 taskId/转录，不进入逐项终态
            if (taskId) subagentTasks.push({ taskId, index, status: "failed", error: message });
            return { ok: false, error: message };
          }
        };
        // 并发上限内的 worker-pool：超出项排队，单项失败不拖垮整批（allSettled 语义）；
        // 中断后不再启动排队项（在途项经 signal 自然中止）。
        // 并发成员数配置化：spawnSwarmConcurrencyLimit 现读设置项（2–16，默认 4）
        const outcomes: SwarmItemOutcome[] = new Array(prompts.length) as SwarmItemOutcome[];
        let next = 0;
        const workers = Array.from({ length: Math.min(this.spawnSwarmConcurrencyLimit(), prompts.length) }, async () => {
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
        // 讨论板摘要：路径、总条数、各成员发帖数、最后几条；板为空/读取失败时省略（digestSwarmBoard 内部已降级）
        const boardDigest = await digestSwarmBoard(boardPath);
        const summary = boardDigest ? `${aggregated}\n\n---\nBoard digest\n${boardDigest}` : aggregated;
        const bounded = await boundToolResult(contextRoot, name, summary);
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.getMeta(sessionId);
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
    if (name === "cron_create" || name === "cron_list" || name === "cron_delete") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        if (!this.cronScheduler) throw new Error("Cron scheduler is not enabled");
        let payload: unknown;
        if (name === "cron_create") {
          const cron = typeof input.cron === "string" ? input.cron : "";
          const prompt = typeof input.prompt === "string" ? input.prompt : "";
          payload = await this.cronScheduler.create(sessionId, {
            cron,
            prompt,
            ...(input.recurring === undefined ? {} : { recurring: Boolean(input.recurring) }),
          });
        } else if (name === "cron_list") {
          payload = await this.cronScheduler.list(sessionId);
        } else {
          const id = typeof input.id === "string" ? input.id : "";
          if (!id) throw new Error("cron_delete requires a job id");
          if (!(await this.cronScheduler.delete(sessionId, id))) throw new Error(`Cron job not found: ${id}`);
          payload = { deleted: id };
        }
        const content = JSON.stringify(payload);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { cron: name } } });
        return { type: "tool_result", toolCallId, content, isError: false };
      } catch (error) {
        const content = errorMessage(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "ask_user") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
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
            // 选择题自动附加「其他」选项：UI 渲染「其他」+ 自定义文本输入框，回答以 other:<文本> 表示
            ...(spec.type === "single_select" || spec.type === "multi_select" ? { allowOther: true } : {}),
          });
          this.state(sessionId, "waiting_permission");
          const outcome = await this.runControl.waitForInteractionAnswer(sessionId, interaction.id, signal);
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
    if (name === "exit_plan_mode") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const plan = typeof input.plan === "string" ? input.plan.trim() : "";
        if (!plan) throw new Error("exit_plan_mode requires a non-empty plan");
        const runId = this.runs.get(sessionId)?.id ?? "";
        // 计划批准走 InteractionCoordinator 落盘（kind=plan_approval，prompt 即计划全文），
        // 语义同 ask_user：持久 pending，重启后可恢复；REST respond 恢复工具执行。
        const interaction = await this.createInteraction(sessionId, {
          runId,
          toolCallId,
          kind: "plan_approval",
          title: "计划批准",
          prompt: plan,
        });
        this.state(sessionId, "waiting_permission");
        const outcome = await this.runControl.waitForInteractionAnswer(sessionId, interaction.id, signal);
        this.state(sessionId, "tool_running");
        if (outcome.cancelled) {
          this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { cancelled: true } } });
          return { type: "tool_result", toolCallId, content: JSON.stringify({ cancelled: true }), isError: false };
        }
        const decision = parsePlanApprovalDecision(outcome.answer);
        let content: string;
        if (decision.kind === "reject") {
          // 拒绝：保持 plan 模式，意见回注给 run 继续研究
          content = `计划被拒绝${decision.feedback ? `，意见：${decision.feedback}` : "（未附意见）"}。保持 plan 模式，请根据意见继续研究并修订计划，完成后再次调用 exit_plan_mode。`;
        } else {
          const finalPlan = decision.kind === "edit" ? decision.plan.trim() : plan;
          await this.switchToBuildMode(sessionId);
          content = `计划已批准，已切换到 code 模式。请按计划执行：\n\n${finalPlan}`;
        }
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: { decision: decision.kind } } });
        return { type: "tool_result", toolCallId, content, isError: false };
      } catch (error) {
        const content = errorMessage(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name === "read_artifact") {
      try {
        const session = await this.sessions.getMeta(sessionId);
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.getMeta(sessionId);
        if (!session) throw new Error("Session not found");
        if (input.budget !== undefined && (!Number.isInteger(Number(input.budget)) || Number(input.budget) < 64)) {
          throw new Error("repo_map budget must be an integer >= 64");
        }
        // 与自动注入共用同一生成器/缓存；显式调用不受会话自动注入开关影响。
        const map = await this.repoMap.generate({
          sessionId,
          cwd: session.cwd,
          budget: input.budget === undefined ? (session.repoMapBudget ?? DEFAULT_REPO_MAP_BUDGET) : Number(input.budget),
          // 排除路径是 context-saver 扩展的选择性上下文能力：扩展关闭时不生效
          excludes: !this.extensions || this.extensions.isEnabled("context-saver") ? session.contextExcludes ?? [] : [],
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.getMeta(sessionId);
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.getMeta(sessionId);
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.getMeta(sessionId);
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
    if (name === "read_media") {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const { result, eventResult } = await this.executeReadMedia(sessionId, toolCallId, input, mediaCapability, signal);
        // 事件只带元数据（媒体本体随持久化 tool_result 走，不进 WS 帧）
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: eventResult } });
        return result;
      } catch (error) {
        const content = errorMessage(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (FILE_TOOLS.some((tool) => tool.name === name)) {
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.getMeta(sessionId);
        if (!session) throw new Error("Session not found");
        const raw = await this.callCoreFileTool(sessionId, name, input, signal);
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
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
            // run 中止或超时后返回当前状态，不再等满 timeoutMs
            if (signal.aborted || Date.now() >= deadline) return entry;
            // 等待期间 abort 即时唤醒（与 executeBash 的取消纪律一致），避免 250ms 死等
            await new Promise<void>((resolve) => {
              const onAbort = (): void => { clearTimeout(timer); resolve(); };
              const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 250);
              signal.addEventListener("abort", onAbort, { once: true });
            });
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
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
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, ...boundToolEventInput(input) } });
      this.state(sessionId, "tool_running");
      try {
        if (!this.backgroundTasks) throw new Error("后台任务未启用");
        const session = await this.sessions.getMeta(sessionId);
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

    const bashResult = await this.executeBash(sessionId, input.cmd, toolCallId, signal, { sessionEnv: true });
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
    options?: { quiet?: boolean; sessionEnv?: boolean },
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
      const session = await this.sessions.getMeta(sessionId);
      if (!session) throw new Error("Session not found");
      // 提交⑩：默认走持久 shell（同一会话 cwd/env 跨调用保持）；pty 不可用（旧 core）时回退一次性 exec 路径
      const persistent = await this.tryPersistentBash(session, cmd, toolCallId, signal, quiet);
      if (persistent) return persistent;
      // 会话元数据环境变量（OWC_SESSION_ID 等，仅 agent bash 工具；人类 ! 命令不注入）：
      // 最内层包装先拼上，随后被 node/python 环境包装包住，export 先对用户命令生效
      if (options?.sessionEnv) cmd = wrapCommandWithSessionEnv(cmd, session, resolveShell(session.shellBackend ?? "default").flavor);
      cmd = await this.wrapForNodeEnv(session, cmd);
      cmd = await this.wrapForPythonEnv(session, cmd);
      if (await this.coreGateway.supports("jobControl")) {
        const jobId = `job-${randomUUID()}`;
        const output: Array<{ stream: "stdout" | "stderr"; data: string; seq: number }> = [];
        let afterSeq = 0;
        const cancel = () => { void this.core.cancelJob({ sessionId, jobId }).catch(() => undefined); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          // jobControl 路径本身无 RPC 超时兜底：给 core 侧 10 分钟上限，轮询循环遇 timed_out 终止
          await this.core.startJob({ sessionId, jobId, kind: "exec", cmd, cwd: session.cwd, timeoutMs: 10 * 60_000, ...coreExecShell(session.shellBackend ?? "default") });
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
      const result = await this.core.run({ sessionId, execId, cmd, cwd: session.cwd, ...coreExecShell(session.shellBackend ?? "default") });
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
   * 持久 shell 执行（提交⑩）：成功返回结果；pty 不可用返回 null 由调用方回退一次性 exec.run；
   * 命令级失败（超时/shell 退出/输入失败）转成 isError=true，与一次性路径一致不抛错。
   * pythonEnv 在 shell 启动层激活（PATH 前置一次），不再逐命令包装。
   */
  private async tryPersistentBash(
    session: SessionMeta,
    cmd: string,
    toolCallId: string,
    signal: AbortSignal,
    quiet: boolean,
  ): Promise<{ content: string; isError: boolean } | null> {
    let result;
    try {
      result = await this.persistentShells.run(session, cmd, signal);
    } catch (error) {
      if (error instanceof PersistentShellUnavailableError) return null;
      if (signal.aborted) throw error;
      const content = errorMessage(error);
      if (!quiet) this.events.publish({ source: "agent", type: "tool.end", sessionId: session.id, payload: { toolCallId, error: content } });
      return { content, isError: true };
    }
    const rawContent = JSON.stringify({
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated,
      ...(result.sandboxCapability !== undefined ? { sandboxCapability: result.sandboxCapability } : {}),
      ...(result.sandboxReason !== undefined ? { sandboxReason: result.sandboxReason } : {}),
      output: result.output,
    });
    const bounded = await boundToolResult(this.sessions.contextRoot(session.id), "bash", rawContent);
    if (!quiet) this.events.publish({ source: "agent", type: "tool.end", sessionId: session.id, payload: { toolCallId, result: toolEventResult(bounded) } });
    return { content: bounded.content, isError: false };
  }

  /** 会话删除时回收该会话的持久 shell（挂在 app.ts 会话删除路由的清理链上）。 */
  async disposePersistentShells(sessionId: string): Promise<void> {
    this.persistentShells.disposeSession(sessionId);
  }

  /**
   * 会话删除时清理按会话/cwd 键控的无界小 Map（perf 环形缓冲、MCP 告警签名、任务清单、提示词覆盖缓存）。
   * cwd 级缓存误清只导致下次 run 重建一次，不影响正确性。
   */
  discardSession(sessionId: string, cwd?: string): void {
    this.perfRecords.delete(sessionId);
    this.mcpWarningSignatures.delete(sessionId);
    this.todos.delete(sessionId);
    if (cwd) this.promptOverrideCache.delete(cwd);
  }

  /**
   * nodeEnv=project/fnm/nvm 时把会话 bash 包装进对应 node 环境（PATH 前置或版本管理器激活前缀）；
   * global（本机环境）原样返回。管理器缺失/当前 shell 不支持时回退本机环境并在输出中说明。
   */
  private async wrapForNodeEnv(session: SessionMeta, cmd: string): Promise<string> {
    const mode = effectiveNodeEnv(session.nodeEnv, this.getNodeEnvDefault());
    if (mode === "global") return cmd;
    const flavor = resolveShell(session.shellBackend ?? "default").flavor;
    const ensured = await this.nodeEnvManager.ensure(mode, flavor);
    if (!ensured.ok) return wrapCommandWithNote(cmd, ensured.note ?? "node environment unavailable; using the host node environment");
    const wrapped = wrapCommandWithNodeEnv(cmd, mode, session.cwd, flavor);
    if (wrapped === null) return wrapCommandWithNote(cmd, `${mode} activation is not supported for this shell, using the host node environment`);
    return wrapped;
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
    return wrapCommandWithVenv(cmd, venvDir, resolveShell(session.shellBackend ?? "default").flavor);
  }

  // 用量记账：主循环与 subagent 子代理共用同一 ledger/用量日志/事件路径
  private async recordUsageEvent(
    sessionId: string,
    context: ContextManager,
    providerName: string,
    model: string,
    event: Extract<ProviderEvent, { type: "usage" }>,
    options: { persist?: boolean; turn?: TurnLedger } = {},
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
    // persist=false：仅实时转发 WS（逐 chunk 的 usage 中间帧），ledger/usageLog 不重复记账；
    // sessionCost 取当前已记账累计，本轮最后一条（persist）才落账。
    // 主循环经轮级句柄记账（commitTurn 统一落盘）；子代理不传句柄，保持自载自存即时落盘。
    const persist = options.persist !== false;
    const ledger = persist ? await context.recordUsage(event, recordedCost, options.turn) : await context.load();
    if (persist) {
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
    }
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

  /**
   * 中断收尾：为活动路径上没有对应 tool_result 的已落盘 tool_call 补写占位结果。
   * 正常路径下每个 tool_call 紧随其后落盘结果；abort 在 executeTool 内抛出时循环内
   * 落盘被跳过，历史形状非法会让下一次 provider 请求直接 400（Responses API 尤其严格）。
   */
  private async backfillAbortedToolResults(sessionId: string): Promise<void> {
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) return;
      const active = activePathMessages(session.messages, session.activeLeafId);
      const results = new Set(
        active
          .flatMap((message) => message.content)
          .filter((block) => block.type === "tool_result")
          .map((block) => block.toolCallId),
      );
      // 只补活动路径：旧分支的悬空调用不进入上下文视图，补写反而会以
      // 无对应 function_call 的 output 污染活动路径。
      for (const message of active) {
        for (const block of message.content) {
          if (block.type !== "tool_call" || results.has(block.id)) continue;
          await this.sessions.appendMessage(sessionId, "tool", [
            { type: "tool_result", toolCallId: block.id, content: "The run was interrupted before this tool finished; no result was produced.", isError: true },
          ], this.messageLineage(sessionId));
          results.add(block.id);
        }
      }
    } catch (error) {
      // 补写失败不掩盖 abort 本身；provider 层仍有兜底修复。但必须留痕——
      // 否则下一次请求撞 provider 400 时无法诊断历史形状为何仍非法。
      process.stderr.write(`[agent-runner] backfillAbortedToolResults failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
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
    // 状态未变则跳过落盘与事件：run.state 同步赋值后 writeRun 已 await 落盘，
    // 相同状态必然已持久化；重复事件对消费方（web 端状态徽章/live-store、REST run 快照、
    // 扩展白名单推送）只会重复触发同值写入与 invalidate，还让每轮多工具循环
    // （tool_running 反复触发）多出 2×tmp+rename 原子写。turnIndex 变更由 setTurnIndex
    // 单独落盘，且跨轮状态序列相邻必不同，事件不会丢 turnIndex 信息。
    if (run.state === state) return Promise.resolve();
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

/** Notification(permission) 的待批摘要：工具名 + 关键参数（cmd/path/url，截断 200 字符）。 */
function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  const detail = typeof input.cmd === "string" ? input.cmd
    : typeof input.path === "string" ? input.path
      : typeof input.url === "string" ? input.url
        : "";
  return detail ? `${tool}: ${detail.slice(0, 200)}` : tool;
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
