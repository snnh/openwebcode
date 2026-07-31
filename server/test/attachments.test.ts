import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { TOOL_RESULT_BUDGETS } from "../src/context/tool-result-budget.js";
import type { CoreClientLike, FsReadRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 注入 readFile/globFiles 的 fake core；readFile 按 path 表查，未命中抛错模拟沙盒越界 */
function createFakeCore(opts: {
  readFileImpl?: (req: FsReadRequest) => Promise<string>;
  globPaths?: string[];
} = {}): CoreClientLike {
  return {
    on() { return this; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async readFile(req: FsReadRequest) {
      if (opts.readFileImpl) return { content: await opts.readFileImpl(req), totalLines: 1, encoding: "utf-8" as const, truncated: false };
      return { content: "default", totalLines: 1, encoding: "utf-8" as const, truncated: false };
    },
    async globFiles() { return { paths: opts.globPaths ?? [], truncated: false }; },
    async grepFiles() { return { matches: [] }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 1 }; },
    async run() { return { exitCode: 0, durationMs: 0, truncated: false }; },
    async cleanupSession() { return { ok: true as const }; },
    setRequestTimeoutMs() {},
    start() { return Promise.resolve({ version: "0.0.0", platform: "windows" as const, sandboxCapability: "advisory" }); },
    stop() { return Promise.resolve(); },
    ping() { return Promise.resolve({ version: "0.0.0", platform: "windows" as const, sandboxCapability: "advisory" }); },
    listFiles() { return Promise.resolve({ entries: [], truncated: false }); },
  } as unknown as CoreClientLike;
}

const echoProvider = makeStubProvider("test-stub", async function* () {
  yield { type: "done", stopReason: "end_turn" };
});

/** 等待 agent 跑完并把首条用户消息落盘 */
async function waitForUserMessage(sessions: SessionStore, id: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await sessions.get(id);
    if (detail && detail.messages.some((m) => m.role === "user")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 标准 rig：临时目录 + SessionStore + buildServer；coreOpts 注入 fake core 的 readFile/glob 行为 */
async function setup(options: { title: string; coreOpts?: Parameters<typeof createFakeCore>[0] }) {
  const root = await tempRoot("owc-att-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: options.title });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(echoProvider);
  const events = new EventBus();
  const core = createFakeCore(options.coreOpts);
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, session, core, app };
}

describe("POST /messages attachments - injection order", () => {
  it("attachment text blocks precede the user body within the same user message content array", async () => {
    const { sessions, session, app } = await setup({
      title: "Att order",
      coreOpts: {
        readFileImpl: async (req) => {
          if (req.path === "a.txt") return "AAA";
          if (req.path === "b.txt") return "BBB";
          throw new Error(`unexpected path ${req.path}`);
        },
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: { content: "看下这些文件", attachments: [{ path: "a.txt" }, { path: "b.txt" }] },
      });
      expect(res.statusCode, res.body).toBe(202);
      await waitForUserMessage(sessions, session.id);
      const detail = await sessions.get(session.id);
      const userMsg = detail?.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const blocks = userMsg!.content;
      // 顺序：[Attachment a.txt] 块 -> [Attachment b.txt] 块 -> 用户正文 text 块
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toMatchObject({ type: "text", text: "[Attachment a.txt]\nAAA" });
      expect(blocks[1]).toMatchObject({ type: "text", text: "[Attachment b.txt]\nBBB" });
      expect(blocks[2]).toMatchObject({ type: "text", text: "看下这些文件" });
    } finally {
      await app.close();
    }
  });
});

describe("POST /messages attachments - sandbox violation", () => {
  it("an out-of-sandbox path degrades to an error block without blocking other attachments or the body", async () => {
    const { sessions, session, app } = await setup({
      title: "Att oob",
      coreOpts: {
        readFileImpl: async (req) => {
          if (req.path === "../secret.txt") throw new Error("path outside sandbox read roots");
          if (req.path === "ok.txt") return "OK";
          throw new Error(`unexpected path ${req.path}`);
        },
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: { content: "正文不受影响", attachments: [{ path: "../secret.txt" }, { path: "ok.txt" }] },
      });
      expect(res.statusCode, res.body).toBe(202);
      await waitForUserMessage(sessions, session.id);
      const detail = await sessions.get(session.id);
      const userMsg = detail?.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const blocks = userMsg!.content;
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toMatchObject({ type: "text" });
      expect((blocks[0] as { text: string }).text).toContain("[Attachment ../secret.txt]");
      expect((blocks[0] as { text: string }).text).toContain("错误：路径越界或不可读");
      expect((blocks[0] as { text: string }).text).toContain("path outside sandbox read roots");
      expect(blocks[1]).toMatchObject({ type: "text", text: "[Attachment ok.txt]\nOK" });
      expect(blocks[2]).toMatchObject({ type: "text", text: "正文不受影响" });
    } finally {
      await app.close();
    }
  });
});

describe("POST /messages attachments - large file truncation", () => {
  it("content over the read_file budget is truncated and an artifact pointer is embedded", async () => {
    // read_file 预算 16000 tokens -> 64000 字符为截断阈值；造一个 70000 字符的文件
    const budget = TOOL_RESULT_BUDGETS.read_file!;
    const thresholdChars = budget * 4;
    const bigContent = "A".repeat(thresholdChars + 5_000);
    const { sessions, session, app } = await setup({
      title: "Att big",
      coreOpts: {
        readFileImpl: async (req) => {
          if (req.path === "big.txt") return bigContent;
          throw new Error(`unexpected path ${req.path}`);
        },
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: { content: "总结这个大文件", attachments: [{ path: "big.txt" }] },
      });
      expect(res.statusCode, res.body).toBe(202);
      await waitForUserMessage(sessions, session.id);
      const detail = await sessions.get(session.id);
      const userMsg = detail?.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const blocks = userMsg!.content;
      expect(blocks).toHaveLength(2);
      const attBlock = blocks[0] as { type: string; text: string };
      expect(attBlock.type).toBe("text");
      expect(attBlock.text).toContain("[Attachment big.txt]");
      expect(attBlock.text).toContain("[truncated: original approximately");
      // artifact 指针格式 artifact:artifact-xxxxxxxx
      expect(attBlock.text).toMatch(/artifact:artifact-[0-9a-f-]+/);
      const match = attBlock.text.match(/artifact:(artifact-[0-9a-f-]+)/);
      expect(match).not.toBeNull();
      // artifact 文件落盘到 session contextRoot 的 artifacts/ 下
      const artifactPath = path.join(sessions.contextRoot(session.id), "artifacts", `${match![1]}.txt`);
      const stored = await readFile(artifactPath, "utf8");
      expect(stored).toBe(bigContent);
      // 截断后内容长度应远小于原文
      expect(attBlock.text.length).toBeLessThan(bigContent.length);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/sessions/:id/complete-path", () => {
  it("returns up to 20 matches via core.globFiles with pattern *q*", async () => {
    const { session, core, app } = await setup({ title: "Complete", coreOpts: { globPaths: ["src/a.ts", "src/b.ts", "readme.md"] } });
    const globSpy = vi.fn(async () => ({ paths: ["src/a.ts", "src/b.ts", "readme.md"], truncated: false }));
    (core as unknown as { globFiles: typeof globSpy }).globFiles = globSpy;
    try {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/complete-path?q=ts` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ matches: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "readme.md" }] });
      expect(globSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, pattern: "*ts*" }));
    } finally {
      await app.close();
    }
  });

  it("caps the result list at 20 entries", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
    const { session, app } = await setup({ title: "Complete cap", coreOpts: { globPaths: many } });
    try {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/complete-path?q=file` });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ matches: Array<{ path: string }> }>();
      expect(body.matches).toHaveLength(20);
    } finally {
      await app.close();
    }
  });

  it("returns an empty array when q is empty", async () => {
    const { session, core, app } = await setup({ title: "Complete empty q" });
    const globSpy = vi.fn(async () => ({ paths: ["should-not-be-called.ts"], truncated: false }));
    (core as unknown as { globFiles: typeof globSpy }).globFiles = globSpy;
    try {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/complete-path?q=` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ matches: [] });
      expect(globSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the session does not exist", async () => {
    const { app } = await setup({ title: "Complete 404" });
    try {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${randomUUID()}/complete-path?q=x` });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("POST /messages attachments - validation", () => {
  it("rejects more than 10 attachments", async () => {
    const { session, app } = await setup({ title: "Att too many" });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: { content: "x", attachments: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.ts` })) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toContain("attachments");
    } finally {
      await app.close();
    }
  });

  it("rejects empty path strings", async () => {
    const { session, app } = await setup({ title: "Att empty path" });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: { content: "x", attachments: [{ path: "   " }] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("attachments do not bypass /clear short-circuit", async () => {
    const readFileSpy = vi.fn(async () => "should-not-be-called");
    const { session, app } = await setup({ title: "Att clear", coreOpts: { readFileImpl: readFileSpy } });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: { content: "/clear", attachments: [{ path: "a.txt" }] },
      });
      // /clear 短路：attachments 不被读取
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ accepted: true, cleared: true });
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
