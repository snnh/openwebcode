import type { ModelCapabilities } from "./model-profile.js";

export interface ModelMetadata {
  contextWindow: number;
  capabilities: ModelCapabilities;
}

const caps = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  modalities: ["text"],
  imageOutput: false,
  thinking: [],
  effort: [],
  tools: true,
  // 思维链回传缺省开启（deepseek/qwen/glm/kimi 等新模型要求）；
  // gpt/o 系与 claude 前缀条目显式关闭（OpenAI 不识别该字段，Claude 走 Anthropic 签名回放）。
  reasoningContent: true,
  // 官方 OpenAI Responses 加密思维链回放：缺省关闭，仅 gpt/o 系前缀条目显式开启。
  responsesEncryptedReplay: false,
  ...overrides,
});

// 内置元数据库：不内置 claude 条目，anthropic provider 仍可经凭据从 API 拉取；
// 未知 id 走 FALLBACK_METADATA。exact 命中优先，否则取首个匹配的 id 前缀。
const EXACT: Record<string, ModelMetadata> = {};

const PREFIXES: Array<[string, ModelMetadata]> = [
  ["claude", { contextWindow: 256_000, capabilities: caps({ reasoningContent: false }) }],
  ["gpt-4.1", { contextWindow: 1_000_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, responsesEncryptedReplay: true }) }],
  ["gpt-4o", { contextWindow: 128_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, responsesEncryptedReplay: true }) }],
  ["gpt-4", { contextWindow: 128_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, responsesEncryptedReplay: true }) }],
  ["gpt-5", { contextWindow: 400_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, responsesEncryptedReplay: true, effort: ["low", "medium", "high"] }) }],
  ["o1", { contextWindow: 200_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, responsesEncryptedReplay: true, effort: ["low", "medium", "high"] }) }],
  ["o3", { contextWindow: 200_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, responsesEncryptedReplay: true, effort: ["low", "medium", "high"] }) }],
  ["o4", { contextWindow: 200_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, responsesEncryptedReplay: true, effort: ["low", "medium", "high"] }) }],
  // deepseek 官方文档（api-docs.deepseek.com）：deepseek-chat / deepseek-reasoner 上下文均为 128K，
  // 旧值 1M 与实际不符，会把 85% 压缩水位推过真实窗口
  ["deepseek-reasoner", { contextWindow: 128_000, capabilities: caps({ thinking: ["enabled", "disabled"] }) }],
  ["deepseek", { contextWindow: 128_000, capabilities: caps() }],
  ["qwen", { contextWindow: 128_000, capabilities: caps({ modalities: ["text", "image"] }) }],
];

export const FALLBACK_METADATA: ModelMetadata = {
  // 未知模型的保守兜底：128K 是当前主流中端窗口；旧值 256K 过于乐观，
  // 会让小窗口模型在真实上限前不触发压缩（宁早压缩不丢上下文）
  contextWindow: 128_000,
  capabilities: caps(),
};

export function lookupModelMetadata(id: string): ModelMetadata {
  const exact = EXACT[id];
  if (exact) return exact;
  // 供应商命名空间（openai/gpt-5、anthropic/claude-…）剥掉后再匹配前缀，
  // 使带前缀目录条目（如 gpt/claude 的 reasoningContent:false）对网关形态 id 同样生效。
  const lower = id.toLowerCase();
  const basename = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  for (const [prefix, metadata] of PREFIXES) {
    if (lower.startsWith(prefix) || basename.startsWith(prefix)) return metadata;
  }
  return FALLBACK_METADATA;
}
