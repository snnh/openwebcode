import type { ChatMessage } from "../sessions/types.js";
import { lookupModelMetadata } from "./model-metadata.js";

export type Currency = "USD" | "CNY";
export type ModelModality = "text" | "image" | "video";
export type ThinkingMode = "adaptive" | "enabled" | "disabled";
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** 思考方式声明（模型目录可编辑；内置按已知模型族设默认）：
 * - thinking：发 thinking:{type:enabled/disabled} 开关（deepseek/glm/kimi-k2.6）
 * - enable_thinking：发顶层 enable_thinking:true/false（qwen）
 * - effort_only：只发 reasoning_effort，无开关表达（kimi-k3、gpt/o 系）
 * - fixed：思考恒开不可关，用户显式选择时仍尝试发送（kimi-for-coding、glm-5.3）
 * - extended：Anthropic thinking:{type:"enabled",budget_tokens}（claude 4.5 及以前）
 * - adaptive：Anthropic thinking:{type:"adaptive"}，effort 控制深度（claude 4.6+、国产 anthropic）
 * 未声明：openai 兼容路径只发 effort（不建思考开关）；anthropic 路径按模型名推断。 */
export type ThinkingStyle = "thinking" | "enable_thinking" | "effort_only" | "fixed" | "extended" | "adaptive";

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
  /** Whether the model can generate an image response. Image input is declared in modalities. */
  imageOutput: boolean;
  thinking: readonly ThinkingMode[];
  effort: readonly EffortLevel[];
  tools: boolean;
  /** 思维链回传：历史 thinking 块以 reasoning_content 回带（仅 OpenAI 兼容接口生效；
   * Anthropic 走签名回放，不受此开关影响）。缺省按模型族：gpt/claude 关闭，其余开启。 */
  reasoningContent?: boolean;
  /** 官方 OpenAI Responses 加密思维链回放（include:["reasoning.encrypted_content"] +
   * rs_/fc_ id 原样回放）；缺省按模型族 gpt/o 系 true、其余 false；可在模型目录 UI 手动配置。 */
  responsesEncryptedReplay?: boolean;
  /** 思考方式（见 ThinkingStyle 注释）；未声明时 openai 兼容路径只发 effort、
   * anthropic 路径按模型名推断（claude 4.6+ / 国产 = adaptive，claude 4.5 及以前 = extended）。 */
  thinkingStyle?: ThinkingStyle;
}

export interface ModelProfile {
  id: string;
  provider: string;
  contextWindow: number;
  capabilities: ModelCapabilities;
}

const PROFILES: Record<string, ModelProfile> = {};

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
  // 复用其 contextWindow/capabilities，避免两套系统默认值不一致。
  const metadata = lookupModelMetadata(model);
  return {
    id: model,
    provider: "unknown",
    contextWindow: metadata.contextWindow,
    capabilities: metadata.capabilities,
  };
}

export function estimateTokens(value: string): number {
  // ASCII 约 4 字符/token；非 ASCII（CJK 等）实际约 1~1.5 字符/token，
  // 统一按 4 字符/token 会把中文会话低估 3-4 倍（85% 强制压缩不触发 → context-length 400）。
  // 索引扫描替代 for...of 迭代器（大文本块上的主要开销）；浮点加的顺序与原实现逐码点
  // 完全一致，折算结果逐位相同（一次性统计再折算会因累加舍入差异在 Math.ceil 边界偏移）。
  // surrogate pair 按码点计一次（for...of 语义）：高位代理后紧随低位代理时跳过低位代理。
  let units = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      units += 1 / 1.5;
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) index += 1;
      }
    } else {
      units += 1 / 4;
    }
  }
  return Math.max(1, Math.ceil(units));
}

/** 图片按固定定额计入水位估算（典型 ~1.2k tokens/张），而非 base64 长度。 */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * 媒体块（顶层 image/video 块或 tool_result.media 内嵌项）的水位估算：
 * 图片按固定定额；视频各端点按帧率/时长计费差异巨大，按 ~1 token / KB 原始字节
 * （base64 长度 ×3/4 还原）给一个保守量级，下限 256（短视频帧抽取也有基础开销）。
 */
export function estimateMediaTokens(media: { type: "image" | "video"; data?: string }): number {
  if (media.type === "image") return IMAGE_TOKEN_ESTIMATE;
  return Math.max(256, Math.ceil(((media.data?.length ?? 0) * 3) / 4 / 1024));
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "image" || block.type === "video") total += estimateMediaTokens(block);
      else if (block.type === "tool_call") total += estimateTokens(JSON.stringify(block.input)) + 8;
      else if (block.type === "tool_result") {
        total += estimateTokens(block.content);
        // 附带媒体（read_media）与顶层媒体块同口径计入水位
        for (const media of block.media ?? []) total += estimateMediaTokens(media);
      }
      else if (block.type === "text" || block.type === "thinking") total += estimateTokens(block.text);
      // web_search_call：仅回放元数据（服务端原始 item），按小定额计入水位
      else if (block.type === "web_search_call") total += estimateTokens(block.signature);
    }
    total += 4;
  }
  return Math.max(1, total);
}
