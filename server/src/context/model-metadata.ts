import type { ModelCapabilities } from "./model-profile.js";

export interface ModelMetadata {
  contextWindow: number;
  maxOutput: number;
  capabilities: ModelCapabilities;
}

const caps = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  modalities: ["text"],
  imageOutput: false,
  thinking: [],
  effort: [],
  tools: true,
  ...overrides,
});

// 内置元数据库：不内置 claude 条目，anthropic provider 仍可经凭据从 API 拉取；
// 未知 id 走 FALLBACK_METADATA。exact 命中优先，否则取首个匹配的 id 前缀。
const EXACT: Record<string, ModelMetadata> = {};

const PREFIXES: Array<[string, ModelMetadata]> = [
  ["gpt-4.1", { contextWindow: 1_000_000, maxOutput: 32_000, capabilities: caps({ modalities: ["text", "image"] }) }],
  ["gpt-4o", { contextWindow: 128_000, maxOutput: 16_000, capabilities: caps({ modalities: ["text", "image"] }) }],
  ["gpt-4", { contextWindow: 128_000, maxOutput: 8_000, capabilities: caps({ modalities: ["text", "image"] }) }],
  ["gpt-5", { contextWindow: 400_000, maxOutput: 128_000, capabilities: caps({ modalities: ["text", "image"], effort: ["low", "medium", "high"] }) }],
  ["o1", { contextWindow: 200_000, maxOutput: 100_000, capabilities: caps({ modalities: ["text", "image"], effort: ["low", "medium", "high"] }) }],
  ["o3", { contextWindow: 200_000, maxOutput: 100_000, capabilities: caps({ modalities: ["text", "image"], effort: ["low", "medium", "high"] }) }],
  ["o4", { contextWindow: 200_000, maxOutput: 100_000, capabilities: caps({ modalities: ["text", "image"], effort: ["low", "medium", "high"] }) }],
  ["deepseek-reasoner", { contextWindow: 64_000, maxOutput: 8_000, capabilities: caps({ thinking: ["enabled", "disabled"] }) }],
  ["deepseek", { contextWindow: 64_000, maxOutput: 8_000, capabilities: caps() }],
  ["qwen", { contextWindow: 128_000, maxOutput: 8_000, capabilities: caps({ modalities: ["text", "image"] }) }],
];

export const FALLBACK_METADATA: ModelMetadata = {
  contextWindow: 256_000,
  maxOutput: 16_000,
  capabilities: caps(),
};

export function lookupModelMetadata(id: string): ModelMetadata {
  const exact = EXACT[id];
  if (exact) return exact;
  const lower = id.toLowerCase();
  for (const [prefix, metadata] of PREFIXES) {
    if (lower.startsWith(prefix)) return metadata;
  }
  return FALLBACK_METADATA;
}
