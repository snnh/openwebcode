import type { Provider, ProviderEvent } from "../providers/provider.js";

/**
 * Scripted mock provider for evaluation replay. Each turn yields the
 * pre-scripted events for that turn index. When the script is exhausted
 * the provider yields a bare `end_turn` so the agent loop terminates.
 *
 * This keeps evaluation reproducible without an API key; the script
 * defines exactly which tool calls and text deltas the "model" produces.
 */
export function createEvalProvider(name: string, script: ProviderEvent[][]): Provider {
  let turn = 0;
  return {
    name,
    async *streamChat(): AsyncIterable<ProviderEvent> {
      const events = script[turn];
      turn++;
      if (events) {
        yield* events;
        return;
      }
      // Script exhausted — stop the loop.
      yield { type: "usage", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

/** Minimal usage event helper for script builders. */
export function usage(): ProviderEvent {
  return { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
}
