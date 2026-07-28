import { describe, expect, it } from "vitest";
import { deriveInputHistory, userMessageText } from "../lib/input-history";
import type { ChatMessage } from "../lib/contracts";

function message(id: string, role: ChatMessage["role"], texts: string[]): ChatMessage {
  return { id, role, createdAt: "2026-07-28T00:00:00.000Z", content: texts.map((text) => ({ type: "text", text })) };
}

describe("deriveInputHistory", () => {
  it("仅保留用户消息文本，最新在前，空文本跳过", () => {
    const messages: ChatMessage[] = [
      message("m1", "user", ["第一个问题"]),
      message("m2", "assistant", ["回答"]),
      { id: "m3", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "image", data: "x" }] },
      message("m4", "user", ["  "]),
      message("m5", "user", ["第二个问题", "补充"]),
    ];
    expect(deriveInputHistory(messages)).toEqual(["第二个问题\n补充", "第一个问题"]);
  });

  it("userMessageText 拼接 text 块并 trim", () => {
    expect(userMessageText(message("m", "user", ["a", "b"]))).toBe("a\nb");
  });
});
