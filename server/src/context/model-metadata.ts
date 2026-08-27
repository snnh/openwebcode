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
  // 思维链回传缺省开启（deepseek/qwen/glm/kimi 等国内模型默认打开，官方文档要求带 tools
  // 请求必须完整回传 reasoning_content）；gpt/o 系与 claude 前缀条目显式关闭
  // （OpenAI 官方走加密回放，Claude 走 Anthropic 签名回放）。
  reasoningContent: true,
  // 官方 OpenAI Responses 加密思维链回放：缺省关闭（UI 模型目录可手动开启）。
  responsesEncryptedReplay: false,
  ...overrides,
});

// 内置元数据库：不内置 claude 条目，anthropic provider 仍可经凭据从 API 拉取；
// 未知 id 走 FALLBACK_METADATA。exact 命中优先，否则取首个匹配的 id 前缀。
const EXACT: Record<string, ModelMetadata> = {};

const PREFIXES: Array<[string, ModelMetadata]> = [
  // claude：Anthropic 路径思考形态按模型名推断（4.6+ adaptive / 4.5 及以前 extended）；
  // 思考强度官方枚举 low/medium/high/xhigh/max（ultra/minimal 不在此端点枚举，值不设限原样透传）
  ["claude", { contextWindow: 256_000, capabilities: caps({ reasoningContent: false, effort: ["low", "medium", "high", "xhigh", "max"] }) }],
  // gpt/o 系：官方 OpenAI 走加密回放（responsesEncryptedReplay）需在模型目录手动开启，
  // 默认关闭（用户明确要求「加密默认关闭」）；reasoningContent 关闭（官方 OpenAI 用
  // encrypted_content 机制，纯文本 reasoning_content 回带不适用）。思考方式 effort_only
  // （官方 OpenAI 无 thinking 开关，用 reasoning_effort 调节；gpt-4.1/4o/4 旧模型不启思考）。
  ["gpt-4.1", { contextWindow: 1_000_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, thinkingStyle: "effort_only" }) }],
  ["gpt-4o", { contextWindow: 128_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, thinkingStyle: "effort_only" }) }],
  ["gpt-4", { contextWindow: 128_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, thinkingStyle: "effort_only" }) }],
  ["gpt-5", { contextWindow: 400_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, effort: ["minimal", "low", "medium", "high"], thinkingStyle: "effort_only" }) }],
  ["o1", { contextWindow: 200_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, effort: ["low", "medium", "high"], thinkingStyle: "effort_only" }) }],
  ["o3", { contextWindow: 200_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, effort: ["low", "medium", "high"], thinkingStyle: "effort_only" }) }],
  ["o4", { contextWindow: 200_000, capabilities: caps({ modalities: ["text", "image"], reasoningContent: false, effort: ["low", "medium", "high"], thinkingStyle: "effort_only" }) }],
  // deepseek 官方（api-docs.deepseek.com）：deepseek-chat / deepseek-reasoner 上下文 128K；
  // deepseek-v4 系列（deepseek-v4-flash/pro，当前主推）官方 1M。
  ["deepseek-reasoner", { contextWindow: 128_000, capabilities: caps({ thinking: ["enabled", "disabled"], thinkingStyle: "thinking" }) }],
  // DeepSeek：thinking:{type} 开关 + reasoning_effort（官方映射 medium/xhigh→high）；
  // anthropic 路径为 adaptive 形态（预算废弃时代，effort 调节强度）；值不设限原样透传
  ["deepseek", { contextWindow: 1_000_000, capabilities: caps({ thinking: ["enabled", "disabled"], effort: ["low", "medium", "high", "xhigh", "max"], thinkingStyle: "thinking" }) }],
  // glm：glm-5.x 官方 1M 上下文；thinking:{type} 开关（glm-5.3 强制思考=fixed）；
  // effort 含 ultra（官方 ultracode=ultra 档）；[1m] 后缀亦识别为 1M
  ["glm-5.3", { contextWindow: 1_000_000, capabilities: caps({ thinking: ["enabled", "disabled"], effort: ["low", "medium", "high", "xhigh", "max", "ultra"], thinkingStyle: "fixed" }) }],
  ["glm-5", { contextWindow: 1_000_000, capabilities: caps({ thinking: ["enabled", "disabled"], effort: ["low", "medium", "high", "xhigh", "max", "ultra"], thinkingStyle: "thinking" }) }],
  ["glm", { contextWindow: 256_000, capabilities: caps({ thinking: ["enabled", "disabled"], effort: ["low", "medium", "high", "xhigh", "max", "ultra"], thinkingStyle: "thinking" }) }],
  // kimi：k3 始终推理只认 reasoning_effort（low/high/max）；kimi-for-coding（K2.7-code）
  // 强制保留式思考、传 thinking 参数报错=fixed；其余（k2.6 等）thinking:{type} 开关。
  // 官方上下文：k2.5/k2.6/k2.7-code = 256K；k3 = 1M。
  ["kimi-for-coding", { contextWindow: 256_000, capabilities: caps({ thinkingStyle: "fixed" }) }],
  ["kimi-k3", { contextWindow: 1_000_000, capabilities: caps({ effort: ["low", "high", "max"], thinkingStyle: "effort_only" }) }],
  ["kimi", { contextWindow: 256_000, capabilities: caps({ thinking: ["enabled", "disabled"], thinkingStyle: "thinking" }) }],
  // qwen：顶层 enable_thinking 开关（阿里云 OpenAI 兼容）；effort 档位随模型（qwen3.8-max
  // 为 low/medium/xhigh 体系），按已知集合并集声明，值不设限原样透传
  ["qwen", { contextWindow: 256_000, capabilities: caps({ modalities: ["text", "image"], thinking: ["enabled", "disabled"], effort: ["low", "medium", "high", "xhigh", "max"], thinkingStyle: "enable_thinking" }) }],
  // gemini：3.x 系列官方 1M 上下文（含 gemini-3.7-flash）；多模态输入；思考 level 经
  // thinkingStyle 未声明处理（OpenAI 兼容层参数各异，只发 effort 由端点决定）
  ["gemini", { contextWindow: 1_000_000, capabilities: caps({ modalities: ["text", "image", "video"], effort: ["minimal", "low", "medium", "high"] }) }],
];

