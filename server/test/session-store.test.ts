import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("SessionStore.appendMessage 并发串行化", () => {
  it("并发追加大消息：JSONL 行数与完整性保持（无交织坏行）", async () => {
    const root = await tempRoot("owc-session-store-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m" });

    // 1MB 级消息并发追加：底层多次 write，未串行化时最易交织坏行
    const big = "x".repeat(1024 * 1024);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.appendMessage(session.id, "user", [{ type: "text", text: `${index}:${big}` }])),
    );

    const raw = await readFile(path.join(root, "sessions", session.id, "messages.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(8);
    const seen = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { content: Array<{ text: string }> };
      const match = /^(\d):x+$/.exec(parsed.content[0]!.text);
      expect(match, "每行必须是完整 JSON 且内容未被其他消息交织").toBeTruthy();
      seen.add(match![1]!);
    }
    expect(seen.size).toBe(8);
  });

  it("串行化链不阻断后续追加：前一条失败后一条仍正常落盘", async () => {
    const root = await tempRoot("owc-session-store-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m" });

    // 对不存在的会话追加失败（readMeta 抛错），同会话后续追加不受影响
    await expect(store.appendMessage("missing-session", "user", [{ type: "text", text: "x" }])).rejects.toThrow();
    const message = await store.appendMessage(session.id, "user", [{ type: "text", text: "正常消息" }]);
    expect(message.content).toEqual([{ type: "text", text: "正常消息" }]);
    const detail = await store.get(session.id);
    expect(detail?.messages).toHaveLength(1);
  });
});
