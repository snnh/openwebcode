export type ModelModality = "text" | "image" | "video";

export interface ModelCapabilities {
  /** Input modalities accepted by the model. */
  modalities: ModelModality[];
  /** Whether the model can return image content. */
  imageOutput: boolean;
  thinking: Array<"adaptive" | "enabled" | "disabled">;
  effort: Array<"minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra">;
  tools: boolean;
  /** 思维链回传（reasoning_content）；默认按模型族：gpt/claude 关闭，其余开启。 */
  reasoningContent?: boolean;
  /** 官方 OpenAI Responses 加密思维链回放（include:["reasoning.encrypted_content"] + rs_/fc_ id 原样回放）；
   * 默认按模型族 gpt/o 系 true、其余 false；可在模型目录 UI 手动配置。 */
  responsesEncryptedReplay?: boolean;
  /** 思考方式（模型目录 UI 可编辑）：thinking/enable_thinking/effort_only/fixed（OpenAI 兼容路径
   * 各端点的思考参数 key 形态）、extended/adaptive（Anthropic 路径）；未声明时 openai 兼容
   * 只发 effort、anthropic 按模型名推断。空串 = 保存时显式清除声明。 */
  thinkingStyle?: "thinking" | "enable_thinking" | "effort_only" | "fixed" | "extended" | "adaptive" | "";
}

export interface ModelProfile {
  id: string;
  provider: string;
  displayName?: string;
  source?: "builtin" | "api" | "synced" | "manual";
  contextWindow: number;
  capabilities: ModelCapabilities;
  pricing?: { currency: string; input: string; output: string; cacheRead: string; cacheWrite: string };
}
