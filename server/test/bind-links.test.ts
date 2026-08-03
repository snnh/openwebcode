import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient, CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { CoreRouter } from "../src/sandbox/core-router.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";
import { FAKE_CORE_INFO } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

function coreInfo(bindLink: boolean): CoreInfo {
  return { ...FAKE_CORE_INFO, features: { ...FAKE_CORE_INFO.features, bindLink } };
}

async function fixture(bindLink: boolean) {
  const root = await tempRoot("owc-bind-links-");
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
  const core = { ping: async () => coreInfo(bindLink) } as unknown as CoreClient;
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, app };
}

const validBindLinks = (root: string) => [{ virtPath: path.join(root, "bound"), backingPath: root, readOnly: true }];

describe("POST /api/sessions bindLinks", () => {
  it("接受合法 bindLinks 并持久化进会话沙盒策略", async () => {
    const setup = await fixture(true);
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "test-stub", model: "m", bindLinks: validBindLinks(setup.root) } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ sandbox: { bindLinks: validBindLinks(setup.root) } });
      const stored = await setup.sessions.get(response.json<{ id: string }>().id);
      expect(stored?.sandbox?.bindLinks).toEqual(validBindLinks(setup.root));
    } finally {
      await setup.app.close();
    }
  });

  it("拒绝非法形状（未知字段/空路径/错误类型/超上限）", async () => {
    const setup = await fixture(true);
    try {
      const cases: unknown[] = [
        "nope",
        [{ virtPath: "D:\\a", backingPath: "D:\\b", oops: 1 }],
        [{ virtPath: "", backingPath: "D:\\b" }],
        [{ virtPath: "D:\\a" }],
        [{ virtPath: "D:\\a", backingPath: "D:\\b", readOnly: "yes" }],
        Array.from({ length: 17 }, () => ({ virtPath: "D:\\a", backingPath: "D:\\b" })),
      ];
      for (const bindLinks of cases) {
        const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "test-stub", model: "m", bindLinks } });
        expect(response.statusCode).toBe(400);
      }
    } finally {
      await setup.app.close();
    }
  });

  it("core 未上报 features.bindLink 时返回明确错误", async () => {
    const setup = await fixture(false);
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "test-stub", model: "m", bindLinks: validBindLinks(setup.root) } });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("Bind Link");
    } finally {
      await setup.app.close();
    }
  });

  it("bindLinks 与 wsb 模式组合被拒绝", async () => {
    const setup = await fixture(true);
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "test-stub", model: "m", sandboxMode: "wsb", bindLinks: validBindLinks(setup.root) } });
      expect(response.statusCode).toBe(400);
    } finally {
      await setup.app.close();
    }
  });
});

describe("GET /api/sandbox/capabilities bindLink", () => {
  it("响应携带 server 运行平台 platform 字段", async () => {
    const setup = await fixture(true);
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/sandbox/capabilities" });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ platform: string }>().platform).toBe(process.platform);
    } finally {
      await setup.app.close();
    }
  });

  it("core 上报 features.bindLink 时 available 为 true", async () => {
    const setup = await fixture(true);
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/sandbox/capabilities" });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ bindLink: { available: boolean } }>().bindLink.available).toBe(true);
    } finally {
      await setup.app.close();
    }
  });

  it("core 未上报 features.bindLink 时 available 为 false 且带原因", async () => {
    const setup = await fixture(false);
    try {
      const response = await setup.app.inject({ method: "GET", url: "/api/sandbox/capabilities" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ bindLink: { available: boolean; reason?: string } }>();
      expect(body.bindLink.available).toBe(false);
      expect(body.bindLink.reason).toContain("Bind Link");
    } finally {
      await setup.app.close();
    }
  });
});

describe("CoreRouter.policyFor bindLinks", () => {
  const policy: SandboxPolicy = {
    enabled: true,
    readRoots: ["D:\\work"],
    writeRoots: ["D:\\work"],
    denyPaths: [],
    network: "allow",
    bindLinks: [{ virtPath: "D:\\work\\bound", backingPath: "D:\\shared", readOnly: true }],
  };
  const meta = (sandboxMode?: SessionMeta["sandboxMode"]): SessionMeta => ({
    id: "s1",
    cwd: "D:\\work",
    provider: "test-stub",
    model: "m",
    title: "s1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(sandboxMode ? { sandboxMode } : {}),
  });

  it("jobobject（默认）/appcontainer/off 模式透传 bindLinks", () => {
    expect(CoreRouter.policyFor(meta(undefined), policy).bindLinks).toEqual(policy.bindLinks);
    expect(CoreRouter.policyFor(meta("jobobject"), policy).bindLinks).toEqual(policy.bindLinks);
    expect(CoreRouter.policyFor(meta("appcontainer"), policy).bindLinks).toEqual(policy.bindLinks);
    const off = CoreRouter.policyFor(meta("off"), policy);
    expect(off.enabled).toBe(false);
    expect(off.bindLinks).toEqual(policy.bindLinks);
  });

  it("wsb 模式剥离 bindLinks（宿主路径在 VM 内无效）", () => {
    const routed = CoreRouter.policyFor(meta("wsb"), policy);
    expect(routed.enabled).toBe(false);
    expect(routed.bindLinks).toBeUndefined();
  });
});
