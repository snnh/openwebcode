import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { userMessageText } from "../src/agent/message-placeholder.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { deriveTitleFromMessages, titleFromContent } from "../src/sessions/store-utils.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";

const IMAGE = { mediaType: "image/png", data: "aGVsbG8=" };
const userOf = async (sessions: SessionStore, sessionId: string) =>
  (await sessions.get(sessionId))?.messages.find((message) => message.role === "user");
const ATTACHMENT_BLOCK = { type: "text", text: "[Attachment /tmp/a.ts]\nexport const x = 1;" } as const;

describe("userMessageText 占位文本与标题派生", () => {
  it("占位文本：有正文原样返回，仅附件/图片按时生成（附件取 basename，超 3 个省略）；标题派生跳过附件块", () => {
    const cases: Array<[string, number, string[], string]> = [
      ["看图", 2, ["/tmp/a.pdf"], "看图"],
      ["  hi  ", 0, [], "  hi  "],
      ["", 1, [], "[Image]"],
      ["   ", 3, [], "[Image ×3]"],
      ["", 0, ["/tmp/a/b.pdf"], "[File: b.pdf]"],
      ["", 0, ["C:\\tmp\\a.pdf", "b/c.txt"], "[File ×2: a.pdf, c.txt]"],
      ["", 0, ["a.pdf", "b.pdf", "c.pdf", "d.pdf"], "[File ×4: a.pdf, b.pdf, c.pdf, …]"],
      ["", 2, ["/tmp/a.pdf"], "[Image ×2] [File: a.pdf]"],
      ["", 0, [], ""], // 无正文且无图无附件：路由层已拒绝该组合
    ];
    for (const [text, images, attachments, expected] of cases) {
      expect(userMessageText(text, images, attachments), JSON.stringify([text, images, attachments])).toBe(expected);
    }

    // 标题派生跳过附件引用块：取正文/占位；纯附件块退回块本身；空文本块不算来源
    expect(titleFromContent([ATTACHMENT_BLOCK, { type: "text", text: "改一下这个文件" }])).toBe("改一下这个文件");
    expect(titleFromContent([
      { type: "image", mediaType: "image/png", data: "x" }, ATTACHMENT_BLOCK, { type: "text", text: "[File: a.ts]" },
    ])).toBe("[File: a.ts]");
    expect(deriveTitleFromMessages([
      { id: "m1", role: "user", content: [{ type: "text", text: "[Attachment /tmp/a.ts]\ncontent" }], createdAt: "2026-01-01T00:00:00.000Z" },
    ], "New session")).toBe("[Attachment /tmp/a.ts]\ncontent");
    expect(titleFromContent([{ type: "text", text: "" }, { type: "text", text: "正文" }])).toBe("正文");
    expect(titleFromContent([{ type: "text", text: "   " }])).toBeUndefined();
  });
});

/** 真实 AgentRunner 装配（手动快照）：聚焦消息落盘形态。 */
async function runAgent(text: string, options: Record<string, unknown>): Promise<{ sessions: SessionStore; sessionId: string }> {
  const root = await tempRoot("owc-placeholder-agent-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "stub", model: "stub-model" });
  await sessions.updateConfig(session.id, { provider: "stub", model: "stub-model", snapshotMode: "manual" });
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("stub"));
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const runner = new AgentRunner(sessions, providers, makeFakeCore(), new EventBus(), pricing, undefined, "zh-CN", 50, undefined, new UsageLog(path.join(root, "data")));
  await runner.run(session.id, text, options);
  return { sessions, sessionId: session.id };
}

describe("纯附件消息（落盘形态 + 路由层）", () => {
  it("无正文时保留附件块并追加占位正文块、标题取占位；有正文时正文块原样保留", async () => {
    const images = await runAgent("", { images: [IMAGE, IMAGE] });
    const imageUser = await userOf(images.sessions, images.sessionId);
    expect(imageUser?.content.filter((block) => block.type === "image")).toHaveLength(2); // 附件块不被占位替换
    expect(imageUser?.content.at(-1)).toEqual({ type: "text", text: "[Image ×2]" });
    expect((await images.sessions.get(images.sessionId))?.title).toBe("[Image ×2]");
    const files = await runAgent("", { attachments: [{ path: "/tmp/dir/spec.md", text: "[Attachment /tmp/dir/spec.md]\n# Spec" }] });
    expect((await userOf(files.sessions, files.sessionId))?.content.at(-1)).toEqual({ type: "text", text: "[File: spec.md]" });
    expect((await files.sessions.get(files.sessionId))?.title).toBe("[File: spec.md]");
    const withText = await runAgent("  看图  ", { images: [IMAGE] });
    expect((await userOf(withText.sessions, withText.sessionId))?.content.at(-1)).toEqual({ type: "text", text: "  看图  " });
  });
  async function fixture() {
    const setup = await makeTestApp({
      tempPrefix: "owc-attachment-route-", agent: "real", core: makeFakeCore() as unknown as CoreClient,
      configureProviders: (providers) => providers.register(makeStubProvider("stub")),
    });
    const session = await setup.sessions.create({ cwd: setup.root, provider: "stub", model: "stub-model" });
    await setup.sessions.updateConfig(session.id, { provider: "stub", model: "stub-model", snapshotMode: "manual" });
    const post = (payload: Record<string, unknown>) => setup.app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload });
    return { ...setup, sessionId: session.id, post };
  }

  it("空正文 + attachments 放行（202）并落盘占位正文块", async () => {
    const setup = await fixture();
    expect((await setup.post({ content: "", attachments: [{ path: "spec.md" }] })).statusCode).toBe(202);
    // POST 只确认后台 run，等消息落盘后再断言
    await vi.waitFor(async () => expect((await userOf(setup.sessions, setup.sessionId))?.content.at(-1)).toEqual({ type: "text", text: "[File: spec.md]" }));
    await setup.app.close();
  });
  it("空正文且无有效附件（空串 / 空白 / 缺 content / 空数组）：一律 400", async () => {
    const setup = await fixture();
    const empty = await setup.post({ content: "" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toContain("images/attachments");
    for (const payload of [{ content: "   " }, { attachments: [{ path: "a.ts" }] }, { content: "", images: [], attachments: [] }]) {
      const response = await setup.post(payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await setup.app.close();
  });
});
