import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreClientLike } from "../core-client.js";
import { ContextManager } from "../context/context-manager.js";
import { boundToolResult } from "../context/tool-result-budget.js";
import type { Provider, ProviderEvent, ProviderTool } from "../providers/provider.js";
import { collectProviderTurn } from "../providers/retry.js";
import type { ChatMessage, MessageContent, MessageRole } from "../sessions/types.js";
import {
  bashTool,
  CODE_SEARCH_TOOL,
  FILE_TOOLS,
  READ_ARTIFACT_TOOL,
  REPO_MAP_TOOL,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
  TEST_RUNNER_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from "./tool-schemas.js";
import { appendSwarmBoard, readSwarmBoard } from "./swarm-board.js";
import { resolveShell, type ResolvedShell } from "./shell-detect.js";

/**
 * 子代理允许使用的只读工具全集（构造上只读；subagent 不在其中，子代理不可再派生）。
 */
export const SUB_AGENT_TOOL_NAMES = ["read_file", "glob", "grep", "read_artifact"] as const;

/**
 * general 内置子代理的工具全集：文件读写/编辑 + glob/grep + bash + repo_map/code_search
 * + test_runner + web_fetch/web_search（可用时）。编排类（subagent/spawn_swarm）与
 * 会话控制类工具刻意排除——子代理不可再派生，也不能触碰父会话状态。
 * 键名一律为真实内置名（工具形态别名由 agent-runner 归一后再传入）。
 */
export const GENERAL_AGENT_TOOL_NAMES = [
  "read_file", "write_file", "edit_file", "glob", "grep", "read_artifact",
  "bash", "repo_map", "code_search", "test_runner", "web_fetch", "web_search",
] as const;

/** 结论硬上限（防单条结论撑爆主上下文；正常结论远小于此值）。 */
export const SUB_AGENT_CONCLUSION_LIMIT = 64_000;

type BuiltinSubAgentKind = "explore" | "general";

export interface BuiltinSubAgent {
  id: BuiltinSubAgentKind;
  /** 中文描述（GET /api/agents；前端按 id 做 i18n）。 */
  description: string;
  toolNames: readonly string[];
  maxTurns: number;
}

/** 内置子代理类型注册表：explore 为缺省（只读探索，行为与历史一致），general 为可写通用子代理。 */
export const BUILTIN_SUB_AGENTS: readonly BuiltinSubAgent[] = [
  {
    id: "explore",
    description: "只读探索子代理（read_file/glob/grep/read_artifact）",
    toolNames: SUB_AGENT_TOOL_NAMES,
    maxTurns: 100,
  },
  {
    id: "general",
    description: "通用子代理（可读写文件、执行命令，走会话权限链与沙盒）",
    toolNames: GENERAL_AGENT_TOOL_NAMES,
    maxTurns: 100,
  },
];

export function getBuiltinSubAgent(name: string): BuiltinSubAgent | undefined {
  return BUILTIN_SUB_AGENTS.find((agent) => agent.id === name);
}

/** 子代理工具 schema 总表：复用 tool-schemas 的内置 schema，按名字过滤出各类型允许集。
 * bash 不在此静态表——其描述随会话实际 shell 生成（runSubAgent 的 shell 选项）。 */
const SUB_AGENT_TOOL_SCHEMAS: readonly ProviderTool[] = [
  ...FILE_TOOLS,
  READ_ARTIFACT_TOOL,
  REPO_MAP_TOOL,
  CODE_SEARCH_TOOL,
  TEST_RUNNER_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
];

/** 一次子代理工具调用经调用方（agent-runner）的权限链 + 沙盒执行后的结果。 */
interface SubAgentToolExecutor {
  (call: { name: string; input: Record<string, unknown>; toolCallId: string }): Promise<{ content: string; isError: boolean }>;
}

export interface SubAgentOptions {
  provider: Provider;
  model: string;
  prompt: string;
  /** 请求放行的工具名；实际生效为 ∩ 解析类型的允许集。 */
  toolNames: string[];
  /** 内置类型：explore（默认，只读）或 general（可写，工具经 executeTool 走权限链）。 */
  agentKind?: BuiltinSubAgentKind;
  /** 会话实际 shell（bash 工具描述按它生成；缺省按 default 探测）。 */
  shell?: ResolvedShell;
  systemExtra?: string;
  modelOverride?: string;
  agent?: string;
  core: CoreClientLike;
  sessionId: string;
  cwd: string;
  contextRoot: string;
  signal: AbortSignal;
  maxTurns?: number;
  /** 手动启动等需要预分配 taskId 的场景；缺省内部生成（转录文件名即 <taskId>.json）。 */
  taskId?: string;
  /**
   * general 类型的工具执行入口（由 agent-runner 注入）：每个工具调用经会话权限链
   * （authorizeTool：plan 门禁 + 权限模式/规则 + permission.request 挂起）与主循环
   * 同一沙盒配置执行。explore/自定义类型不注入，保持本地只读执行。
   */
  executeTool?: SubAgentToolExecutor;
  /**
   * swarm 成员上下文（仅 spawn_swarm 派发时注入）：boardPath 为本次 swarm 的共享讨论板
   * （<sessionDir>/subagents/swarm-<swarmId>-board.jsonl），member 为发帖署名（成员名，
   * 缺省回落 taskId）。注入后子代理额外获得 swarm_board_post / swarm_board_read 两个工具。
   */
  swarm?: { boardPath: string; member?: string };
  /** 每次 LLM 用量事件回调（由调用方记账，子代理 token 计入会话成本）。 */
  onUsage?: (usage: Extract<ProviderEvent, { type: "usage" }>) => void | Promise<void>;
  /** taskId 生成后立即回调（用于发布 subagent.started；转录文件名即 <taskId>.json）。支持异步（回调完成后子代理才开始，保证 SubagentStart 先于 Stop）。 */
  onStart?: (taskId: string) => void | Promise<void>;
  /** 每轮 provider 调用结束与每批工具执行结束后回调（仅元数据，不含文本；用于发布 subagent.progress）。 */
  onProgress?: (progress: { turns: number; toolsUsed: string[] }) => void;
  /** 思维链回传（仅 OpenAI 兼容接口生效）：由调用方按实际请求模型（modelOverride ?? model）的能力声明下发。
   * 子代理每轮把 thinking_delta/thinking_end 累积为带 provider 的 thinking 块写入对话历史，
   * 下一轮由 provider 按能力声明回传（DeepSeek 思维模式强制要求，缺素材会 400）。 */
  reasoningContent?: boolean;
  /** 服务端联网搜索（请求级，仅 OpenAI Responses 接口生效）：model-api 模式下由调用方统一下发。 */
  serverWebSearch?: boolean;
}

interface SubAgentResult {
  taskId: string;
  conclusion: string;
  turns: number;
  toolsUsed: string[];
}

function systemPrompt(kind: BuiltinSubAgentKind, cwd: string, systemExtra: string | undefined): string {
  const base = kind === "general"
    ? `You are a general-purpose coding sub-agent spawned by OpenWebCode. The workspace is ${cwd}. ` +
      "You run in an isolated context and cannot see the parent conversation. " +
      "Complete the assigned task end-to-end: you may read and modify files and run commands with the tools provided. " +
      "Write operations and commands go through the session's permission chain and sandbox; if a call is denied, adjust rather than retrying the identical call. " +
      "When finished, reply with one concise conclusion in the user's language (default 中文) summarizing what you changed and how you verified it. " +
      "Do not ask questions; make reasonable assumptions."
    : `You are a read-only exploration sub-agent spawned by OpenWebCode. The workspace is ${cwd}. ` +
      "You run in an isolated context and cannot see the parent conversation. " +
      "You may only use the read-only tools provided; you cannot modify files or run commands. " +
      "Investigate the task, then reply with one concise conclusion in the user's language (default 中文). " +
      "Do not ask questions; make reasonable assumptions.";
  return `${base}${systemExtra ? `\n\n${systemExtra}` : ""}`;
}

export async function runSubAgent(options: SubAgentOptions): Promise<SubAgentResult> {
  const kind = options.agentKind ?? "explore";
  const builtin = getBuiltinSubAgent(kind) ?? BUILTIN_SUB_AGENTS[0]!;
  const maxTurns = options.maxTurns ?? builtin.maxTurns;
  const allowed = new Set(options.toolNames.filter((name) => builtin.toolNames.includes(name)));
  const tools = SUB_AGENT_TOOL_SCHEMAS.filter((tool) => allowed.has(tool.name));
  // 子代理 bash 不开后台任务（run_in_background 依赖主循环的 BackgroundTaskRegistry）；
  // 描述随会话实际 shell（执行经 executeTool 回落到主循环同一路径）
  if (allowed.has("bash")) tools.unshift(bashTool(false, options.shell ?? resolveShell("default")));
  let system = systemPrompt(kind, options.cwd, options.systemExtra);
  if (options.swarm) {
    // swarm 成员专属工具：会话内通信，不走类型允许集/权限链（本地板文件读写，失败静默降级）
    allowed.add(SWARM_BOARD_POST_TOOL.name);
    allowed.add(SWARM_BOARD_READ_TOOL.name);
    tools.push(SWARM_BOARD_POST_TOOL, SWARM_BOARD_READ_TOOL);
    system += "\n\n## Shared discussion board\n" +
      "You are one member of a parallel swarm working on sibling subtasks. Members share a discussion board: " +
      "use swarm_board_read at the start to see what others have already found, swarm_board_post to share key findings or questions as you reach them, " +
      "and swarm_board_read once more before finishing to fold in anything new. Keep posts short and factual.";
  }

  const taskId = options.taskId ?? randomUUID();
  // 发帖署名缺省回落 taskId（taskId 生成后才能确定）
  if (options.swarm && !options.swarm.member) options.swarm.member = taskId;
  const startedAt = new Date().toISOString();
  await options.onStart?.(taskId);
  const messages: ChatMessage[] = [subMessage("user", [{ type: "text", text: options.prompt }])];
  const toolsUsed: string[] = [];
  let turns = 0;
  let conclusion = "";
  try {
    let finished = false;
    let lastText = "";
    for (let turn = 0; turn < maxTurns; turn++) {
      options.signal.throwIfAborted();
      const result = await collectProviderTurn(options.provider, {
        model: options.modelOverride ?? options.model,
        system,
        messages,
        tools,
        signal: options.signal,
        ...(options.reasoningContent !== undefined ? { reasoningContent: options.reasoningContent } : {}),
        ...(options.serverWebSearch !== undefined ? { serverWebSearch: options.serverWebSearch } : {}),
      });
      turns += 1;
      const assistantContent: MessageContent[] = [];
      let text = "";
      let stopReason: string | undefined;
      // 当前流式 thinking 块索引（thinking_delta 分片合并；thinking_end 收尾成块）：
      // 与主循环一致，thinking 块带 provider 字段落盘，供 OpenAI 兼容接口的思维链回传
      // （DeepSeek 思维模式强制每个 function_call 前带 reasoning item，缺素材会 400）。
      let activeThinkingIndex: number | undefined;
      for (const event of result.events) {
        if (event.type === "text_delta") {
          text += event.text;
          // 与主循环一致：相邻 text_delta 属于同一段正文，合并进末尾 text block，
          // 避免转录落盘时一条 assistant 消息携带数千个碎片 block。
          const previous = assistantContent.at(-1);
          if (previous?.type === "text") previous.text = `${previous.text ?? ""}${event.text}`;
          else assistantContent.push({ type: "text", text: event.text });
        } else if (event.type === "thinking_delta") {
          const activeThinking = activeThinkingIndex === undefined ? undefined : assistantContent[activeThinkingIndex];
          if (activeThinking?.type === "thinking") {
            activeThinking.text = `${activeThinking.text ?? ""}${event.text}`;
          } else {
            assistantContent.push({ type: "thinking", text: event.text, provider: options.provider.name });
            activeThinkingIndex = assistantContent.length - 1;
          }
        } else if (event.type === "thinking_end") {
          const completedThinking: MessageContent = {
            type: "thinking",
            text: event.text,
            ...(event.signature ? { signature: event.signature } : {}),
            ...(event.redacted ? { redacted: event.redacted } : {}),
            provider: options.provider.name,
          };
          if (activeThinkingIndex === undefined) assistantContent.push(completedThinking);
          else assistantContent[activeThinkingIndex] = completedThinking;
          activeThinkingIndex = undefined;
        } else if (event.type === "tool_call") {
          assistantContent.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
        } else if (event.type === "usage") {
          await options.onUsage?.(event);
        } else if (event.type === "done") {
          stopReason = event.stopReason;
        }
      }
      if (assistantContent.length > 0) messages.push(subMessage("assistant", assistantContent));
      lastText = text || lastText;
      options.onProgress?.({ turns, toolsUsed: [...toolsUsed] });
      if (stopReason !== "tool_use") {
        finished = true;
        break;
      }
      const toolCalls = assistantContent.filter((block) => block.type === "tool_call");
      if (toolCalls.length === 0) {
        finished = true;
        break;
      }
      const results: MessageContent[] = [];
      for (const call of toolCalls) {
        if (call.type !== "tool_call") continue;
        const outcome = await executeSubTool(options, allowed, call.name, call.input, call.id);
        if (!outcome.isError && !toolsUsed.includes(call.name)) toolsUsed.push(call.name);
        results.push({ type: "tool_result", toolCallId: call.id, content: outcome.content, isError: outcome.isError });
      }
      messages.push(subMessage("tool", results));
      options.onProgress?.({ turns, toolsUsed: [...toolsUsed] });
    }
    conclusion = finished
      ? lastText
      : lastText
        ? `${lastText}\n[reached max turns (${maxTurns}); partial answer]`
        : `[reached max turns (${maxTurns}) without a final answer]`;
    conclusion = truncateConclusion(conclusion);
    return { taskId, conclusion, turns, toolsUsed };
  } finally {
    // 转录存档：失败只 warn，不影响结论返回
    try {
      await mkdir(path.join(options.contextRoot, "subagents"), { recursive: true });
      await writeFile(
        path.join(options.contextRoot, "subagents", `${taskId}.json`),
        `${JSON.stringify({ id: taskId, prompt: options.prompt, ...(options.agent ? { agent: options.agent } : {}), startedAt, turns, toolsUsed, conclusion, messages }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      process.stderr.write(`[sub-agent] 转录写入失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function executeSubTool(
  options: SubAgentOptions,
  allowed: ReadonlySet<string>,
  name: string,
  input: Record<string, unknown>,
  toolCallId: string,
): Promise<{ content: string; isError: boolean }> {
  if (!allowed.has(name)) {
    const list = [...allowed].join(", ") || "(none)";
    return { content: `Tool not available to this sub-agent: ${name}. Allowed tools: ${list}`, isError: true };
  }
  // swarm 讨论板：本地板文件读写，不经权限链；读写失败静默降级为提示文本，不拖垮子代理
  if (name === "swarm_board_post" || name === "swarm_board_read") {
    const swarm = options.swarm;
    if (!swarm) return { content: `${name} is only available to swarm members`, isError: true };
    if (name === "swarm_board_post") {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return { content: "swarm_board_post requires a non-empty text", isError: true };
      const ok = await appendSwarmBoard(swarm.boardPath, swarm.member ?? "unknown", text);
      return { content: ok ? "ok" : "ok (board unavailable; post dropped)", isError: false };
    }
    const since = input.since === undefined ? 0 : Number(input.since);
    const board = await readSwarmBoard(swarm.boardPath, Number.isInteger(since) && since > 0 ? since : 0);
    if (board.entries.length === 0) {
      return { content: board.total === 0 ? "(board is empty)" : `(no new entries; offset=${board.offset})`, isError: false };
    }
    const lines = board.entries.map((entry) => `[${entry.ts}] ${entry.from}: ${entry.text}`);
    return { content: `${lines.join("\n")}\n(offset=${board.offset}, total=${board.total})`, isError: false };
  }
  // general 类型：全部工具（含只读）统一经调用方注入的权限链执行入口
  if (options.executeTool) {
    try {
      return await options.executeTool({ name, input, toolCallId });
    } catch (error) {
      if (options.signal.aborted) throw error;
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
  try {
    let raw: string;
    if (name === "read_artifact") {
      const manager = new ContextManager(options.contextRoot);
      raw = await manager.readArtifact(String(input.artifactId), Number(input.offset), Number(input.limit));
    } else {
      // 与主循环 callCoreFileTool 同规则：glob/grep 的 path 缺省会话根
      const targetPath = typeof input.path === "string" && input.path ? input.path : (name === "glob" || name === "grep" ? "." : "");
      if (!targetPath) throw new Error(`${name} requires a non-empty path`);
      let value: unknown;
      if (name === "read_file") {
        value = await options.core.readFile({
          sessionId: options.sessionId,
          path: targetPath,
          ...(input.offset === undefined ? {} : { offset: Number(input.offset) }),
          ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
        });
      } else if (name === "glob") {
        value = await options.core.globFiles({ sessionId: options.sessionId, path: targetPath, pattern: String(input.pattern ?? "") });
      } else {
        value = await options.core.grepFiles({ sessionId: options.sessionId, path: targetPath, pattern: String(input.pattern ?? "") });
      }
      raw = JSON.stringify(value);
    }
    const bounded = await boundToolResult(options.contextRoot, name, raw);
    return { content: bounded.content, isError: false };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function truncateConclusion(text: string): string {
  if (text.length <= SUB_AGENT_CONCLUSION_LIMIT) return text;
  return `${text.slice(0, SUB_AGENT_CONCLUSION_LIMIT)}…(truncated)`;
}

function subMessage(role: MessageRole, content: MessageContent[]): ChatMessage {
  return { id: randomUUID(), role, content, createdAt: new Date().toISOString() };
}
