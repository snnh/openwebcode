import type { Provider, ProviderEvent, StreamChatRequest } from "./provider.js";

export class DevelopmentProvider implements Provider {
  readonly name = "development";

  async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    request.signal.throwIfAborted();
    const last = request.messages.at(-1);
    const toolResult = last?.content.find((block) => block.type === "tool_result");

    if (toolResult?.type === "tool_result") {
      const prefix = toolResult.isError ? "Tool failed: " : "Command completed: ";
      yield { type: "text_delta", text: prefix };
      yield { type: "text_delta", text: toolResult.content };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }

    const text = last?.content.find((block) => block.type === "text");
    const command = text?.type === "text" ? parseCommand(text.text) : undefined;
    if (!command) {
      yield { type: "text_delta", text: "Development provider is ready. Prefix a message with `run: ` to execute a command." };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }

    yield {
      type: "tool_call",
      id: `dev-tool-${request.messages.length}`,
      name: "bash",
      input: { cmd: command },
    };
    yield { type: "done", stopReason: "tool_use" };
  }
}

function parseCommand(text: string): string | undefined {
  const match = /^run:\s+(.+)$/s.exec(text.trim());
  return match?.[1];
}
