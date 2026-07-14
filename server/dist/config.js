function positiveInteger(value, fallback) {
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`Expected a positive integer, received ${value}`);
    }
    return parsed;
}
function booleanWithDefault(value, fallback) {
    if (value === undefined)
        return fallback;
    if (value === "true" || value === "1")
        return true;
    if (value === "false" || value === "0")
        return false;
    throw new Error(`Expected a boolean, received ${value}`);
}
export function loadConfig(env = process.env) {
    return {
        host: env.OWC_HOST ?? "127.0.0.1",
        port: positiveInteger(env.OWC_PORT, 3210),
        corePath: env.OWC_CORE_PATH ?? "../build/Debug/owc-exec.exe",
        dataDir: env.OWC_DATA_DIR ?? "../.openwebcode",
        coreRequestTimeoutMs: positiveInteger(env.OWC_CORE_REQUEST_TIMEOUT_MS, 130_000),
        ...(env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL
            ? {
                anthropic: {
                    ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
                    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
                    promptCaching: booleanWithDefault(env.ANTHROPIC_PROMPT_CACHING, true),
                },
            }
            : {}),
        ...(env.OPENAI_BASE_URL
            ? {
                openai: {
                    baseURL: env.OPENAI_BASE_URL,
                    ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
                },
            }
            : {}),
    };
}
