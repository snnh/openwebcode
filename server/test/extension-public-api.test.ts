import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { ExtensionPermission } from "../src/extensions/types.js";
import { FastModelClient } from "../src/fast-model.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { resolveSessionPersona } from "../src/sessions/extension-state.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** storage 代理工具：把 ctx.storage.* 暴露成 ext__ 工具，驱动 host→server 存储 API 往返。 */
const STORAGE_ENTRY = `
export function activate(api) {
  api.registerTool({ name: "swrite", description: "x" }, async (input) => JSON.stringify(await api.storage.write(String(input.path), String(input.content))));
  api.registerTool({ name: "sread", description: "x" }, async (input) => JSON.stringify(await api.storage.read(String(input.path))));
  api.registerTool({ name: "sdelete", description: "x" }, async (input) => JSON.stringify(await api.storage.delete(String(input.path))));
  api.registerTool({ name: "slist", description: "x" }, async (input) => JSON.stringify(await api.storage.list(input.prefix === undefined ? undefined : String(input.prefix))));
}
`;

/** 路由 fixture：GET/POST 回显 + 一个永不 resolve 的 hang 路由。 */
const ROUTE_ENTRY = `
export function activate(api) {
  api.registerRoute("GET", "/echo", (request) => ({ status: 200, body: { query: request.query } }));
  api.registerRoute("POST", "/echo", (request) => ({ status: 201, body: { echoed: request.body } }));
  api.registerRoute("GET", "/hang", () => new Promise(() => {}));
}
`;

const ROUTE_DECLARATIONS = [
  { method: "GET", path: "/echo" },
  { method: "POST", path: "/echo" },
  { method: "GET", path: "/hang" },
];

/** model.complete 代理工具。 */
const MODEL_ENTRY = `
export function activate(api) {
  api.registerTool({ name: "mcall", description: "x" }, async (input) =>
    JSON.stringify(await api.model.complete({ prompt: String(input.prompt ?? ""), ...(input.maxTokens !== undefined ? { maxTokens: Number(input.maxTokens) } : {}) })));
}
`;

interface FixtureOptions {
  id?: string;
  permissions: ExtensionPermission[];
  entry: string;
  manifestExtra?: Record<string, unknown>;
}

async function installFixture(manager: ExtensionManager, root: string, options: FixtureOptions): Promise<string> {
  const id = options.id ?? "sample";
  const source = path.join(root, `fixture-src-${id}`);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    id, name: id, version: "1.0.0", description: "test fixture", apiVersion: "1", permissions: options.permissions, entry: "index.js", ...(options.manifestExtra ?? {}),
  }), "utf8");
  await writeFile(path.join(source, "index.js"), options.entry, "utf8");
  await manager.install(source);
  return id;
}

async function setupManager(options: { fastModel?: FastModelClient; storageQuota?: { file: number; total: number } } = {}) {
  const root = await tempRoot("owc-extpub-");
  const events = new EventBus();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const manager = new ExtensionManager(path.join(root, "data"), events, {
    sessions,
    ...(options.fastModel ? { fastModel: options.fastModel } : {}),
    ...(options.storageQuota ? { storageQuota: options.storageQuota } : {}),
  });
  await manager.initialize();
  return { root, events, sessions, manager };
}

