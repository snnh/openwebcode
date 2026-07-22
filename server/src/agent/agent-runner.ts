import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CoreClientLike, CoreEvent } from "../core-client.js";
import type { EventBus } from "../events/event-bus.js";
import { ContextManager, selectCacheBreakpoints } from "../context/context-manager.js";
import type { Compactor } from "../context/compactor.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { estimateMessageTokens, getModelProfile, type ModelProfile } from "../context/model-profile.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { ExchangeRateService } from "../cost/exchange-rate.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import type { ProviderRegistry, ProviderTool, ProviderEvent } from "../providers/provider.js";
import { collectProviderTurn } from "../providers/retry.js";
import { PermissionCoordinator, permissionRule, type PermissionDecision } from "./permission-coordinator.js";
import { runSubAgent, SUB_AGENT_TOOL_NAMES } from "./sub-agent.js";
import { getSnapshotBackend } from "../snapshots/index.js";
import type { MessageContent } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
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
import { decodeProcessOutputChunks } from "./output-decoder.js";

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

function bashTool(backgroundTasksEnabled: boolean): ProviderTool {
  return {
    name: "bash",
    description: "Execute a shell command in the session workspace. Call this when command-line execution is required. " +
      "On Windows sandbox sessions commands run under cmd.exe: use cmd syntax (for example dir, type, where, and &&), " +
      "and do not use PowerShell cmdlets or POSIX commands unless explicitly invoking an available shell." +
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
}): ProviderTool[] {
  return [
    bashTool(options.backgroundTasksEnabled),
    ...FILE_TOOLS,
    READ_ARTIFACT_TOOL,
    ...(options.skillsAvailable ? [LOAD_SKILL_TOOL] : []),
    SPAWN_TASK_TOOL,
    TODO_WRITE_TOOL,
    REMEMBER_TOOL,
    ...(options.fetchAvailable ? [WEB_FETCH_TOOL] : []),
    ...(options.backgroundTasksEnabled ? [TASK_OUTPUT_TOOL, TASK_STOP_TOOL] : []),
    ...(options.searchAvailable ? [WEB_SEARCH_TOOL] : []),
  ];
}

interface SteeringItem {
  id: string;
  content: string;
  createdAt: string;
}

const MAX_STEERING_ITEMS = 16;
const MAX_STEERING_LENGTH = 8_000;
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
}

