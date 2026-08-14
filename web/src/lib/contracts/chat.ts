import type { ChatMessage } from "./message";

// ── Chat Mode ──

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  assistantId?: string;
  enabledTools?: string[];
  sandboxEnabled?: boolean;
  temperature?: number;
  cwd?: string;
  activeLeafId?: string;
  rootId?: string;
  share?: ChatShare;
}

/** 会话分享出站形状（passwordHash 仅落盘，服务端 publicMeta 剥离后以 hasPassword 下发） */
export interface ChatShare {
  /** 8 位十六进制 id。 */
  id: string;
  /** 仅含 [a-z0-9-]。 */
  slug: string;
  createdAt: string;
  /** 是否设置了访问口令（服务端 publicMeta 填充）。 */
  hasPassword?: boolean;
}

export interface ChatAssistant {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningLevel?: "AUTO" | "OFF" | "LOW" | "MEDIUM" | "HIGH";
  presetMessages?: { role: "user" | "assistant"; content: string }[];
  toolList?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatConfig {
  defaultProvider?: string;
  defaultModel?: string;
  defaultSystemPrompt?: string;
  defaultTemperature?: number;
  defaultAssistantId?: string;
  lanUnauthenticated?: boolean;
  pythonLibraries?: string[];
  /** image_gen 工具的生图模型（全局唯一粒度）；provider 为 provider-profiles 的模型服务商 id。 */
  imageGenModel?: { provider: string; model: string };
  /** vision 工具的图像理解模型（全局唯一粒度）。 */
  visionModel?: { provider: string; model: string };
}

/** GET /api/chat/models 条目：已启用服务商 × 模型目录；models 元素带能力声明供前端过滤。 */
export interface ChatModelEntry {
  provider: string;
  /** modalities 含 "image" = vision 候选；imageOutput === true = image_gen 候选。 */
  models: Array<{ id: string; modalities: string[]; imageOutput: boolean }>;
}

/** Chat SSE 事件（GET /api/chat/sessions/:id/stream，data: 行 JSON；对齐 server/src/app.ts chatStreamSend） */
export interface ChatStreamEvent {
  type: "connected" | "delta" | "thinking_delta" | "tool_call" | "tool_result" | "stopped" | "python_status" | "done" | "error";
  /** 本次运行的 id（connected 事件没有）。 */
  runId?: string;
  /** connected：该会话是否有运行中的消息。 */
  running?: boolean;
  /** delta / thinking_delta / tool_result：文本增量（thinking_delta 为思考过程增量）。 */
  text?: string;
  /** tool_call / tool_result：工具调用 id。 */
  id?: string;
  /** tool_call：工具名。 */
  name?: string;
  /** error：失败信息。 */
  error?: string;
  /** python_status：Python 环境准备状态。 */
  status?: "preparing" | "ready" | "error";
  /** python_status：状态细节（如错误原因）。 */
  detail?: string;
  /** done：结束原因（end_turn / max_turns / stopped）。 */
  stopReason?: string;
}

export interface ChatSessionDetail extends ChatSessionMeta {
  messages: ChatMessage[];
}
