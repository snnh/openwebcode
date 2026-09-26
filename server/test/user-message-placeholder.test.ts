import path from "node:path";
import { describe, expect, it } from "vitest";
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

describe("userMessageText 占位文本", () => {
  it("有正文时原样返回（含仅空白以外的内容）", () => {
    expect(userMessageText("看图", 2, ["/tmp/a.pdf"])).toBe("看图");
    expect(userMessageText("  hi  ", 0, [])).toBe("  hi  ");
  });

  it("只有图片：单张 [Image]、多张带数量", () => {
    expect(userMessageText("", 1, [])).toBe("[Image]");
    expect(userMessageText("   ", 3, [])).toBe("[Image ×3]");
  });

  it("只有附件：列文件名（basename），超过 3 个省略", () => {
    expect(userMessageText("", 0, ["/tmp/a/b.pdf"])).toBe("[File: b.pdf]");
    expect(userMessageText("", 0, ["C:\\tmp\\a.pdf", "b/c.txt"])).toBe("[File ×2: a.pdf, c.txt]");
    expect(userMessageText("", 0, ["a.pdf", "b.pdf", "c.pdf", "d.pdf"])).toBe("[File ×4: a.pdf, b.pdf, c.pdf, …]");
  });

  it("图片与附件同时存在：两段占位空格分隔", () => {
    expect(userMessageText("", 2, ["/tmp/a.pdf"])).toBe("[Image ×2] [File: a.pdf]");
  });

  it("无正文且无图无附件：原样返回空串（不伪造内容，路由层已拒绝该组合）", () => {
    expect(userMessageText("", 0, [])).toBe("");
  });
});

describe("标题派生跳过附件引用块", () => {
  it("附件块 + 正文：取正文而不是附件内容", () => {
    expect(titleFromContent([
      { type: "text", text: "[Attachment /tmp/a.ts]\nexport const x = 1;" },
      { type: "text", text: "改一下这个文件" },
    ])).toBe("改一下这个文件");
  });

  it("纯附件消息：取占位文本（不再是文件内容）", () => {
    expect(titleFromContent([
      { type: "image", mediaType: "image/png", data: "x" },
      { type: "text", text: "[Attachment /tmp/a.ts]\nexport const x = 1;" },
      { type: "text", text: "[File: a.ts]" },
    ])).toBe("[File: a.ts]");
  });

  it("只有附件块（无占位）：退回附件块本身，仍返回非空标题", () => {
    expect(deriveTitleFromMessages([
      { id: "m1", role: "user", content: [{ type: "text", text: "[Attachment /tmp/a.ts]\ncontent" }], createdAt: "2026-01-01T00:00:00.000Z" },
    ], "New session")).toBe("[Attachment /tmp/a.ts]\ncontent");
  });

  it("空文本块不算标题来源", () => {
    expect(titleFromContent([{ type: "text", text: "" }, { type: "text", text: "正文" }])).toBe("正文");
    expect(titleFromContent([{ type: "text", text: "   " }])).toBeUndefined();
  });
});

