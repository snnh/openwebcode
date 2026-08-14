export type ModelModality = "text" | "image" | "video";

export interface ModelCapabilities {
  /** Input modalities accepted by the model. */
  modalities: ModelModality[];
  /** Whether the model can return image content. */
  imageOutput: boolean;
  thinking: Array<"adaptive" | "enabled" | "disabled">;
  effort: Array<"low" | "medium" | "high" | "xhigh" | "max" | "ultra">;
  tools: boolean;
  /** 思维链回传（reasoning_content）；缺省按模型族：gpt/claude 关闭，其余开启。 */
  reasoningContent?: boolean;
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
