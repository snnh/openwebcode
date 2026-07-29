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
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-export-md-"));
  roots.push(root);
  return root;
}

const echoProvider = makeStubProvider("test-stub", async function* () {
  yield { type: "done", stopReason: "end_turn" };
});

// export.md 路由只读 SessionStore，core 用最小 fake 即可满足 buildServer 依赖（同 export-html 测试）
async function setup() {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: "导出测试" });
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

describe("GET /api/sessions/:id/export.md", () => {
  it("含用户/助手内容与工具调用围栏；thinking 折叠；工具结果截断", async () => {
    const harness = await setup();
    try {
      await harness.sessions.appendMessage(harness.session.id, "user", [
        { type: "text", text: "请导出这个会话" },
      ]);
      await harness.sessions.appendMessage(harness.session.id, "assistant", [
        { type: "thinking", text: "思考一下方案", provider: "test-stub" },
        { type: "text", text: "好的，调用工具。" },
        { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "echo hi" } },
      ]);
      await harness.sessions.appendMessage(harness.session.id, "tool", [
        { type: "tool_result", toolCallId: "call-1", content: `prefix-${"x".repeat(5000)}`, isError: false },
      ]);
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.md` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain(".md");
      const md = res.body;
      expect(md).toContain("# 导出测试");
      // 角色小节标题
      expect(md).toMatch(/## 用户 · /);
      expect(md).toMatch(/## 助手 · /);
      expect(md).toMatch(/## 工具 · /);
      // 用户/助手文本原文保留
      expect(md).toContain("请导出这个会话");
      expect(md).toContain("好的，调用工具。");
      // thinking 折叠
      expect(md).toContain("<details>");
      expect(md).toContain("<summary>思考</summary>");
      expect(md).toContain("思考一下方案");
      // 工具调用：名称小节 + json 围栏
      expect(md).toContain("### 工具调用：bash");
      expect(md).toContain("```json");
      expect(md).toContain('"cmd": "echo hi"');
      // 工具结果：围栏 + 4000 字符截断并标注
      expect(md).toContain("### 工具结果");
      expect(md).toContain("结果过长已截断");
      expect(md).toContain("5007 字符");
      expect(md).not.toContain("x".repeat(4001));
    } finally {
      await harness.app.close();
    }
  });

  it("仅导出活动路径消息（fork 分支不包含）", async () => {
    const harness = await setup();
    try {
      const first = await harness.sessions.appendMessage(harness.session.id, "user", [{ type: "text", text: "原始问题" }]);
      await harness.sessions.appendMessage(harness.session.id, "assistant", [{ type: "text", text: "旧分支回答" }]);
      // fork：回到第一条用户消息，开启新分支
      await harness.sessions.setActiveLeaf(harness.session.id, first.id);
      await harness.sessions.appendMessage(harness.session.id, "user", [{ type: "text", text: "改写后的问题" }]);
      await harness.sessions.appendMessage(harness.session.id, "assistant", [{ type: "text", text: "新分支回答" }]);
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.md` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain("原始问题");
      expect(res.body).toContain("改写后的问题");
      expect(res.body).toContain("新分支回答");
      expect(res.body).not.toContain("旧分支回答");
    } finally {
      await harness.app.close();
    }
  });

  it("会话不存在 -> 404", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${randomUUID()}/export.md` });
      expect(res.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  });

  it("空会话 -> 200 且含空态提示", async () => {
    const harness = await setup();
    try {
      const res = await harness.app.inject({ method: "GET", url: `/api/sessions/${harness.session.id}/export.md` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain("暂无消息");
    } finally {
      await harness.app.close();
    }
  });
});
