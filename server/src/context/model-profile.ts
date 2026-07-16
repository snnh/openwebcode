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

const FALLBACK_CAPABILITIES: ModelCapabilities = {
  modalities: ["text"],
  thinking: [],
  effort: [],
  tools: false,
};
const FALLBACK: ModelProfile = {
  id: "unknown",
  provider: "unknown",
  contextWindow: 200_000,
  maxOutput: 16_000,
  capabilities: FALLBACK_CAPABILITIES,
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
  return PROFILES[model] ?? { ...FALLBACK, id: model };
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
