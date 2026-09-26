import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const opened: Array<{ app: { close(): Promise<unknown> } }> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((setup) => setup.app.close().catch(() => undefined)));
});

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
  const core = makeFakeCore({
    async ping() { return { ...FAKE_CORE_INFO, ...(options?.features ? { features: options.features } : {}) }; },
    ...(options?.sandboxStatusFor ? { sandboxStatusFor: options.sandboxStatusFor } : {}),
  });
  const app = await buildServer({
    core, sessions, agent: { isRunning: () => false } as AgentRunner, events: new EventBus(), providers, pricing,
    ...(options?.platform ? { platform: options.platform } : {}),
  });
  const setup = { root, sessions, app };
  opened.push(setup);
  return setup;
}

function createSession(setup: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  return setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "test-stub", model: "m", ...extra } });
}

describe("GET /api/sandbox/capabilities bwrap", () => {
  it("core 未上报 features.bwrap 时按不可用处理；上报时透传 available 与 reason", async () => {
    const plain = await fixture();
    const response = await plain.app.inject({ method: "GET", url: "/api/sandbox/capabilities" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ bwrap: { available: boolean } }>().bwrap).toEqual({ available: false });

    const reported = await fixture({ features: { ...FAKE_CORE_INFO.features, bwrap: { available: false, reason: "bubblewrap not installed" } } });
    const withReason = await reported.app.inject({ method: "GET", url: "/api/sandbox/capabilities" });
    expect(withReason.json<{ bwrap: { available: boolean; reason?: string } }>().bwrap).toMatchObject({ available: false, reason: "bubblewrap not installed" });
  });
});

describe("sandboxMode 平台门禁", () => {
  it("linux 接受 landlock/bubblewrap/off 且拒绝 Windows 专属模式；win32 拒绝 landlock/bubblewrap", async () => {
    const linux = await fixture({ platform: "linux" });
    for (const sandboxMode of ["landlock", "bubblewrap", "off"]) {
      expect((await createSession(linux, { sandboxMode })).statusCode, sandboxMode).toBe(201);
    }
    for (const sandboxMode of ["appcontainer", "jobobject", "wsb"]) {
      expect((await createSession(linux, { sandboxMode })).statusCode, sandboxMode).toBe(400);
    }

    const win = await fixture({ platform: "win32" });
    for (const sandboxMode of ["landlock", "bubblewrap"]) {
      expect((await createSession(win, { sandboxMode })).statusCode, sandboxMode).toBe(400);
    }
    expect((await createSession(win, { sandboxMode: "off" })).statusCode).toBe(201);
  });
});

describe("sandbox.network 校验与持久化", () => {
  it("deny 落盘；非法取值 400；filtered 仅 win32 接受（POSIX 创建与更新均 400）", async () => {
    const setup = await fixture();
    const created = await createSession(setup, { network: "deny" });
    expect(created.statusCode).toBe(201);
    expect((await setup.sessions.get(created.json<{ id: string }>().id))?.sandbox?.network).toBe("deny");
    expect((await createSession(setup, { network: "sometimes" })).statusCode).toBe(400);

    const win = await fixture({ platform: "win32" });
    const filtered = await createSession(win, { network: "filtered" });
    expect(filtered.statusCode).toBe(201);
    expect((await win.sessions.get(filtered.json<{ id: string }>().id))?.sandbox?.network).toBe("filtered");

    const linux = await fixture({ platform: "linux" });
    expect((await createSession(linux, { network: "filtered" })).statusCode).toBe(400);
    const ok = await createSession(linux);
    expect((await linux.app.inject({ method: "PUT", url: `/api/sessions/${ok.json<{ id: string }>().id}/config`, payload: { network: "filtered" } })).statusCode).toBe(400);
  });

  it("config 路由 network-only 更新持久化且保留既有 sandboxMode", async () => {
    const setup = await fixture({ platform: "linux" });
    const created = await createSession(setup, { sandboxMode: "bubblewrap" });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const updated = await setup.app.inject({ method: "PUT", url: `/api/sessions/${id}/config`, payload: { network: "deny" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ sandboxMode: "bubblewrap", sandbox: { network: "deny" } });
    expect(await setup.sessions.get(id)).toMatchObject({ sandboxMode: "bubblewrap", sandbox: { network: "deny" } });
  });
});

describe("GET /api/sessions/:id/sandbox-status", () => {
  it("会话不存在返回 404；core 无记录时返回空对象（200）", async () => {
    const setup = await fixture();
    expect((await setup.app.inject({ method: "GET", url: "/api/sessions/00000000-0000-4000-8000-000000000000/sandbox-status" })).statusCode).toBe(404);
    const created = await createSession(setup);
    const response = await setup.app.inject({ method: "GET", url: `/api/sessions/${created.json<{ id: string }>().id}/sandbox-status` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it("有记录时返回 sandboxCapability 与 sandboxReason", async () => {
    const setup = await fixture({ sandboxStatusFor: () => ({ capability: "enforced", reason: "landlock active", at: 1 }) });
    const created = await createSession(setup);
    const response = await setup.app.inject({ method: "GET", url: `/api/sessions/${created.json<{ id: string }>().id}/sandbox-status` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sandboxCapability: "enforced", sandboxReason: "landlock active" });
  });
});
