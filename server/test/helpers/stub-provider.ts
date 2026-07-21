import type { Provider, ProviderEvent, StreamChatRequest } from "../../src/providers/provider.js";

export type StubProviderHandler = (request: StreamChatRequest) => AsyncIterable<ProviderEvent>;

/**
 * Deterministic test-only provider. Its default stream preserves the small
 * command/artifact loop so tests can opt into
 * realistic tool turns without depending on a runtime-only provider.
 */
export function makeStubProvider(name: string, handler?: StubProviderHandler): Provider {
  return {
    name,
    async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
      yield* handler?.(request) ?? defaultEcho(request);
    },
  };
}

async function* defaultEcho(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
  request.signal.throwIfAborted();
  const last = request.messages.at(-1);
  const toolResult = last?.content.find((block) => block.type === "tool_result");

  if (toolResult?.type === "tool_result") {
    const prefix = toolResult.isError ? "Tool failed: " : "Command completed: ";
    yield { type: "text_delta", text: prefix };
    yield { type: "text_delta", text: toolResult.content };
    yield usage();
    yield { type: "done", stopReason: "end_turn" };
    return;
  }

  const text = last?.content.find((block) => block.type === "text");
  const artifact = text?.type === "text" ? parseArtifact(text.text) : undefined;
  if (artifact) {
    yield { type: "tool_call", id: `stub-artifact-${request.messages.length}`, name: "read_artifact", input: artifact };
    yield usage();
    yield { type: "done", stopReason: "tool_use" };
    return;
  }

  const command = text?.type === "text" ? parseCommand(text.text) : undefined;
  if (command) {
    yield { type: "tool_call", id: `stub-tool-${request.messages.length}`, name: "bash", input: { cmd: command } };
    yield usage();
    yield { type: "done", stopReason: "tool_use" };
    return;
  }

  yield { type: "text_delta", text: "Test provider is ready. Prefix a message with `run: ` to execute a command." };
  yield usage();
  yield { type: "done", stopReason: "end_turn" };
}

function usage(): ProviderEvent {
  return { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
}

function parseArtifact(text: string): Record<string, unknown> | undefined {
  const match = /^read-artifact:\s*(artifact-[0-9a-f-]{36})\s+(\d+)\s+(\d+)$/i.exec(text.trim());
  if (!match) return undefined;
  return { artifactId: match[1], offset: Number(match[2]), limit: Number(match[3]) };
}

function parseCommand(text: string): string | undefined {
  const match = /^run:\s+(.+)$/s.exec(text.trim());
  return match?.[1];
}
