import { randomUUID } from "node:crypto";
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";
import { normalizeProviderError, ProviderError } from "./provider-error.js";

interface RetryInfo {
  attemptId: string;
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

interface ProviderRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (info: RetryInfo) => void;
  /** 事件到达即回调（流式显示）；重试时新 attempt 的事件会再次从头推送，
   * 消费方应按 onRetry 丢弃上一 attempt 的增量。 */
  onEvent?: (event: ProviderEvent) => void;
}

/** 可恢复 provider 错误的默认最大尝试次数（含首次）：测试与文档引用同一出处，避免改默认值后
 * 断言不同步。 */
export const DEFAULT_PROVIDER_MAX_ATTEMPTS = 3;

export async function collectProviderTurn(
  provider: Provider,
  request: StreamChatRequest,
  options: ProviderRetryOptions = {},
): Promise<{ attemptId: string; events: ProviderEvent[] }> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_PROVIDER_MAX_ATTEMPTS;
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
      // 端点静默截断（SSE 到 EOF、既无 finish_reason 也无 [DONE] 哨兵）不会抛 transport 异常，
      // 只体现为 done.stopReason="error"：必须在重试层当失败处理，否则被当作正常空回合结束。
      const truncated = truncatedStreamError(events);
      if (truncated) throw truncated;
      return { attemptId, events };
    } catch (error) {
      const normalized = normalizeProviderError(error, events.length > 0);
      if (!normalized.retryable || attempt === maxAttempts) throw normalized;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      // Add bounded jitter to avoid synchronized retries when many sessions hit a rate limit.
      const jittered = Math.min(maxDelayMs, Math.round(exponential * (0.75 + Math.random() * 0.5)));
      const delayMs = normalized.retryAfterMs === undefined
        ? jittered
        : Math.min(maxDelayMs, normalized.retryAfterMs);
      options.onRetry?.({ attemptId, attempt, delayMs, error: normalized });
      await abortableDelay(delayMs, request.signal);
    }
  }
  throw new Error("Provider retry loop exhausted unexpectedly");
}

/**
 * 从本轮事件里识别「协议正常收尾但 stopReason=error」的静默截断：provider 约定在
 * 无 finish_reason/[DONE] 终态时以 done.stopReason="error" 收尾（见两家 OpenAI 系
 * provider 的 mapStopReason）。这类回合没有 transport 异常，只用 done 事件表达失败，
 * 因此在此归为可重试的 stream_interrupted——重试耗尽后由 catch 分支抛出，交给上层
 * 异常路径上报（而不是被当作正常空回合结束：不重试也不报错）。
 */
function truncatedStreamError(events: ProviderEvent[]): ProviderError | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "done") continue;
    if (event.stopReason !== "error") return undefined;
    return new ProviderError(
      "stream_interrupted",
      "Provider stream ended with stopReason=error (no finish_reason/[DONE] terminal signal): the response was likely truncated",
      true,
    );
  }
  return undefined;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  // 进入前先检查：signal 可能在上一次 await 期间已中止，否则还要白等整个 delay
  signal.throwIfAborted();
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
