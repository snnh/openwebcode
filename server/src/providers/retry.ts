import { randomUUID } from "node:crypto";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";
import { normalizeProviderError, type ProviderError } from "./provider-error.js";

export interface RetryInfo {
  attemptId: string;
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

export interface ProviderRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (info: RetryInfo) => void;
  /** 事件到达即回调（流式显示）；重试时新 attempt 的事件会再次从头推送，
   * 消费方应按 onRetry 丢弃上一 attempt 的增量。 */
  onEvent?: (event: ProviderEvent) => void;
}

export async function collectProviderTurn(
  provider: Provider,
  request: StreamChatRequest,
  options: ProviderRetryOptions = {},
): Promise<{ attemptId: string; events: ProviderEvent[] }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    request.signal.throwIfAborted();
    const attemptId = randomUUID();
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider.streamChat(request)) {
        events.push(event);
        options.onEvent?.(event);
      }
      return { attemptId, events };
    } catch (error) {
      const normalized = normalizeProviderError(error, events.length > 0);
      if (!normalized.retryable || attempt === maxAttempts) throw normalized;
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

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });

    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    }
  });
}
