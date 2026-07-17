import { randomUUID } from "node:crypto";
import type { CoreClient, CoreEvent } from "../core-client.js";
import type { EventBus } from "../events/event-bus.js";
import { ContextManager, selectCacheBreakpoints } from "../context/context-manager.js";
import type { Compactor } from "../context/compactor.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import { estimateMessageTokens, getModelProfile, type ModelProfile } from "../context/model-profile.js";
import { calculateUsageCost } from "../cost/cost-calculator.js";
import type { ExchangeRateService } from "../cost/exchange-rate.js";
import type { PricingCatalog } from "../cost/pricing-catalog.js";
import type { ProviderRegistry, ProviderTool } from "../providers/provider.js";
import { collectProviderTurn } from "../providers/retry.js";
import { PermissionCoordinator, permissionRule, type PermissionDecision } from "./permission-coordinator.js";
import { getSnapshotBackend } from "../snapshots/index.js";
import type { MessageContent } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import { parseSkillCommand, type SkillRegistry } from "../skills.js";
import type { McpManager } from "../mcp/manager.js";
import type { UsageLog } from "../usage-log.js";

interface ExecutionContext {
  sessionId: string;
  output: Array<{ stream: string; data: string; seq: number }>;
}

const BASH_TOOL: ProviderTool = {
  name: "bash",
  description: "Execute a shell command in the session workspace. Call this when command-line execution is required.",
  inputSchema: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
    additionalProperties: false,
  },
};

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

const TOOLS = [BASH_TOOL, ...FILE_TOOLS, READ_ARTIFACT_TOOL, LOAD_SKILL_TOOL];

interface SteeringItem {
  id: string;
  content: string;
  createdAt: string;
}

const MAX_STEERING_ITEMS = 16;
const MAX_STEERING_LENGTH = 8_000;

export class SteeringError extends Error {
  constructor(message: string, readonly code: "not_running" | "too_long" | "full") {
    super(message);
    this.name = "SteeringError";
  }
}

export class AgentRunner {
  private readonly running = new Map<string, AbortController>();
  private readonly steering = new Map<string, SteeringItem[]>();
  private readonly repeatedCalls = new Map<string, { signature: string; count: number }>();
  private readonly mcpWarningSignatures = new Map<string, string>();
  private readonly permissions: PermissionCoordinator;

