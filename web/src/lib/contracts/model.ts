export type ModelModality = "text" | "image" | "video";

export interface ModelCapabilities {
  /** Input modalities accepted by the model. */
  modalities: ModelModality[];
  /** Whether the model can return image content. */
  imageOutput: boolean;
  thinking: Array<"adaptive" | "enabled" | "disabled">;
  effort: Array<"minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra">;
  tools: boolean;
  /** 思维链回传（reasoning_content）；缺省按模型族：gpt/claude 关闭，其余开启。 */
  reasoningContent?: boolean;
  /** 官方 OpenAI Responses 加密思维链回放（include:["reasoning.encrypted_content"] + rs_/fc_ id 原样回放）；
   * 缺省按模型族 gpt/o 系 true、其余 false；可在模型目录 UI 手动配置。 */
  responsesEncryptedReplay?: boolean;
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
