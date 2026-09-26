import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSubAgent } from "../src/agent/sub-agent.js";
import type { Provider } from "../src/providers/provider.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("子代理工具循环", () => {
  it("stopReason 非 tool_use 但已产生 tool_call 时仍执行并落盘 tool_result", async () => {
    const root = await tempRoot("owc-subagent-compat-");
    let turn = 0;
    const provider: Provider = {
      name: "compat",
      async *streamChat() {
        turn += 1;
        if (turn === 1) {
          // 兼容 provider 的已知形态：给出 tool_call 却报 end_turn
          yield { type: "tool_call", id: "sub-1", name: "read_file", input: { path: "a.ts" } };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "结论：a.ts 已读过" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };

    const result = await runSubAgent({
      provider,
      model: "test-model",
      prompt: "读一下 a.ts 并给结论",
      toolNames: ["read_file"],
      agentKind: "explore",
      core: makeFakeCore({
        async readFile() { return { content: "file body", totalLines: 1, encoding: "utf-8" as const, truncated: false }; },
      }),
      sessionId: "session-1",
      cwd: root,
      contextRoot: root,
      signal: new AbortController().signal,
      taskId: "task-compat",
    });

    expect(result).toMatchObject({ turns: 2, toolsUsed: ["read_file"] });
    expect(result.conclusion).toContain("a.ts 已读过");

    const transcript = JSON.parse(await readFile(path.join(root, "subagents", "task-compat.json"), "utf8")) as {
      messages: Array<{ role: string; content: Array<{ type: string; toolCallId?: string; isError?: boolean; content?: string }> }>;
    };
    const toolResults = transcript.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ toolCallId: "sub-1", isError: false });
    expect(toolResults[0]!.content).toContain("file body");
  });
});
