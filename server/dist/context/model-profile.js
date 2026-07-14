const PROFILES = {
    "claude-opus-4-8": { id: "claude-opus-4-8", contextWindow: 1_000_000, maxOutput: 128_000 },
    "claude-sonnet-5": { id: "claude-sonnet-5", contextWindow: 1_000_000, maxOutput: 128_000 },
    "claude-haiku-4-5": { id: "claude-haiku-4-5", contextWindow: 200_000, maxOutput: 64_000 },
};
const FALLBACK = { id: "unknown", contextWindow: 200_000, maxOutput: 16_000 };
export function getModelProfile(model) {
    return PROFILES[model] ?? { ...FALLBACK, id: model };
}
export function estimateTokens(value) {
    return Math.max(1, Math.ceil(value.length / 4));
}