export class AgentRunner {
  private readonly running = new Map<string, AbortController>();
  /** Final assistant output is durable, but hooks/queue cleanup are not yet. */
  private readonly settling = new Set<string>();
  private readonly shells = new Map<string, AbortController>();
  private readonly steering = new Map<string, SteeringItem[]>();
  private readonly repeatedCalls = new Map<string, { signature: string; count: number }>();
  private readonly mcpWarningSignatures = new Map<string, string>();
  private readonly todos = new Map<string, TodoItem[]>();
  private readonly permissions: PermissionCoordinator;
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
    private readonly getProfile: (model: string) => ModelProfile = getModelProfile,
    private readonly usageLog?: UsageLog,
    private readonly skills?: SkillRegistry,
    private readonly mcp?: McpManager,
    private readonly compactor?: Compactor,
    private readonly dataDir?: string,
    private readonly agents?: AgentRegistry,
    private readonly commands?: CommandRegistry,
    private readonly search?: SearchProvider,
    _fetchImpl?: typeof fetch,
    private readonly backgroundTasks?: BackgroundTaskRegistry,
    private readonly hooks?: HookRunner,
    private readonly extensions?: ExtensionManager,
    webFetchProvider?: WebFetchProvider,
  ) {
    this.permissions = new PermissionCoordinator(events);
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

  async run(
    sessionId: string,
    text: string,
    options?: AgentRunOptions,
  ): Promise<void> {
    if (this.running.has(sessionId)) throw new Error("Session agent is already running");
    if (this.shells.has(sessionId)) throw new Error("A shell command is pending; respond to its permission request first");
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    try {
      const configuredSession = await this.sessions.get(sessionId);
      if (!configuredSession) throw new Error("Session not found");
      const appendUserMessage = async (message: string): Promise<void> => {
        await this.sessions.appendMessage(sessionId, "user", [
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
      await appendUserMessage(effectiveText);
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
      await this.core.configureSession({ sessionId, cwd: configuredSession.cwd, sandbox: configuredSession.sandbox ?? { enabled: true, readRoots: [configuredSession.cwd], writeRoots: [configuredSession.cwd], denyPaths: [], network: "allow" } });
      if (automaticSnapshot) {
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
      this.state(sessionId, "thinking");
      // 85% 水位强制概览压缩（§7.3 处理链⑤）：每次运行只触发一次
      let forceCompacted = false;
      for (let turn = 0; turn < this.maxTurns; turn++) {
        controller.signal.throwIfAborted();
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const context = new ContextManager(this.sessions.contextRoot(sessionId));
        const budget = await context.budgetStatus();
        if (budget.paused) {
          this.state(sessionId, "budget_paused");
          this.events.publish({ source: "agent", type: "agent.budget_paused", sessionId, payload: budget });
          return;
        }
        const view = await context.buildView(session.messages);
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
        const profile = this.getProfile(session.model);
        const estimatedTokens = estimateMessageTokens(view.messages);
        const workingBudget = Math.max(1, profile.contextWindow - profile.maxOutput);
        const utilization = estimatedTokens / workingBudget;
        this.events.publish({ source: "agent", type: "context.watermark", sessionId, payload: { estimatedTokens, contextWindow: profile.contextWindow, maxOutput: profile.maxOutput, workingBudget, utilization, warning: utilization >= 0.85 ? "force_compact" : utilization >= 0.7 ? "compact_recommended" : undefined } });
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

        const tools = toolsEnabled
          ? [
              ...builtInTools({
                skillsAvailable: skillCatalog.length > 0,
                backgroundTasksEnabled: Boolean(this.backgroundTasks),
                fetchAvailable: Boolean(this.webFetchProvider),
                searchAvailable: Boolean(this.search),
              }),
              ...mcpBinding.tools,
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

        // 后台任务完成提示（读后即清）
        // 后台任务是工具能力的一部分；不支持工具的模型既不注入也不消费待发送通知。
        const bgNotices = toolsEnabled ? (this.backgroundTasks?.drainNotices(sessionId) ?? []) : [];
        const bgNoticeSection = bgNotices.length > 0 ? `\n\n${bgNotices.join("\n")}` : "";

        const turn = await collectProviderTurn(
          provider,
          {
            model: session.model,
            ...(session.thinking ? { thinking: session.thinking } : {}),
            ...(session.effort ? { effort: session.effort } : {}),
            system: `You are OpenWebCode. The workspace is ${session.cwd}.${workDisciplineSection(availableToolNames)}${communicationSection(this.defaultLanguage)}${skillSection}${agentSection}${memorySection}${bgNoticeSection}${session.agentMode === "plan" ? planModeSection(toolsEnabled) : ""}${SAFETY_BOUNDARY_SECTION}`,
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
          await this.sessions.appendMessage(sessionId, "assistant", assistantContent);
        }
        const toolCalls = assistantContent.filter((block) => block.type === "tool_call");
        // Some compatible providers have emitted tool_call blocks with a non-tool stop reason.
        // A persisted tool_call must always receive one matching tool_result; otherwise the next
        // request has an invalid conversation shape and can fail before a user-visible reply.
        if (toolCalls.length === 0 && stopReason !== "tool_use") {
          if (this.steering.get(sessionId)?.length) {
            await this.applySteering(sessionId);
            this.state(sessionId, "thinking");
            continue;
          }
          // Once output is durable, stop accepting steering.  A request in
          // this hook/cleanup window must receive a retryable 409 instead of
          // a 202 that would later be discarded by finally.
          this.settling.add(sessionId);
          this.state(sessionId, "settling");
          try {
            // Stop 钩子：run 正常结束时通知（abort/error 路径不触发）。
            await this.runNotificationHook("Stop", { sessionId, cwd: session.cwd });
          } finally {
            this.settling.delete(sessionId);
          }
          return;
        }
        if (toolCalls.length === 0) throw new Error("Provider stopped for tool use without a tool call");
        for (const call of toolCalls) {
          let effectiveInput = call.input;
          let result: Extract<MessageContent, { type: "tool_result" }>;
          if (!availableToolNames.has(call.name)) {
            // Keep the plan-mode MCP safety boundary ahead of availability diagnostics: an
            // unadvertised MCP name is still opaque and must be described as read/write unknown.
            const content = session.agentMode === "plan" && call.name.startsWith("mcp__")
              ? `Plan 模式为只读：MCP 工具 ${call.name} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。`
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
          await this.sessions.appendMessage(sessionId, "tool", [result]);
          // PostToolUse 钩子：仅写类工具成功后触发（format-on-write 等），不阻断
          if (!result.isError && ["write_file", "edit_file", "bash"].includes(call.name)) {
            const summary = result.content.slice(0, 300);
            await this.runNotificationHook("PostToolUse", { sessionId, cwd: session.cwd, tool: call.name, input: effectiveInput, result: { summary } });
          }
        }
        await context.advanceRound();
        const afterTools = await this.sessions.get(sessionId);
        if (afterTools && (!this.extensions || this.extensions.isEnabled("context-manager"))) {
          await context.evict(afterTools.messages);
          this.events.publish({ source: "agent", type: "context.evicted", sessionId, payload: (await context.load()).entries });
        }
        if (this.steering.get(sessionId)?.length) await this.applySteering(sessionId);
        this.state(sessionId, "thinking");
      }
      throw new Error(`Agent exceeded ${this.maxTurns} turns`);
    } catch (error) {
      if (controller.signal.aborted) {
        this.events.publish({
          source: "agent",
          type: "agent.aborted",
          sessionId,
          payload: { message: "Agent run aborted" },
        });
        this.state(sessionId, "aborted");
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.events.publish({ source: "agent", type: "agent.error", sessionId, payload: { message } });
      throw error;
    } finally {
      this.settling.delete(sessionId);
      this.running.delete(sessionId);
      this.repeatedCalls.delete(sessionId);
      // abort 路径保留未应用的 steering 队列，供用户编辑/重发；正常结束才清理
      if (!controller.signal.aborted) this.steering.delete(sessionId);
      this.todos.delete(sessionId);
      this.events.publish({ source: "agent", type: "todos.updated", sessionId, payload: { items: [] } });
      this.state(sessionId, "idle");
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
        sandbox: session.sandbox ?? { enabled: true, readRoots: [session.cwd], writeRoots: [session.cwd], denyPaths: [], network: "allow" },
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

  /** shell 快捷前缀 `!cmd` 是否在挂起中（权限审批/执行中）；agent.isRunning 全程 false。 */
  isShellPending(sessionId: string): boolean {
    return this.shells.has(sessionId);
  }

  enqueueSteering(sessionId: string, content: string): { id: string; position: number } {
    if (!this.running.has(sessionId)) throw new SteeringError("Session agent is not running", "not_running");
    if (this.settling.has(sessionId)) throw new SteeringError("Session is settling; retry after it becomes idle", "not_running");
    if (content.length > MAX_STEERING_LENGTH) throw new SteeringError(`Steering message exceeds ${MAX_STEERING_LENGTH} characters`, "too_long");
    const queue = this.steering.get(sessionId) ?? [];
    if (queue.length >= MAX_STEERING_ITEMS) throw new SteeringError("Steering queue is full", "full");
    const item: SteeringItem = { id: randomUUID(), content, createdAt: new Date().toISOString() };
    queue.push(item);
    this.steering.set(sessionId, queue);
    this.events.publish({ source: "agent", type: "steering.queued", sessionId, payload: { ...item, position: queue.length } });
    return { id: item.id, position: queue.length };
  }

  listSteering(sessionId: string): SteeringItem[] {
    return [...(this.steering.get(sessionId) ?? [])];
  }

  removeSteering(sessionId: string, id: string): boolean {
    const queue = this.steering.get(sessionId);
    if (!queue) return false;
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [item] = queue.splice(index, 1);
    if (!queue.length) this.steering.delete(sessionId);
    this.events.publish({ source: "agent", type: "steering.removed", sessionId, payload: { id: item!.id } });
    return true;
  }

  private async applySteering(sessionId: string): Promise<void> {
    const queue = this.steering.get(sessionId);
    if (!queue?.length) return;
    const remaining: SteeringItem[] = [];
    for (const item of queue) {
      try {
        await this.sessions.appendMessage(sessionId, "user", [{ type: "text", text: item.content }]);
        this.events.publish({ source: "agent", type: "steering.applied", sessionId, payload: item });
      } catch {
        remaining.push(item);
      }
    }
    if (remaining.length) this.steering.set(sessionId, remaining);
    else this.steering.delete(sessionId);
  }

  private async authorizeTool(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
    const session = await this.sessions.get(sessionId);
    if (!session) return { allowed: false, reason: "Session not found" };
    // Plan 模式门禁：只读工具放行，其余一律拦截
    const PLAN_READONLY = new Set(["read_file", "glob", "grep", "read_artifact", "load_skill", "spawn_task", "todo_write", "web_fetch", "web_search", "task_output"]);
    if (session.agentMode === "plan") {
      if (tool.startsWith("mcp__")) return { allowed: false, reason: `Plan 模式为只读：MCP 工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 build 模式执行。` };
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

  private async executeTool(
    sessionId: string,
    name: string,
    toolCallId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MessageContent & { type: "tool_result" }> {
    if (name.startsWith("mcp__")) {
      if (!this.mcp) {
        return { type: "tool_result", toolCallId, content: "MCP is not enabled on this server", isError: true };
      }
      this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input } });
      this.state(sessionId, "tool_running");
      try {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const result = await this.mcp.callTool(session.cwd, name, input);
        const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, result.content);
        this.events.publish({
          source: "agent",
          type: "tool.end",
          sessionId,
          payload: { toolCallId, result: toolEventResult(bounded), isError: result.isError },
        });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: result.isError };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
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
          if (!this.search) throw new Error("Web search is not configured");
          const query = typeof input.query === "string" ? input.query.trim() : "";
          if (!query) throw new Error("web_search requires a non-empty query");
          const requested = input.limit === undefined ? 5 : Number(input.limit);
          if (!Number.isInteger(requested) || requested < 1) throw new Error("web_search limit must be a positive integer");
          value = await this.search.search(query, Math.min(requested, 10), { signal });
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
          onUsage: (usage) => this.recordUsageEvent(sessionId, subUsageContext, session.provider, definition?.model ?? session.model, usage),
        });
        this.events.publish({
          source: "agent",
          type: "tool.end",
          sessionId,
          payload: { toolCallId, result: { conclusion: result.conclusion, turns: result.turns, toolsUsed: result.toolsUsed } },
        });
        return { type: "tool_result", toolCallId, content: result.conclusion, isError: false };
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
      const capabilities = await this.core.ping();
      if (capabilities.features?.jobControl) {
        const jobId = `job-${randomUUID()}`;
        const output: Array<{ stream: "stdout" | "stderr"; data: string; seq: number }> = [];
        let afterSeq = 0;
        const cancel = () => { void this.core.cancelJob({ sessionId, jobId }).catch(() => undefined); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          await this.core.startJob({ sessionId, jobId, kind: "exec", cmd, cwd: session.cwd });
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
              throw new Error(`Job ${status.state}`);
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
      const result = await this.core.run({ sessionId, execId, cmd, cwd: session.cwd });
      const output = decodeProcessOutputChunks(execution.output);
      const rawContent = JSON.stringify({ ...result, output });
      const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), "bash", rawContent);
      this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
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

  private state(sessionId: string, state: string): void {
    this.events.publish({ source: "agent", type: "agent.state", sessionId, payload: { state } });
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
