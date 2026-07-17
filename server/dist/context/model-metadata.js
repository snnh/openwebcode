const caps = (overrides = {}) => ({
    modalities: ["text"],
    thinking: [],
    effort: [],
    tools: true,
    ...overrides,
});
const CLAUDE_FLAGS = { modalities: ["text", "image"], thinking: ["adaptive", "disabled"], effort: ["low", "medium", "high", "xhigh", "max"] };
// 内置元数据库：保守文档值，仅作刷新目录时的成档依据；未知 id 走 FALLBACK_METADATA。
// exact 命中优先，否则取首个匹配的 id 前缀。
const EXACT = {
    "claude-opus-4-8": { contextWindow: 1_000_000, maxOutput: 128_000, capabilities: caps({ ...CLAUDE_FLAGS }) },
    "claude-sonnet-5": { contextWindow: 1_000_000, maxOutput: 128_000, capabilities: caps({ ...CLAUDE_FLAGS }) },
    "claude-haiku-4-5": {
        contextWindow: 200_000,
        maxOutput: 64_000,
        capabilities: caps({ modalities: ["text", "image"], thinking: ["enabled", "disabled"] }),
    },
};
const PREFIXES = [
    ["claude-opus", EXACT["claude-opus-4-8"]],
    ["claude-sonnet", EXACT["claude-sonnet-5"]],
    ["claude-haiku", EXACT["claude-haiku-4-5"]],
    ["claude", { contextWindow: 200_000, maxOutput: 64_000, capabilities: caps({ modalities: ["text", "image"], thinking: ["adaptive", "disabled"] }) }],
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
export const FALLBACK_METADATA = {
    contextWindow: 128_000,
    maxOutput: 16_000,
    capabilities: caps(),
};
export function lookupModelMetadata(id) {
    const exact = EXACT[id];
    if (exact)
        return exact;
    const lower = id.toLowerCase();
    for (const [prefix, metadata] of PREFIXES) {
        if (lower.startsWith(prefix))
            return metadata;
    }
    return FALLBACK_METADATA;
}
