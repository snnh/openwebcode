/** 聊天会话元数据（<dataDir>/chat-sessions/<id>/meta.json）。 */
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  assistantId?: string;
  /** 单独开关的工具名单（缺省 []）。 */
  enabledTools?: string[];
  /** sandbox 类工具的整体开关。 */
  sandboxEnabled?: boolean;
  temperature?: number;
  cwd?: string;
  activeLeafId?: string;
  rootId?: string;
  share?: ChatShare;
}

/** 聊天助手预设（<dataDir>/chat-assistants.json）。 */
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

/** 聊天工具分类。 */
export type ChatToolCategory = "utility" | "web" | "media" | "sandbox";

/** 会话分享链接元数据。 */
export interface ChatShare {
  /** 8 位十六进制 id。 */
  id: string;
  slug: string;
  /** 访问口令的 SHA-256 十六进制摘要（仅落盘；出站响应一律剥离，见 app.ts publicMeta）。 */
  passwordHash?: string;
  /** 出站序列化专用：是否设置了访问口令（由 publicMeta 填充，不落盘）。 */
  hasPassword?: boolean;
  createdAt: string;
}

/** 聊天模式全局配置（<dataDir>/chat.json）。 */
export interface ChatConfig {
  defaultProvider?: string;
  defaultModel?: string;
  defaultSystemPrompt?: string;
  defaultTemperature?: number;
  defaultAssistantId?: string;
  /** 局域网免认证（缺省 true）。 */
  lanUnauthenticated?: boolean;
  pythonLibraries?: string[];
  /** image_gen 工具的生图模型（全局唯一粒度）；provider 为 provider-profiles 的模型服务商 id。 */
  imageGenModel?: { provider: string; model: string };
  /** vision 工具的图像理解模型（全局唯一粒度）；缺省时 vision 返回 not configured。 */
  visionModel?: { provider: string; model: string };
}
