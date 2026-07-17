const PROFILES = {
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
const FALLBACK_CAPABILITIES = {
    modalities: ["text"],
    thinking: [],
    effort: [],
    tools: false,
};
const FALLBACK = {
    id: "unknown",
    provider: "unknown",
    contextWindow: 200_000,
    maxOutput: 16_000,
    capabilities: FALLBACK_CAPABILITIES,
};
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
    return PROFILES[model] ?? { ...FALLBACK, id: model };
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
