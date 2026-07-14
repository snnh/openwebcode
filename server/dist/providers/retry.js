import { randomUUID } from "node:crypto";
import { normalizeProviderError } from "./provider-error.js";
export async function collectProviderTurn(provider, request, options = {}) {
    const maxAttempts = options.maxAttempts ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 500;
    const maxDelayMs = options.maxDelayMs ?? 30_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        request.signal.throwIfAborted();
        const attemptId = randomUUID();
        const events = [];
        try {
            for await (const event of provider.streamChat(request))
                events.push(event);
            return { attemptId, events };
        }
        catch (error) {
            const normalized = normalizeProviderError(error, events.length > 0);
            if (!normalized.retryable || attempt === maxAttempts)
                throw normalized;
            const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const delayMs = normalized.retryAfterMs === undefined
                ? exponential
                : Math.min(maxDelayMs, normalized.retryAfterMs);
            options.onRetry?.({ attemptId, attempt, delayMs, error: normalized });
            await abortableDelay(delayMs, request.signal);
        }
    }
    throw new Error("Provider retry loop exhausted unexpectedly");
}
function abortableDelay(delayMs, signal) {
    if (delayMs <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        signal.addEventListener("abort", aborted, { once: true });
        function done() {
            signal.removeEventListener("abort", aborted);
            resolve();
        }
        function aborted() {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        }
    });
}
