import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ProviderRegistry, StreamChatRequest } from "../providers/provider.js";
import type { ProviderProfilesService } from "../provider-profiles.js";
import { collectProviderTurn } from "../providers/retry.js";
import { activePathMessages } from "../sessions/session-tree.js";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { SearchProvider, WebFetchProvider } from "../web-tools.js";
import type { ChatAssistantStore } from "./chat-assistant-store.js";
import type { ChatConfigService } from "./chat-config.js";
import { resolveChatImageGenProvider, resolveChatVisionProvider, resolveSessionPath } from "./chat-media.js";
import type { ChatPythonEnv } from "./chat-python-env.js";
import type { ChatPythonCoreBridge } from "./chat-python-runner.js";
import type { ChatSessionStore } from "./chat-session-store.js";
import { chatTools, type ChatToolContext } from "./chat-tools.js";
import type { ChatAssistant, ChatSessionMeta } from "./chat-types.js";

/** 用户消息图片输入（路由层校验后传入）：base64 内联或 sessionDir 相对 ref 落盘引用。 */
export interface ChatImageInput {
  mediaType: string;
  data?: string;
  ref?: string;
}

/** 会话级配置与助手预设合并后的生效配置。 */
interface EffectiveConfig {
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number | undefined;
  topP: number | undefined;
  maxTokens: number | undefined;
  thinking: "adaptive" | "enabled" | "disabled";
  effort: "low" | "medium" | "high" | undefined;
  enabledTools: string[];
  presetMessages: { role: "user" | "assistant"; content: string }[];
}

/** Python 环境准备状态（chat-tools 经 ChatToolContext.onPythonStatus 上抛）。 */
type PythonStatusCallback = (status: "preparing" | "ready" | "error", detail?: string) => void;

/**
 * 聊天执行引擎：多轮 provider 调用 + 工具调度主循环。
 * 每轮经 collectProviderTurn 流式收集事件，文本增量经 onDelta 实时上抛；
 * 工具调用在本地执行后以 tool 角色消息落盘并回填上下文，直到无工具调用或达到 maxTurns。
 */
export class ChatRunner {
  private readonly activeRuns = new Map<string, AbortController>();
  private searchProvider: SearchProvider | undefined;
  private webFetchProvider: WebFetchProvider | undefined;

  constructor(
    private readonly sessions: ChatSessionStore,
    private readonly providers: ProviderRegistry,
    private readonly pythonEnv: ChatPythonEnv,
    searchProvider: SearchProvider | undefined,
    webFetchProvider: WebFetchProvider | undefined,
    /** chat.json 现读（imageGenModel/visionModel 热生效）：media 工具 handler 调用点现构建适配器。 */
    private readonly chatConfig: ChatConfigService,
    /** provider profiles 凭据面（image_gen 的 apiKey/baseURL 来源）；缺省时 image_gen 恒未配置。 */
    private readonly providerProfiles: ProviderProfilesService | undefined,
    private readonly assistantStore: ChatAssistantStore,
    /** 最大轮次现读（共享基础模式 agentMaxTurns 设置，热生效）。 */
    private readonly maxTurns: () => number,
    /** core 桥接（CoreRouter）：Windows 上 python 工具经 job.* 在 Job Object 内运行。 */
    private readonly coreRouter?: ChatPythonCoreBridge,
  ) {
    this.searchProvider = searchProvider;
    this.webFetchProvider = webFetchProvider;
  }

  /** 联网搜索服务商热更新（provider profiles 变更时由 ProviderProfilesRuntime 同步）。 */
  setSearchProvider(searchProvider: SearchProvider | undefined): void {
    this.searchProvider = searchProvider;
  }

  /** 网页抓取服务商热更新。 */
  setWebFetchProvider(webFetchProvider: WebFetchProvider | undefined): void {
    this.webFetchProvider = webFetchProvider;
  }

