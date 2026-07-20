import { lookupModelMetadata } from "./model-metadata.js";
const PROFILES = {};
export function listModelProfiles() {
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
export function getModelProfile(model) {
    const exact = PROFILES[model];
    if (exact)
        return exact;
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
export function estimateTokens(value) {
    return Math.max(1, Math.ceil(value.length / 4));
}
/** 图片按固定定额计入水位估算（典型 ~1.2k tokens/张），而非 base64 长度。 */
export const IMAGE_TOKEN_ESTIMATE = 1200;
export function estimateMessageTokens(messages) {
    let total = 0;
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "image")
                total += IMAGE_TOKEN_ESTIMATE;
            else if (block.type === "tool_call")
                total += estimateTokens(JSON.stringify(block.input)) + 8;
            else if (block.type === "tool_result")
                total += estimateTokens(block.content);
            else if (block.type === "text" || block.type === "thinking")
                total += estimateTokens(block.text);
        }
        total += 4;
    }
    return Math.max(1, total);
}
