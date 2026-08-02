import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, FsReadBase64Result, FsReadRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

const echoProvider = makeStubProvider("test-stub", async function* () {
  yield { type: "done", stopReason: "end_turn" };
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function setup(options: { withReadBase64?: boolean; readBase64Result?: FsReadBase64Result } = {}) {
  const { withReadBase64 = true, readBase64Result } = options;
  const root = await tempRoot("owc-files-routes-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(echoProvider);
  const readCalls: FsReadRequest[] = [];
  const rawResult: FsReadBase64Result = readBase64Result ?? { base64: PNG_BYTES.toString("base64"), size: PNG_BYTES.length, truncated: false };
  const overrides: Partial<CoreClientLike> = {
    async readFile(request) {
      readCalls.push({ ...request });
      return { content: "line\n", totalLines: 100, encoding: "utf-8" as const, truncated: false };
    },
  };
  if (withReadBase64) overrides.readFileBase64 = async () => rawResult;
  const core = makeFakeCore(overrides);
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { app, session, readCalls };
}

describe("GET /api/sessions/:id/files/content 分页透传（阶段 2c）", () => {
  it("offset/limit 透传到 core.readFile；缺省不带分页参数", async () => {
    const { app, session, readCalls } = await setup();
    try {
      const plain = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/content?path=a.txt` });
      expect(plain.statusCode).toBe(200);
      expect(readCalls[0]).toEqual({ sessionId: session.id, path: "a.txt" });
      expect(plain.json()).toMatchObject({ content: "line\n", totalLines: 100, truncated: false, revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const paged = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/content?path=a.txt&offset=40&limit=20` });
      expect(paged.statusCode).toBe(200);
      expect(readCalls[1]).toEqual({ sessionId: session.id, path: "a.txt", offset: 40, limit: 20 });
    } finally {
      await app.close();
    }
  });

  it("非法 offset/limit（负数、非整数、非数字）一律 400", async () => {
    const { app, session, readCalls } = await setup();
    try {
      for (const query of ["offset=-1", "offset=1.5", "offset=abc", "limit=-2", "limit=0.5", "limit=xyz"]) {
        const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/content?path=a.txt&${query}` });
        expect(res.statusCode, query).toBe(400);
      }
      expect(readCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/sessions/:id/files/raw 图片预览（阶段 2e）", () => {
  it("白名单扩展名按 MIME 直出二进制，带 nosniff + attachment 安全头", async () => {
    const { app, session } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/raw?path=assets/icon.png` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toBe("attachment");
      expect(res.headers["x-owc-truncated"]).toBeUndefined();
      expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
      // 大小写不敏感 + svg 在白名单内
      const svg = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/raw?path=icon.SVG` });
      expect(svg.statusCode).toBe(200);
      expect(svg.headers["content-type"]).toContain("image/svg+xml");
    } finally {
      await app.close();
    }
  });

  it("白名单外扩展名 415；缺 path 400；未知会话 404", async () => {
    const { app, session } = await setup();
    try {
      for (const name of ["a.txt", "b.exe", "c.html", "noext"]) {
        const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/raw?path=${name}` });
        expect(res.statusCode, name).toBe(415);
      }
      expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/raw` })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/files/raw?path=a.png" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("core 截断时仍返回前缀内容并带 X-Owc-Truncated: 1", async () => {
    const { app, session } = await setup({ readBase64Result: { base64: PNG_BYTES.toString("base64"), size: PNG_BYTES.length, truncated: true } });
    try {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/raw?path=big.jpg` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/jpeg");
      expect(res.headers["x-owc-truncated"]).toBe("1");
      expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("老 core 无 readFileBase64 能力时 501", async () => {
    const { app, session } = await setup({ withReadBase64: false });
    try {
      const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files/raw?path=icon.png` });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toContain("not supported");
    } finally {
      await app.close();
    }
  });
});