  constructor(
    private readonly sessions: SessionStore,
    private readonly providers: ProviderRegistry,
    private readonly core: CoreClient,
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
  ) {
    this.permissions = new PermissionCoordinator(events);
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

  async run(sessionId: string, text: string, options?: { images?: Array<{ mediaType: string; data: string }> }): Promise<void> {
    if (this.running.has(sessionId)) throw new Error("Session agent is already running");
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    try {
      const configuredSession = await this.sessions.get(sessionId);
      if (!configuredSession) throw new Error("Session not found");
      // 输入框 /技能名 手动触发：展开为技能全文 + 用户补充（检查点标题仍用原文）
      const effectiveText = await this.expandSkillCommand(configuredSession.cwd, text);
      await this.core.configureSession({ sessionId, cwd: configuredSession.cwd, sandbox: configuredSession.sandbox ?? { enabled: true, readRoots: [configuredSession.cwd], writeRoots: [configuredSession.cwd], denyPaths: [], network: "allow" } });
      const checkpointContext = new ContextManager(this.sessions.contextRoot(sessionId));
      const checkpoint = await (await getSnapshotBackend(this.sessions, configuredSession))
        .create(text.slice(0, 80) || "User message", configuredSession.messages.length, await checkpointContext.load());
      this.events.publish({ source: "session", type: "checkpoint.created", sessionId, payload: checkpoint });
      await this.sessions.appendMessage(sessionId, "user", [
        ...(options?.images ?? []).map((image): MessageContent => ({ type: "image", mediaType: image.mediaType, data: image.data })),
        { type: "text", text: effectiveText },
      ]);
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

        // 技能目录注入系统提示：每轮现扫，保证新增技能即时可见
        const skillCatalog = this.skills ? await this.skills.listFor(session.cwd) : [];
        const skillSection = skillCatalog.length > 0
          ? `\n\nAvailable skills (load full text with the load_skill tool when relevant; the user can also trigger one with /name):\n${skillCatalog.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
          : "";

        // MCP 工具：失败 server 降级为告警（同一组告警每轮只播一次）
        const mcpBinding = this.mcp ? await this.mcp.toolsFor(session.cwd) : { tools: [], warnings: [] as string[] };
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

        const turn = await collectProviderTurn(
          provider,
          {
            model: session.model,
            ...(session.thinking ? { thinking: session.thinking } : {}),
            ...(session.effort ? { effort: session.effort } : {}),
            system: `You are OpenWebCode. The workspace is ${session.cwd}. Respond in ${this.defaultLanguage} unless the user explicitly requests another language.${skillSection}`,
            messages: view.messages,
            cacheBreakpoints,
            tools: [...TOOLS, ...mcpBinding.tools],
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
        let stopReason: string | undefined;
        for (const event of turn.events) {
          if (event.type === "text_delta") {
            assistantContent.push({ type: "text", text: event.text });
            this.events.publish({ source: "agent", type: "message.delta", sessionId, payload: { text: event.text } });
          } else if (event.type === "thinking_delta") {
            this.events.publish({ source: "agent", type: "message.thinking_delta", sessionId, payload: { text: event.text } });
          } else if (event.type === "thinking_end") {
            assistantContent.push({
              type: "thinking",
              text: event.text,
              ...(event.signature ? { signature: event.signature } : {}),
              provider: provider.name,
            });
          } else if (event.type === "tool_call") {
            assistantContent.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
          } else if (event.type === "usage") {
            const usageCost = calculateUsageCost(event, this.pricing.get(session.provider, session.model), this.exchangeRates?.current());
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
              provider: session.provider,
              model: session.model,
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
          } else {
            stopReason = event.stopReason;
          }
        }
        if (assistantContent.length > 0) {
          await this.sessions.appendMessage(sessionId, "assistant", assistantContent);
        }
        if (stopReason !== "tool_use") {
          if (this.steering.get(sessionId)?.length) {
            await this.applySteering(sessionId);
            this.state(sessionId, "thinking");
            continue;
          }
          return;
        }

        const toolCalls = assistantContent.filter((block) => block.type === "tool_call");
        if (toolCalls.length === 0) throw new Error("Provider stopped for tool use without a tool call");
        for (const call of toolCalls) {
          const repeated = this.recordToolCall(sessionId, call.name, call.input);
          if (repeated >= 3) {
            const content = `Tool call blocked: ${call.name} was requested with identical arguments ${repeated} consecutive times.`;
            this.events.publish({ source: "agent", type: "tool.repeated", sessionId, payload: { name: call.name, input: call.input, count: repeated } });
            await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId: call.id, content, isError: true }]);
            continue;
          }
          const permission = await this.authorizeTool(sessionId, call.name, call.input, controller.signal);
          if (!permission.allowed) {
            await this.sessions.appendMessage(sessionId, "tool", [{ type: "tool_result", toolCallId: call.id, content: permission.reason ?? "Tool permission denied", isError: true }]);
            continue;
          }
          const result = await this.executeTool(sessionId, call.name, call.id, call.input, controller.signal);
          await this.sessions.appendMessage(sessionId, "tool", [result]);
        }
        await context.advanceRound();
        const afterTools = await this.sessions.get(sessionId);
        if (afterTools) {
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
      this.running.delete(sessionId);
      this.repeatedCalls.delete(sessionId);
      // abort 路径保留未应用的 steering 队列，供用户编辑/重发；正常结束才清理
      if (!controller.signal.aborted) this.steering.delete(sessionId);
      this.state(sessionId, "idle");
    }
  }

  listPendingPermissions(sessionId: string): Array<{ requestId: string; tool: string; input: Record<string, unknown> }> {
    return this.permissions.listPending(sessionId);
  }

  async respondPermission(sessionId: string, requestId: string, decision: PermissionDecision, reason?: string): Promise<boolean> {
    const response = this.permissions.respond(sessionId, requestId, decision, reason);
    if (!response) return false;
    try {
      if (response.persist) {
        const session = await this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        const rule = permissionRule(response.tool, response.input);
        const rules = [...(session.permissionRules ?? []).filter((item) => item.tool !== rule.tool || item.argumentPrefix !== rule.argumentPrefix), rule];
        await this.sessions.updatePermissions(sessionId, session.permissionMode ?? "ask", rules);
      }
      response.complete();
      return true;
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

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  enqueueSteering(sessionId: string, content: string): { id: string; position: number } {
    if (!this.running.has(sessionId)) throw new SteeringError("Session agent is not running", "not_running");
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
    const mode = session.permissionMode ?? "ask";
    const rules = session.permissionRules ?? [];
    if (!this.permissions.needsApproval(mode, rules, tool, input)) return { allowed: true };
    this.state(sessionId, "waiting_permission");
    const result = await this.permissions.request(sessionId, tool, input, signal);
    this.state(sessionId, "tool_running");
    return { allowed: result.allowed, ...(result.reason ? { reason: result.reason } : {}) };
  }

  private async expandSkillCommand(cwd: string, text: string): Promise<string> {
    if (!this.skills) return text;
    const command = parseSkillCommand(text);
    if (!command) return text;
    const skill = await this.skills.find(cwd, command.name);
    if (!skill) return text;
    const request = command.rest !== "" ? command.rest : "Follow the skill instructions above.";
    return `[Skill "${skill.name}" — full text]\n${skill.body}\n\n[User request]\n${request}`;
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
          payload: { toolCallId, result: { content: bounded.content }, truncated: bounded.truncated, isError: result.isError, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) },
        });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: result.isError };
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
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result: value, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
        return { type: "tool_result", toolCallId, content: bounded.content, isError: false };
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error);
        this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
        return { type: "tool_result", toolCallId, content, isError: true };
      }
    }
    if (name !== "bash" || typeof input.cmd !== "string" || !input.cmd) {
      return { type: "tool_result", toolCallId, content: `Unsupported or invalid tool call: ${name}`, isError: true };
    }
    signal.throwIfAborted();
    const execId = `${sessionId}:${randomUUID()}`;
    const execution: ExecutionContext = { sessionId, output: [] };
    this.executions.set(execId, execution);
    this.events.publish({ source: "agent", type: "tool.start", sessionId, payload: { toolCallId, name, input, execId } });
    this.state(sessionId, "tool_running");
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) throw new Error("Session not found");
      const result = await this.core.run({ sessionId, execId, cmd: input.cmd, cwd: session.cwd });
      const output = execution.output
        .sort((a, b) => a.seq - b.seq)
        .map((chunk) => ({
          stream: chunk.stream,
          data: Buffer.from(chunk.data, "base64").toString("utf8"),
        }));
      const rawContent = JSON.stringify({ ...result, output });
      const bounded = await boundToolResult(this.sessions.contextRoot(sessionId), name, rawContent);
      const content = bounded.content;
      this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, result, truncated: bounded.truncated, ...(bounded.artifactId ? { artifactId: bounded.artifactId } : {}) } });
      return { type: "tool_result", toolCallId, content, isError: false };
    } catch (error) {
      if (signal.aborted) throw error;
      const content = error instanceof Error ? error.message : String(error);
      this.events.publish({ source: "agent", type: "tool.end", sessionId, payload: { toolCallId, error: content } });
      return { type: "tool_result", toolCallId, content, isError: true };
    } finally {
      this.executions.delete(execId);
    }
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