export const FALLBACK_METADATA: ModelMetadata = {
  // 未知模型的保守兜底：256K 是当前主流中端窗口（用户明确「默认 256K」）；
  // 支持 1M 的模型族（deepseek-v4/k3/glm-5/gemini-3/gpt-4.1 等）在 PREFIXES 显式声明 1M。
  contextWindow: 256_000,
  capabilities: caps(),
};

/** 已知支持 1M 上下的模型识别：GLM 官方以 [1m] 后缀标记 1M 语境（glm-5.2[1m] 等）。 */
function isMillionContextModel(id: string): boolean {
  return /\[1m\]/i.test(id);
}

/** 模型名含 vision 标记（deepseek-v4-flash-vision-exp、qwen-vl-max、qwen2.5-vl 等）→ 默认声明图片
 * 输入能力；用户模型目录显式声明仍优先（manual 层覆盖）。 */
function withVisionIfNamed(metadata: ModelMetadata, id: string): ModelMetadata {
  // vl 需为独立词段：前接 -/_，后接 -/_ 或结尾（原 (?<![a-z0-9-])vl$ 因前面必然是 - 而永不命中 qwen-vl）
  if (!/vision|[-_]vl([-_]|$)/i.test(id)) return metadata;
  if (metadata.capabilities.modalities.includes("image")) return metadata;
  return {
    ...metadata,
    capabilities: { ...metadata.capabilities, modalities: ["text", "image", ...metadata.capabilities.modalities.filter((m) => m !== "text")] },
  };
}

export function lookupModelMetadata(id: string): ModelMetadata {
  const exact = EXACT[id];
  if (exact) return withVisionIfNamed(exact, id);
  // 供应商命名空间（openai/gpt-5、anthropic/claude-…）剥掉后再匹配前缀，
  // 使带前缀目录条目（如 gpt/claude 的 reasoningContent:false）对网关形态 id 同样生效。
  const lower = id.toLowerCase();
  const basename = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  for (const [prefix, metadata] of PREFIXES) {
    if (lower.startsWith(prefix) || basename.startsWith(prefix)) {
      // GLM [1m] 后缀：1M 上下文覆盖基础窗口（仅 glm 家族使用该标记）
      if (metadata.contextWindow < 1_000_000 && /glm/.test(prefix) && isMillionContextModel(lower)) {
        return withVisionIfNamed({ ...metadata, contextWindow: 1_000_000 }, id);
      }
      return withVisionIfNamed(metadata, id);
    }
  }
  return withVisionIfNamed(FALLBACK_METADATA, id);
}