async function runAgent(text: string, options: { images?: Array<{ mediaType: string; data: string }>; attachments?: Array<{ path?: string; text: string }> }): Promise<{ sessions: SessionStore; sessionId: string }> {
  const root = await tempRoot("owc-placeholder-agent-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "stub", model: "stub-model" });
  // 手动快照 + yolo：聚焦消息落盘形态，不引入真实快照与权限审批
  await sessions.updateConfig(session.id, { provider: "stub", model: "stub-model", snapshotMode: "manual" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("stub"));
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const runner = new AgentRunner(
    sessions,
    providers,
    makeFakeCore(),
    new EventBus(),
    pricing,
    undefined,
    "zh-CN",
    50,
    undefined,
    new UsageLog(path.join(root, "data")),
  );
  await runner.run(session.id, text, options);
  return { sessions, sessionId: session.id };
}

describe("纯附件消息落盘（会话格式不变）", () => {
  it("只有图片、无正文：图片块 + 占位正文块，标题取占位", async () => {
    const { sessions, sessionId } = await runAgent("", { images: [IMAGE, IMAGE] });
    const detail = await sessions.get(sessionId);
    const user = detail?.messages.find((message) => message.role === "user");
    expect(user?.content.filter((block) => block.type === "image")).toHaveLength(2);
    expect(user?.content.at(-1)).toEqual({ type: "text", text: "[Image ×2]" });
    expect(detail?.title).toBe("[Image ×2]");
  });

  it("只有附件、无正文：附件块 + 占位正文块（列文件名），标题取占位", async () => {
    const { sessions, sessionId } = await runAgent("", {
      attachments: [{ path: "/tmp/dir/spec.md", text: "[Attachment /tmp/dir/spec.md]\n# Spec" }],
    });
    const detail = await sessions.get(sessionId);
    const user = detail?.messages.find((message) => message.role === "user");
    expect(user?.content.at(-1)).toEqual({ type: "text", text: "[File: spec.md]" });
    expect(detail?.title).toBe("[File: spec.md]");
  });

  it("有正文时不改写：正文块原样保留", async () => {
    const { sessions, sessionId } = await runAgent("  看图  ", { images: [IMAGE] });
    const detail = await sessions.get(sessionId);
    const user = detail?.messages.find((message) => message.role === "user");
    expect(user?.content.at(-1)).toEqual({ type: "text", text: "  看图  " });
  });
});

describe("POST /api/sessions/:id/messages 纯附件消息（路由层）", () => {
  async function fixture() {
    const setup = await makeTestApp({
      tempPrefix: "owc-attachment-route-",
      agent: "real",
      core: makeFakeCore() as unknown as CoreClient,
      configureProviders: (providers) => providers.register(makeStubProvider("stub")),
    });
    const session = await setup.sessions.create({ cwd: setup.root, provider: "stub", model: "stub-model" });
    await setup.sessions.updateConfig(session.id, { provider: "stub", model: "stub-model", snapshotMode: "manual" });
    await setup.sessions.updatePermissions(session.id, "yolo", []);
    return { ...setup, sessionId: session.id };
  }

  async function waitForAssistant(sessions: SessionStore, sessionId: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const detail = await sessions.get(sessionId);
      if (detail?.messages.some((message) => message.role === "assistant")) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("assistant message did not arrive in time");
  }

  it("空正文 + attachments 放行（202），落占位正文块", async () => {
    const setup = await fixture();
    const response = await setup.app.inject({
      method: "POST",
      url: `/api/sessions/${setup.sessionId}/messages`,
      payload: { content: "", attachments: [{ path: "spec.md" }] },
    });
    expect(response.statusCode).toBe(202);
    await waitForAssistant(setup.sessions, setup.sessionId);
    const detail = await setup.sessions.get(setup.sessionId);
    const user = detail?.messages.find((message) => message.role === "user");
    expect(user?.content.at(-1)).toEqual({ type: "text", text: "[File: spec.md]" });
    await setup.app.close();
  });

  it("空正文 + 无图片无附件仍 400", async () => {
    const setup = await fixture();
    const empty = await setup.app.inject({ method: "POST", url: `/api/sessions/${setup.sessionId}/messages`, payload: { content: "" } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toContain("images/attachments");
    const blank = await setup.app.inject({ method: "POST", url: `/api/sessions/${setup.sessionId}/messages`, payload: { content: "   " } });
    expect(blank.statusCode).toBe(400);
    const noContent = await setup.app.inject({ method: "POST", url: `/api/sessions/${setup.sessionId}/messages`, payload: { attachments: [{ path: "a.ts" }] } as never });
    expect(noContent.statusCode).toBe(400);
    await setup.app.close();
  });

  it("空正文 + 空数组（images: [] / attachments: []）按无附件处理，仍 400", async () => {
    const setup = await fixture();
    const response = await setup.app.inject({
      method: "POST",
      url: `/api/sessions/${setup.sessionId}/messages`,
      payload: { content: "", images: [], attachments: [] },
    });
    expect(response.statusCode).toBe(400);
    await setup.app.close();
  });
});
