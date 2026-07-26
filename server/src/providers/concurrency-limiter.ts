/**
 * 0.5.0 Phase 2: per-provider concurrency limiter.
 *
 * Wraps a Provider so that at most `maxConcurrent` streamChat calls execute
 * simultaneously. Excess calls are queued and released in FIFO order.
 * Active/queued counts are exposed for diagnostics.
 */
import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";

export interface ProviderConcurrencyStats {
  active: number;
  queued: number;
  maxConcurrent: number;
}

const DEFAULT_MAX_CONCURRENT = 3;

export class ConcurrencyLimitedProvider implements Provider {
  private active = 0;
  private readonly queue: Array<{ grant: () => void; reject: (reason: unknown) => void; signal: AbortSignal; onAbort: () => void }> = [];
  private readonly maxConcurrent: number;

  constructor(
    private readonly inner: Provider,
    maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  ) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  get name(): string {
    return this.inner.name;
  }

  get promptCaching(): boolean | undefined {
    return this.inner.promptCaching;
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    await this.acquire(request.signal);
    try {
      yield* this.inner.streamChat(request);
    } finally {
      this.release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        reject,
        grant: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          resolve();
        },
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
      // Close the enqueue/listener race if the signal aborted synchronously.
      if (signal.aborted) waiter.onAbort();
    });
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next.grant();
  }

  getStats(): ProviderConcurrencyStats {
    return { active: this.active, queued: this.queue.length, maxConcurrent: this.maxConcurrent };
  }
}