describe("extension storage api", () => {
  it("round-trips write/read/list/delete inside the extension private directory", async () => {
    const { manager, root } = await setupManager();
    try {
      await installFixture(manager, root, { permissions: ["tools:register"], entry: STORAGE_ENTRY });
      await manager.configure("sample", { enabled: true });
      await manager.invokeTool("ext__sample__swrite", { path: "notes/a.json", content: "{\"a\":1}" });
      await manager.invokeTool("ext__sample__swrite", { path: "b.txt", content: "hello" });
      expect(JSON.parse((await manager.invokeTool("ext__sample__sread", { path: "notes/a.json" })).content)).toEqual({ content: "{\"a\":1}" });
      expect(JSON.parse((await manager.invokeTool("ext__sample__slist", {})).content)).toEqual({ files: ["b.txt", "notes/a.json"] });
      expect(JSON.parse((await manager.invokeTool("ext__sample__slist", { prefix: "notes/" })).content)).toEqual({ files: ["notes/a.json"] });
      expect(JSON.parse((await manager.invokeTool("ext__sample__sdelete", { path: "b.txt" })).content)).toEqual({ deleted: true });
      expect(JSON.parse((await manager.invokeTool("ext__sample__sread", { path: "b.txt" })).content)).toEqual({ content: null });
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("rejects absolute paths and .. escapes", async () => {
    const { manager, root } = await setupManager();
    try {
      await installFixture(manager, root, { permissions: ["tools:register"], entry: STORAGE_ENTRY });
      await manager.configure("sample", { enabled: true });
      await expect(manager.invokeTool("ext__sample__swrite", { path: "../evil.txt", content: "x" })).rejects.toThrow(/escapes|relative/);
      await expect(manager.invokeTool("ext__sample__sread", { path: "a/../../evil.txt" })).rejects.toThrow(/escapes|relative/);
      await expect(manager.invokeTool("ext__sample__swrite", { path: "C:/temp/evil.txt", content: "x" })).rejects.toThrow(/escapes|relative/);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("enforces per-file and total quotas", async () => {
    const { manager, root } = await setupManager({ storageQuota: { file: 64, total: 128 } });
    try {
      await installFixture(manager, root, { permissions: ["tools:register"], entry: STORAGE_ENTRY });
      await manager.configure("sample", { enabled: true });
      await expect(manager.invokeTool("ext__sample__swrite", { path: "big.txt", content: "x".repeat(65) })).rejects.toThrow(/per-file limit/);
      await manager.invokeTool("ext__sample__swrite", { path: "a.txt", content: "x".repeat(64) });
      await manager.invokeTool("ext__sample__swrite", { path: "b.txt", content: "y".repeat(64) });
      await expect(manager.invokeTool("ext__sample__swrite", { path: "c.txt", content: "z" })).rejects.toThrow(/total quota/);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("isolates directories between extensions", async () => {
    const { manager, root } = await setupManager();
    try {
      await installFixture(manager, root, { id: "alpha", permissions: ["tools:register"], entry: STORAGE_ENTRY });
      await installFixture(manager, root, { id: "beta", permissions: ["tools:register"], entry: STORAGE_ENTRY });
      await manager.configure("alpha", { enabled: true });
      await manager.configure("beta", { enabled: true });
      await manager.invokeTool("ext__alpha__swrite", { path: "secret.txt", content: "alpha-only" });
      expect(JSON.parse((await manager.invokeTool("ext__beta__sread", { path: "secret.txt" })).content)).toEqual({ content: null });
      expect(JSON.parse((await manager.invokeTool("ext__beta__slist", {})).content)).toEqual({ files: [] });
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("extension http routes", () => {
  async function setupRouteApp() {
    const harness = await setupManager();
    await installFixture(harness.manager, harness.root, { permissions: ["http:route", "tools:register"], entry: ROUTE_ENTRY, manifestExtra: { routes: ROUTE_DECLARATIONS } });
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub"));
    const pricing = new PricingCatalog(path.join(harness.root, "pricing.json"));
    await pricing.initialize();
    // 路由转发不需要 agent；buildServer 依赖面里 agent 仅用于其余路由，最小 stub 即可
    const app = await buildServer({
      core: { request: async () => ({}), configureSession: async () => undefined } as never,
      sessions: harness.sessions,
      agent: { isRunning: () => false } as never,
      events: harness.events,
      providers,
      pricing,
      extensions: harness.manager,
    });
    return { ...harness, app };
  }

  it("forwards declared routes to the host and round-trips status/body", async () => {
    const { manager, app } = await setupRouteApp();
    try {
      await manager.configure("sample", { enabled: true });
      const get = await app.inject({ method: "GET", url: "/api/ext/sample/echo?a=1&b=two" });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ query: { a: "1", b: "two" } });
      const post = await app.inject({ method: "POST", url: "/api/ext/sample/echo", payload: { hello: "world" } });
      expect(post.statusCode).toBe(201);
      expect(post.json()).toEqual({ echoed: { hello: "world" } });
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);

  it("rejects install when routes are declared without http:route", async () => {
    const { manager, root } = await setupManager();
    try {
      await expect(installFixture(manager, root, { permissions: [], entry: ROUTE_ENTRY, manifestExtra: { routes: ROUTE_DECLARATIONS } }))
        .rejects.toThrow(/http:route/);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("returns 404 for undeclared routes and 503 for disabled extensions", async () => {
    const { manager, app } = await setupRouteApp();
    try {
      await manager.configure("sample", { enabled: true });
      expect((await app.inject({ method: "GET", url: "/api/ext/sample/missing" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/ext/unknown-ext/echo" })).statusCode).toBe(404);
      await manager.configure("sample", { enabled: false });
      expect((await app.inject({ method: "GET", url: "/api/ext/sample/echo" })).statusCode).toBe(503);
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);

  it("returns 504 when the host handler never resolves", async () => {
    const { manager, app } = await setupRouteApp();
    try {
      await manager.configure("sample", { enabled: true });
      const response = await app.inject({ method: "GET", url: "/api/ext/sample/hang" });
      expect(response.statusCode).toBe(504);
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);
});

describe("extension model.complete", () => {
  function makeFastModel(root: string, record: { maxTokens?: number }) {
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* (request) {
      record.maxTokens = request.maxTokens;
      yield { type: "text_delta", text: "fast answer" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
    }));
    void root;
    return new FastModelClient(providers, { provider: "test-stub", model: "fast-m", maxTokens: 4096 });
  }

  it("completes through the fast model and caps maxTokens at 4096", async () => {
    const record: { maxTokens?: number } = {};
    const { manager, root } = await setupManager({ fastModel: makeFastModel("", record) });
    try {
      await installFixture(manager, root, { permissions: ["tools:register", "model:fast"], entry: MODEL_ENTRY });
      await manager.configure("sample", { enabled: true });
      const result = JSON.parse((await manager.invokeTool("ext__sample__mcall", { prompt: "hi", maxTokens: 99999 })).content) as { text: string };
      expect(result.text).toBe("fast answer");
      expect(record.maxTokens).toBe(4096);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("rejects prompts over 32 KiB", async () => {
    const record: { maxTokens?: number } = {};
    const { manager, root } = await setupManager({ fastModel: makeFastModel("", record) });
    try {
      await installFixture(manager, root, { permissions: ["tools:register", "model:fast"], entry: MODEL_ENTRY });
      await manager.configure("sample", { enabled: true });
      await expect(manager.invokeTool("ext__sample__mcall", { prompt: "x".repeat(33 * 1024) })).rejects.toThrow(/32|prompt exceeds/);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("rejects extensions without model:fast", async () => {
    const record: { maxTokens?: number } = {};
    const { manager, root } = await setupManager({ fastModel: makeFastModel("", record) });
    try {
      await installFixture(manager, root, { permissions: ["tools:register"], entry: MODEL_ENTRY });
      await manager.configure("sample", { enabled: true });
      await expect(manager.invokeTool("ext__sample__mcall", { prompt: "hi" })).rejects.toThrow(/model:fast/);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("fails clearly when the fast model is not configured", async () => {
    const { manager, root } = await setupManager({ fastModel: new FastModelClient(new ProviderRegistry()) });
    try {
      await installFixture(manager, root, { permissions: ["tools:register", "model:fast"], entry: MODEL_ENTRY });
      await manager.configure("sample", { enabled: true });
      await expect(manager.invokeTool("ext__sample__mcall", { prompt: "hi" })).rejects.toThrow(/not configured|未配置/);
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("extension prompt/tool shaping", () => {
  it("applies toolShaping from a third-party extension with tools:shaping", async () => {
    const { manager, root } = await setupManager();
    try {
      await installFixture(manager, root, {
        permissions: ["tools:shaping"],
        entry: "export function activate() {}\n",
        manifestExtra: { toolShaping: { hideBuiltIns: ["read_file"], aliases: [{ from: "bash", as: "Bash" }] } },
      });
      // 未启用不生效
      expect(await manager.activeToolShaping(["bash", "read_file"])).toBeUndefined();
      await manager.configure("sample", { enabled: true });
      const shaping = await manager.activeToolShaping(["bash", "read_file"]);
      expect(shaping?.hideBuiltIns.has("read_file")).toBe(true);
      expect(shaping?.aliases.get("Bash")).toMatchObject({ from: "bash" });
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("rejects third-party toolShaping without tools:shaping", async () => {
    const { manager, root } = await setupManager();
    try {
      await expect(installFixture(manager, root, {
        permissions: [],
        entry: "export function activate() {}\n",
        manifestExtra: { toolShaping: { aliases: [{ from: "bash", as: "Bash" }] } },
      })).rejects.toThrow(/tools:shaping/);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("runs prompt.beforeBuild for extensions with prompt:shape and passes extensionState", async () => {
    const { manager, root } = await setupManager();
    try {
      await installFixture(manager, root, {
        permissions: ["prompt:shape"],
        entry: `
export function activate(api) {
  api.on("prompt.beforeBuild", (payload) => {
    const note = payload.extensionState?.sample?.note;
    return { prependSections: ["## shaped" + (typeof note === "string" ? ":" + note : "")] };
  });
}
`,
      });
      await manager.configure("sample", { enabled: true });
      const result = await manager.transformPrompt(
        { sessionId: "s1", cwd: "C:/w", identity: "id", basePrompt: "base", productSections: [], extensionState: { sample: { note: "hi" } } },
      );
      expect(result.prependSections).toEqual(["## shaped:hi"]);
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("marks an extension error when it hooks prompt.beforeBuild without prompt:shape", async () => {
    const { manager, root } = await setupManager();
    try {
      await installFixture(manager, root, {
        permissions: [],
        entry: "export function activate(api) { api.on('prompt.beforeBuild', () => ({})); }\n",
      });
      const info = await manager.configure("sample", { enabled: true });
      expect(info.status).toBe("error");
      expect(info.error).toContain("prompt:shape");
    } finally {
      await manager.close();
    }
  }, 20_000);
});

describe("session extensionState", () => {
  async function setupSessionApp() {
    const harness = await setupManager();
    await installFixture(harness.manager, harness.root, { permissions: ["tools:register"], entry: STORAGE_ENTRY });
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub"));
    const pricing = new PricingCatalog(path.join(harness.root, "pricing.json"));
    await pricing.initialize();
    const app = await buildServer({
      core: { request: async () => ({}), configureSession: async () => undefined } as never,
      sessions: harness.sessions,
      agent: { isRunning: () => false } as never,
      events: harness.events,
      providers,
      pricing,
      extensions: harness.manager,
    });
    const session = await harness.sessions.create({ cwd: harness.root, provider: "test-stub", model: "m1", title: "t" });
    return { ...harness, app, session };
  }

  it("patches extensionState with validation and exposes it via GET", async () => {
    const { manager, app, session, sessions } = await setupSessionApp();
    try {
      // 未知扩展 id 拒绝
      expect((await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { extensionState: { "no-such-ext": {} } } })).statusCode).toBe(400);
      // 非对象 value 拒绝
      expect((await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { extensionState: { sample: "nope" } } })).statusCode).toBe(400);
      // 合法补丁：写入并透出
      const ok = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { extensionState: { sample: { note: "hi" } } } });
      expect(ok.statusCode).toBe(200);
      const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      expect((detail.json() as { extensionState?: Record<string, unknown> }).extensionState).toEqual({ sample: { note: "hi" } });
      // null 清除
      expect((await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { extensionState: { sample: null } } })).statusCode).toBe(200);
      expect((await sessions.get(session.id))?.extensionState).toBeUndefined();
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);

  it("prefers extensionState env-sim persona over the legacy persona field", async () => {
    const { manager, app, session } = await setupSessionApp();
    try {
      // 单元级：helper 优先级
      expect(resolveSessionPersona({ persona: "codex", extensionState: { "env-sim": { persona: "zcode" } } })).toBe("zcode");
      expect(resolveSessionPersona({ persona: "codex" })).toBe("codex");
      expect(resolveSessionPersona({ persona: "codex", extensionState: { "env-sim": { persona: "  " } } })).toBe("codex");
      // REST 级：activePersona 走同一解析
      await manager.configure("env-sim", { enabled: true });
      expect((await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { persona: "codex" } })).statusCode).toBe(200);
      let detail = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json() as { activePersona?: { id: string } | null };
      expect(detail.activePersona?.id).toBe("codex");
      expect((await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload: { extensionState: { "env-sim": { persona: "zcode" } } } })).statusCode).toBe(200);
      detail = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json() as { activePersona?: { id: string } | null };
      expect(detail.activePersona?.id).toBe("zcode");
    } finally {
      await app.close();
      await manager.close();
    }
  }, 20_000);
});
