import type { ChatMessage } from "../sessions/types.js";
import { lookupModelMetadata } from "./model-metadata.js";

export type Currency = "USD" | "CNY";
export type ModelModality = "text" | "image";
export type ThinkingMode = "adaptive" | "enabled" | "disabled";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Prices are integer micro-units of the source currency per million tokens. */
export interface ModelPricing {
  currency: Currency;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
}

export interface ModelCapabilities {
  modalities: readonly ModelModality[];
  thinking: readonly ThinkingMode[];
  effort: readonly EffortLevel[];
  tools: boolean;
}

export interface ModelProfile {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: ModelCapabilities;
}

const PROFILES: Record<string, ModelProfile> = {
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    capabilities: {
      modalities: ["text", "image"],
      thinking: ["adaptive", "disabled"],
      effort: ["low", "medium", "high", "xhigh", "max"],
      tools: true,
    },
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    capabilities: {
      modalities: ["text", "image"],
      thinking: ["adaptive", "disabled"],
      effort: ["low", "medium", "high", "xhigh", "max"],
      tools: true,
    },
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 64_000,
    capabilities: {
      modalities: ["text", "image"],
      thinking: ["enabled", "disabled"],
      effort: [],
      tools: true,
    },
  },
};

export function listModelProfiles(): ModelProfile[] {
  return Object.values(PROFILES).map((profile) => ({
    ...profile,
    capabilities: {
      ...profile.capabilities,
      modalities: [...profile.capabilities.modalities],
      thinking: [...profile.capabilities.thinking],
      effort: [...profile.capabilities.effort],
    },
  }));
}

export function getModelProfile(model: string): ModelProfile {
  const exact = PROFILES[model];
  if (exact) return exact;
  // PROFILES 未命中时回退到元数据库（覆盖 deepseek/qwen 等非 Claude 模型），
  // 复用其 contextWindow/maxOutput/capabilities，避免两套系统默认值不一致。
  const metadata = lookupModelMetadata(model);
  return {
    id: model,
    provider: "unknown",
    contextWindow: metadata.contextWindow,
    maxOutput: metadata.maxOutput,
    capabilities: metadata.capabilities,
  };
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/** 图片按固定定额计入水位估算（典型 ~1.2k tokens/张），而非 base64 长度。 */
export const IMAGE_TOKEN_ESTIMATE = 1200;

export function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "image") total += IMAGE_TOKEN_ESTIMATE;
      else if (block.type === "tool_call") total += estimateTokens(JSON.stringify(block.input)) + 8;
      else if (block.type === "tool_result") total += estimateTokens(block.content);
      else if (block.type === "text" || block.type === "thinking") total += estimateTokens(block.text);
    }
    total += 4;
  }
  return Math.max(1, total);
}
