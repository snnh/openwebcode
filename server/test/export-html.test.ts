import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-export-html-"));
  roots.push(root);
  return root;
}

const echoProvider = makeStubProvider("test-stub", async function* () {
  yield { type: "done", stopReason: "end_turn" };
});

// export.html 路由只读 SessionStore，core 用最小 fake 即可满足 buildServer 依赖
async function setup() {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: "Export <b>test</b>" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(echoProvider);
  const core = new EventEmitter() as unknown as CoreClientLike;
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, session, app };
}

describe("GET /api/sessions/:id/export.html", () => {
  it("输出含消息文本与工具名；无 <script src；特殊字符全部转义", async () => {
    const harness = await setup();
    try {
      await harness.sessions.appendMessage(harness.session.id, "user", [
        { type: "text", text: "请运行 <script>alert(1)</script> 并说明 **重点**\n\n- 第一项\n- 第二项\n\n```js\nconsole.log(\"<x>\")\n```" },
      ]);
      await harness.sessions.appendMessage(harness.session.id, "assistant", [
        { type: "thinking", text: "想一下 <b>方案</b>", provider: "test-stub" },
        { type: "text", text: "好的，调用工具。" },
        { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "echo <hi>" } },
      ]);
      await harness.sessions.appendMessage(harness.session.id, "tool", [
        { type: "tool_result", toolCallId: "call-1", content: "done <ok>", isError: false },
      ]);
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.html` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain(".html");
      const html = res.body;
      // 消息文本与工具名
      expect(html).toContain("请运行");
      expect(html).toContain("bash");
      expect(html).toContain("done &lt;ok&gt;");
      // tool_result 默认折叠
      expect(html).toContain("<details");
      // 最小 Markdown：粗体 / 列表 / 代码块
      expect(html).toContain("<strong>重点</strong>");
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>第一项</li>");
      expect(html).toContain("<pre><code>");
      // 特殊字符转义：注入的 <script> 不得以原始形态出现
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
      // 零外部资源：无外链 script
      expect(html).not.toContain("<script src");
      expect(html).not.toContain("<script");
      // 会话标题中的 HTML 也被转义
      expect(html).toContain("Export &lt;b&gt;test&lt;/b&gt;");
      expect(html).not.toContain("<b>test</b>");
    } finally {
      await harness.app.close();
    }
  });

  it("图片块内联为 data: URL", async () => {
    const harness = await setup();
    try {
      await harness.sessions.appendMessage(harness.session.id, "user", [
        { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
      ]);
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.html` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain('<img class="msg-image" src="data:image/png;base64,aGVsbG8="');
    } finally {
      await harness.app.close();
    }
  });

  it("恶意 image data（非 base64 字母表）不注入 HTML", async () => {
    const harness = await setup();
    try {
      // /import 路由不强制 base64 字母表；构造 data 含属性闭合符，绕过校验即可注入任意 HTML
      await harness.sessions.appendMessage(harness.session.id, "user", [
        { type: "image", mediaType: "image/png", data: `"><script>alert(String.fromCharCode(88,83,83))</script><img src="x` },
      ]);
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.html` });
      expect(res.statusCode, res.body).toBe(200);
      // 非 base64 字母表 -> 整块跳过（返回空），绝不出现原始 <script>
      expect(res.body).not.toContain("<script>");
      expect(res.body).not.toContain('"><script');
      // 合法 base64 仍渲染（交叉验证逻辑分支正确）
    } finally {
      await harness.app.close();
    }
  });

  it("会话不存在 -> 404", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${randomUUID()}/export.html` });
      expect(res.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  });

  it("会话为空 -> 200 且含空态提示", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.html` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.body).toContain("暂无消息");
    } finally {
      await harness.app.close();
    }
  });

  it("lang=en 生成英文分享页", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.html?lang=en` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain('<html lang="en">');
      expect(res.body).toContain("No messages");
      expect(res.body).toContain("OpenWebCode session export");
      expect(res.body).toContain("Exported by OpenWebCode");
    } finally {
      await harness.app.close();
    }
  });
});
