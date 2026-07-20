import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { ContentLensService } from "../src/extensions/content-lens.js";
import { optimizeAttention } from "../src/extensions/official.js";
import type { Provider2Client } from "../src/provider2.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, createdAt: "2026-07-20T00:00:00.000Z", content: [{ type: "text", text }] };
}

describe("official extensions", () => {
  it("copies important references into a bottom anchor without rewriting original messages", () => {
    const messages = [message("u1", "user", "必须保留所有用户修改"), message("a1", "assistant", "收到"), message("u2", "user", "修复测试失败")];
    const result = optimizeAttention({ sessionId: "s1", cwd: "/tmp/work", messages, ledger: { round: 2, entries: [], compacted: { summary: "", instructions: ["不要删除文档"] } } }, { mode: "bottomOnly", anchorBudget: 1000 });
    expect(result.messages).toHaveLength(messages.length + 1);
    expect(result.messages?.slice(0, messages.length)).toEqual(messages);
    expect(result.messages?.at(-1)?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("必须保留") });
  });

  it("runs official hooks in a separate host and persists enable/config state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-ext-"));
    temporary.push(root);
    const manager = new ExtensionManager(root);
    await manager.initialize();
    try {
      expect(manager.list().map((item) => [item.id, item.enabled])).toEqual([
        ["context-manager", true],
        ["attention-optimizer", false],
        ["content-lens", false],
      ]);
      await manager.configure("attention-optimizer", { enabled: true, config: { mode: "full", anchorBudget: 800 } });
      const transformed = await manager.transformContext({ sessionId: "s1", cwd: root, messages: [message("u1", "user", "必须运行测试")], ledger: { round: 1, entries: [] } });
      expect(transformed.messages.length).toBeGreaterThan(1);
      const persisted = JSON.parse(await readFile(path.join(root, "extensions", "extensions.json"), "utf8")) as { extensions: Record<string, { enabled: boolean }> };
      expect(persisted.extensions["attention-optimizer"]?.enabled).toBe(true);

      const source = path.join(root, "sample-source");
      await mkdir(source);
      await writeFile(path.join(source, "manifest.json"), JSON.stringify({ id: "sample", name: "Sample", version: "1.0.0", description: "test", apiVersion: "1", permissions: [], entry: "index.js" }), "utf8");
      await writeFile(path.join(source, "index.js"), "export function activate(api) { api.on('context.beforeBuild', (payload) => ({ messages: payload.messages })); }\n", "utf8");
      expect((await manager.install(source)).id).toBe("sample");
      expect((await manager.configure("sample", { enabled: true })).status).toBe("error");
      await manager.uninstall("sample");
      expect(manager.list().find((item) => item.id === "context-manager")?.status).toBe("running");

      await writeFile(path.join(source, "manifest.json"), JSON.stringify({ id: "context-manager", name: "Collision", version: "1.0.0", description: "test", apiVersion: "1", permissions: [] }), "utf8");
      await expect(manager.install(source)).rejects.toThrow("Extension ID already exists");
    } finally {
      await manager.close();
    }
  }, 15_000);

  it("keeps content-lens output outside message history and reuses its translation cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-lens-"));
    temporary.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "development", model: "development" });
    const saved = await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "Hello **world**" }]);
    let calls = 0;
    const provider2 = {
      configured: true,
      complete: async () => { calls += 1; return { text: "你好 **world**", usage: { inputTokens: 3, outputTokens: 3 } }; },
    } as unknown as Provider2Client;
    const lens = new ContentLensService(sessions, provider2);
    expect((await lens.translate(session.id, saved.id, "zh-CN")).cached).toBe(false);
    expect((await lens.translate(session.id, saved.id, "zh-CN")).cached).toBe(true);
    expect(calls).toBe(1);
    expect((await sessions.get(session.id))?.messages).toHaveLength(1);
  });
});
