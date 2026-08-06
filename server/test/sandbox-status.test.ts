import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { FAKE_CORE_INFO, makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function fixture(options?: {
  platform?: NodeJS.Platform;
  features?: CoreInfo["features"];
  sandboxStatusFor?: (sessionId: string) => { capability: string; reason?: string; at: number } | undefined;
}) {
  const root = await tempRoot("owc-sandbox-status-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("test-stub", async function* () {
    yield { type: "done", stopReason: "end_turn" };
  }));
  const events = new EventBus();
  const agent = { isRunning: () => false } as AgentRunner;
  const core = makeFakeCore({
    async ping() { return { ...FAKE_CORE_INFO, ...(options?.features ? { features: options.features } : {}) }; },
    ...(options?.sandboxStatusFor ? { sandboxStatusFor: options.sandboxStatusFor } : {}),
  });
  const app = await buildServer({
    core, sessions, agent, events, providers, pricing,
    ...(options?.platform ? { platform: options.platform } : {}),
  });
  return { root, sessions, app };
}

async function createSession(setup: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  return setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "test-stub", model: "m", ...extra } });
}

describe("GET /api/sandbox/capabilities bwrap", () => {
  it("core 未上报 features.bwrap 时返回 available: false", async () => {
    const setup = await fixture();
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/sandbox/capabilities" });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ bwrap: { available: boolean } }>().bwrap).toEqual({ available: false });
    } finally {
      await setup.app.close();
    }
  });

  it("core 上报 features.bwrap 时透传 available 与 reason", async () => {
    const features = { ...FAKE_CORE_INFO.features, bwrap: { available: false, reason: "bubblewrap not installed" } };
    const setup = await fixture({ features });
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/sandbox/capabilities" });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ bwrap: { available: boolean; reason?: string } }>().bwrap).toEqual({ available: false, reason: "bubblewrap not installed" });
    } finally {
      await setup.app.close();
    }
  });
});

describe("sandboxMode 平台门禁", () => {
  it("linux 接受 landlock/bubblewrap/off，拒绝 Windows 专属模式", async () => {
    const setup = await fixture({ platform: "linux" });
    try {
      for (const sandboxMode of ["landlock", "bubblewrap", "off"]) {
        const response = await createSession(setup, { sandboxMode });
        expect(response.statusCode, sandboxMode).toBe(201);
      }
      for (const sandboxMode of ["appcontainer", "jobobject", "wsb"]) {
        const response = await createSession(setup, { sandboxMode });
        expect(response.statusCode, sandboxMode).toBe(400);
      }
    } finally {
      await setup.app.close();
    }
  });

  it("win32 拒绝 landlock/bubblewrap", async () => {
    const setup = await fixture({ platform: "win32" });
    try {
      for (const sandboxMode of ["landlock", "bubblewrap"]) {
        const response = await createSession(setup, { sandboxMode });
        expect(response.statusCode, sandboxMode).toBe(400);
      }
      const off = await createSession(setup, { sandboxMode: "off" });
      expect(off.statusCode).toBe(201);
    } finally {
      await setup.app.close();
    }
  });
});

describe("sandbox.network 校验与持久化", () => {
  it("创建会话时持久化 network 策略（deny）", async () => {
    const setup = await fixture();
    try {
      const response = await createSession(setup, { network: "deny" });
      expect(response.statusCode).toBe(201);
      const stored = await setup.sessions.get(response.json<{ id: string }>().id);
      expect(stored?.sandbox?.network).toBe("deny");
    } finally {
      await setup.app.close();
    }
  });

  it("非法 network 取值 400", async () => {
    const setup = await fixture();
    try {
      const response = await createSession(setup, { network: "sometimes" });
      expect(response.statusCode).toBe(400);
    } finally {
      await setup.app.close();
    }
  });

  it("filtered 仅 win32 接受；POSIX 创建与更新均 400", async () => {
    const win = await fixture({ platform: "win32" });
    try {
      const response = await createSession(win, { network: "filtered" });
      expect(response.statusCode).toBe(201);
      const stored = await win.sessions.get(response.json<{ id: string }>().id);
      expect(stored?.sandbox?.network).toBe("filtered");
    } finally {
      await win.app.close();
    }

    const linux = await fixture({ platform: "linux" });
    try {
      const created = await createSession(linux, { network: "filtered" });
      expect(created.statusCode).toBe(400);
      const ok = await createSession(linux);
      const id = ok.json<{ id: string }>().id;
      const updated = await linux.app.inject({ method: "PUT", url: `/api/sessions/${id}/config`, payload: { network: "filtered" } });
      expect(updated.statusCode).toBe(400);
    } finally {
      await linux.app.close();
    }
  });

  it("config 路由 network-only 更新持久化且保留既有 sandboxMode", async () => {
    const setup = await fixture({ platform: "linux" });
    try {
      const created = await createSession(setup, { sandboxMode: "bubblewrap" });
      expect(created.statusCode).toBe(201);
      const id = created.json<{ id: string }>().id;
      const updated = await setup.app.inject({ method: "PUT", url: `/api/sessions/${id}/config`, payload: { network: "deny" } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ sandboxMode: "bubblewrap", sandbox: { network: "deny" } });
      const stored = await setup.sessions.get(id);
      expect(stored?.sandboxMode).toBe("bubblewrap");
      expect(stored?.sandbox?.network).toBe("deny");
    } finally {
      await setup.app.close();
    }
  });
});

describe("GET /api/sessions/:id/sandbox-status", () => {
  it("会话不存在返回 404", async () => {
    const setup = await fixture();
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/sandbox-status" });
      expect(response.statusCode).toBe(404);
    } finally {
      await setup.app.close();
    }
  });

  it("core 无记录时返回空对象（200）", async () => {
    const setup = await fixture();
    try {
      const created = await createSession(setup);
      const id = created.json<{ id: string }>().id;
      const response = await setup.app.inject({ method: "GET", url: `/api/sessions/${id}/sandbox-status` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});
    } finally {
      await setup.app.close();
    }
  });

  it("有记录时返回 sandboxCapability 与 sandboxReason", async () => {
    const setup = await fixture({ sandboxStatusFor: () => ({ capability: "enforced", reason: "landlock active", at: 1 }) });
    try {
      const created = await createSession(setup);
      const id = created.json<{ id: string }>().id;
      const response = await setup.app.inject({ method: "GET", url: `/api/sessions/${id}/sandbox-status` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ sandboxCapability: "enforced", sandboxReason: "landlock active" });
    } finally {
      await setup.app.close();
    }
  });
});