  async runChatMessage(params: {
    sessionId: string;
    userMessage: string;
    images?: ChatImageInput[];
    meta: ChatSessionMeta;
    signal: AbortSignal;
    onDelta: (text: string) => void;
    /** 思考过程增量（thinking_delta）：与文本同通道实时上抛，路由层转 SSE thinking_delta。 */
    onThinkingDelta?: (text: string) => void;
    onToolCall?: (call: { id: string; name: string }) => void;
    onToolResult?: (result: { id: string; text: string }) => void;
    /** 主动停止（stopChatMessage）时回调：与 delta/tool_call 同通道，路由层据此发 stopped 事件。 */
    onStopped?: () => void;
    /** Python 环境状态（preparing/ready/error）：转发自 chat-tools，路由层据此发 python_status 事件。 */
    onPythonStatus?: PythonStatusCallback;
  }): Promise<{ assistantContent: MessageContent[]; stopReason: string }> {
    const { sessionId, userMessage, meta, signal, onDelta, onThinkingDelta, onToolCall, onToolResult, onStopped, onPythonStatus } = params;

    // 并发护栏必须在首个 await 之前同步执行：两个 await 之后才登记会让并发重复提交双双通过。
    // 路由层按 message 含 "already running" 判 409。
    if (this.activeRuns.has(sessionId)) throw new Error(`chat run already running: ${sessionId}`);
    // 外部 signal 与 stopChatMessage 的内部 abort 合并
    const abort = new AbortController();
    this.activeRuns.set(sessionId, abort);
    const combinedSignal = AbortSignal.any([signal, abort.signal]);

    // 合并助手预设得到生效配置
    const assistant = meta.assistantId ? await this.assistantStore.get(meta.assistantId) : undefined;
    const effective = this.resolveEffectiveConfig(meta, assistant);

    // 组装消息历史：助手预置消息 + 当前活动路径（根→叶）
    const allMessages = await this.sessions.getMessages(sessionId);
    const pathMessages = activePathMessages(allMessages, meta.activeLeafId);
    const messages: ChatMessage[] = [
      ...effective.presetMessages.map((pm, i) => ({
        id: `preset-${i}`,
        role: pm.role,
        content: [{ type: "text" as const, text: pm.content }],
        createdAt: new Date().toISOString(),
      })),
      ...pathMessages,
    ];

    // 本轮用户消息（HTTP 层已落盘；此处补进内存上下文）
    const userContent: MessageContent[] = [{ type: "text", text: userMessage }];
    for (const image of params.images ?? []) {
      userContent.push({
        type: "image",
        mediaType: image.mediaType,
        ...(image.data ? { data: image.data } : {}),
        ...(image.ref ? { ref: image.ref } : {}),
      });
    }
    const lastStored = messages.at(-1);
    // 空文本消息（纯图片）跳过内容级去重：图片消息的落盘形态无 text 块可比对，
    // 直接 push 保证图片进上下文（HTTP 层落盘消息与内存 messages 同源，不会重复）
    const isAlreadyStored = userMessage !== ""
      && lastStored?.role === "user"
      && lastStored.content.some((c) => c.type === "text" && c.text === userMessage);
    if (!isAlreadyStored) {
      messages.push({
        id: randomUUID(),
        role: "user",
        content: userContent,
        createdAt: new Date().toISOString(),
      });
    }

    // ref 形态图片块（>2MB 落盘图 / 生成图）内联为 base64：provider 只认 data 形态。
    // 读取失败的块保留 ref 不进 provider（provider 侧跳过缺 data 的 image 块）。
    await this.inlineImageRefs(sessionId, messages);

    // 按生效工具名单过滤出本轮暴露给模型的工具
    const toolDefs = chatTools();
    const enabledToolDefs = toolDefs.filter((t) => effective.enabledTools.includes(t.name));
    const tools = enabledToolDefs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));

    const toolCtx: ChatToolContext = {
      searchProvider: this.searchProvider,
      webFetchProvider: this.webFetchProvider,
      // media 适配器现读：chat.json 的 imageGenModel/visionModel 修改下一轮工具调用即生效
      getImageGenProvider: () => resolveChatImageGenProvider(this.chatConfig, this.providerProfiles),
      getVisionProvider: () => resolveChatVisionProvider(this.chatConfig, this.providers),
      messages,
      pythonEnv: this.pythonEnv,
      sessionDir: this.sessions.sessionDir(sessionId),
      signal: combinedSignal,
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
      ...(onPythonStatus ? { onPythonStatus } : {}),
      ...(this.coreRouter ? { core: this.coreRouter } : {}),
      sessionId,
    };

    // 当前轮已流出的文本（onEvent 累积）：abort 中断时 collected 拿不到本轮事件，
    // 靠这份累积把部分 assistant 文本按父链落盘
    let currentTurnText = "";
    const assistantContent: MessageContent[] = [];
    try {
      let stopReason = "end_turn";
      const maxTurns = this.maxTurns();
      let exhausted = true;

      for (let turn = 0; turn < maxTurns; turn++) {
        const provider = this.providers.get(effective.provider);
        if (!provider) throw new Error(`Provider not found: ${effective.provider}`);

        const request: StreamChatRequest = {
          model: effective.model,
          system: effective.systemPrompt,
          messages,
          tools,
          thinking: effective.thinking,
          ...(effective.effort !== undefined ? { effort: effective.effort } : {}),
          ...(effective.maxTokens !== undefined ? { maxTokens: effective.maxTokens } : {}),
          ...(effective.temperature !== undefined ? { temperature: effective.temperature } : {}),
          ...(effective.topP !== undefined ? { topP: effective.topP } : {}),
          signal: combinedSignal,
        };

        currentTurnText = "";
        const collected = await collectProviderTurn(provider, request, {
          maxAttempts: 3,
          onEvent: (event) => {
            if (event.type === "text_delta") {
              currentTurnText += event.text;
              onDelta(event.text);
            } else if (event.type === "thinking_delta") {
              // 思考增量实时上抛（前端流式展示）；落盘由汇总循环的 thinking 块累积负责
              onThinkingDelta?.(event.text);
            }
          },
        });

        // 汇总本轮事件：工具调用、thinking 块与停止原因（文本已由 onEvent 累积进 currentTurnText）。
        // thinking 块带 provider 字段随 assistant 消息落盘：OpenAI 兼容接口的思维链回传
        // 依赖历史中的同源 thinking 素材（DeepSeek 思维模式强制，缺素材会 400）。
        let hasToolCall = false;
        const toolCalls: { id: string; name: string; input: Record<string, unknown>; itemId?: string }[] = [];
        const assistantMsgContent: MessageContent[] = [];
        let activeThinkingIndex: number | undefined;
        for (const event of collected.events) {
          if (event.type === "thinking_delta") {
            // 与主循环一致：相邻分片合并进当前 thinking 块，避免一条消息携带数千个碎片块
            const activeThinking = activeThinkingIndex === undefined ? undefined : assistantMsgContent[activeThinkingIndex];
            if (activeThinking?.type === "thinking") {
              activeThinking.text = `${activeThinking.text ?? ""}${event.text}`;
            } else {
              assistantMsgContent.push({ type: "thinking", text: event.text, provider: provider.name });
              activeThinkingIndex = assistantMsgContent.length - 1;
            }
          } else if (event.type === "thinking_end") {
            const completedThinking: MessageContent = {
              type: "thinking",
              text: event.text,
              ...(event.signature ? { signature: event.signature } : {}),
              ...(event.redacted ? { redacted: event.redacted } : {}),
              provider: provider.name,
            };
            if (activeThinkingIndex === undefined) assistantMsgContent.push(completedThinking);
            else assistantMsgContent[activeThinkingIndex] = completedThinking;
            activeThinkingIndex = undefined;
          } else if (event.type === "tool_call") {
            hasToolCall = true;
            toolCalls.push({ id: event.id, name: event.name, input: event.input, ...(event.itemId ? { itemId: event.itemId } : {}) });
            onToolCall?.({ id: event.id, name: event.name });
          }
          if (event.type === "done") stopReason = event.stopReason;
        }

        // assistant 消息落盘并追加进内存上下文（thinking 已在汇总循环按序累积）
        if (currentTurnText) assistantMsgContent.push({ type: "text", text: currentTurnText });
        for (const tc of toolCalls) {
          assistantMsgContent.push({
            type: "tool_call",
            id: tc.id,
            ...(tc.itemId ? { itemId: tc.itemId } : {}),
            name: tc.name,
            input: tc.input,
          });
        }
        if (assistantMsgContent.length > 0) {
          const assistantMsg = await this.sessions.appendMessage(sessionId, "assistant", assistantMsgContent, {
            ...(messages.at(-1)?.id ? { parentId: messages.at(-1)!.id } : {}),
            runId: randomUUID(),
          });
          messages.push(assistantMsg);
          assistantContent.push(...assistantMsgContent);
        }

        if (!hasToolCall) {
          exhausted = false;
          break;
        }

        // 本地执行工具调用，结果以 tool 角色消息回填
        for (const tc of toolCalls) {
          const toolDef = enabledToolDefs.find((t) => t.name === tc.name);
          let resultContent: MessageContent[];
          let isError = false;

          if (!toolDef) {
            resultContent = [{ type: "text", text: `Error: tool "${tc.name}" is not enabled` }];
            isError = true;
          } else if (toolDef.requiresSandbox && !meta.sandboxEnabled) {
            resultContent = [{ type: "text", text: `Error: tool "${tc.name}" requires sandbox to be enabled` }];
            isError = true;
          } else {
            try {
              resultContent = await toolDef.handler(tc.input, toolCtx);
            } catch (error) {
              // 主动停止不能被吞成工具错误文本：上抛给外层 abort 分支统一收尾
              if (isAbortError(error)) throw error;
              resultContent = [{ type: "text", text: `Error executing ${tc.name}: ${error instanceof Error ? error.message : String(error)}` }];
              isError = true;
            }
          }

          // ToolResultContent.content 为字符串：文本块拼接，图片块以占位符表示
          const resultText = resultContent
            .map((c) => (c.type === "text" ? c.text : c.type === "image" ? `[image: ${c.mediaType}]` : ""))
            .filter((s) => s.length > 0)
            .join("\n");
          const storedContent: MessageContent[] = [{
            type: "tool_result",
            toolCallId: tc.id,
            content: resultText,
            isError,
          }];
          // 带 ref 的落盘图（image_gen 产出）随工具消息持久化：供 vision 回溯与刷新后展示；
          // python/show 的纯内联图维持现状不落盘（避免 messages.jsonl 膨胀）
          for (const block of resultContent) {
            if (block.type === "image" && block.ref) {
              storedContent.push({ type: "image", mediaType: block.mediaType, ref: block.ref });
            }
          }
          const toolResultMsg = await this.sessions.appendMessage(sessionId, "tool", storedContent, {
            ...(messages.at(-1)?.id ? { parentId: messages.at(-1)!.id } : {}),
            runId: randomUUID(),
          });
          messages.push(toolResultMsg);
          onToolResult?.({ id: tc.id, text: resultText.slice(0, 500) });
        }
      }

      // 轮次耗尽（最后一轮仍有工具调用）：以 max_turns 收尾，路由层 done 事件如实携带
      if (exhausted) stopReason = "max_turns";

      return { assistantContent, stopReason };
    } catch (error) {
      if (isAbortError(error)) {
        // stopChatMessage 主动停止：部分 assistant 文本按父链落盘，回调 stopped 事件，正常返回不再上抛
        if (currentTurnText) {
          await this.sessions.appendMessage(sessionId, "assistant", [{ type: "text", text: currentTurnText }], {
            ...(messages.at(-1)?.id ? { parentId: messages.at(-1)!.id } : {}),
            runId: randomUUID(),
          });
          assistantContent.push({ type: "text", text: currentTurnText });
        }
        onStopped?.();
        return { assistantContent, stopReason: "stopped" };
      }
      throw error;
    } finally {
      // 仅当 map 中仍是本次运行的 controller 才清除（防御并发边界下的误删）
      if (this.activeRuns.get(sessionId) === abort) this.activeRuns.delete(sessionId);
    }
  }

  stopChatMessage(sessionId: string): void {
    this.activeRuns.get(sessionId)?.abort();
  }

  /** ref 形态图片块就地内联为 base64 data（provider 只认 data）；读盘失败的块跳过（provider 侧忽略缺 data 的图）。 */
  private async inlineImageRefs(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const sessionDir = this.sessions.sessionDir(sessionId);
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type !== "image" || block.data || !block.ref) continue;
        try {
          block.data = (await readFile(resolveSessionPath(sessionDir, block.ref))).toString("base64");
        } catch {
          // 文件缺失/越界：保留 ref 形态，不进 provider 请求
        }
      }
    }
  }

  isRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  /** 会话配置与助手预设合并：助手字段优先，toolList 对会话启用名单做交集过滤。 */
  private resolveEffectiveConfig(meta: ChatSessionMeta, assistant: ChatAssistant | undefined): EffectiveConfig {
    if (!assistant) {
      return {
        systemPrompt: meta.systemPrompt ?? "",
        provider: meta.provider,
        model: meta.model,
        temperature: meta.temperature,
        topP: undefined,
        maxTokens: undefined,
        thinking: "adaptive",
        effort: undefined,
        enabledTools: meta.enabledTools ?? [],
        presetMessages: [],
      };
    }
    const level = assistant.reasoningLevel ?? "AUTO";
    const thinking = level === "AUTO" ? "adaptive" as const : level === "OFF" ? "disabled" as const : "enabled" as const;
    const effort = level === "LOW" ? "low" as const : level === "MEDIUM" ? "medium" as const : level === "HIGH" ? "high" as const : undefined;
    const enabledTools = assistant.toolList
      ? (meta.enabledTools ?? []).filter((t) => assistant.toolList!.includes(t))
      : (meta.enabledTools ?? []);
    return {
      systemPrompt: assistant.systemPrompt || meta.systemPrompt || "",
      provider: assistant.provider ?? meta.provider,
      model: assistant.model ?? meta.model,
      temperature: assistant.temperature ?? meta.temperature,
      topP: assistant.topP,
      maxTokens: assistant.maxTokens,
      thinking,
      effort,
      enabledTools,
      presetMessages: assistant.presetMessages ?? [],
    };
  }
}

/** AbortError 判定：DOMException（signal.reason）与 Error 子类统一按 name 识别。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
