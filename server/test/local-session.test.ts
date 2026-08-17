import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike, PathNormalizeRequest } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeTestApp } from "./helpers/test-app.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("local session (kind=local) store semantics", () => {
  it("persists kind, sandboxMode=off, and widens fs roots to the filesystem root while keeping denyPaths", async () => {
    const root = await tempRoot("owc-local-store-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m", kind: "local", sandboxMode: "off" });

    expect(session.kind).toBe("local");
    expect(session.sandboxMode).toBe("off");
    const fsRoot = path.parse(root).root;
    expect(session.sandbox?.readRoots).toEqual([fsRoot]);
    expect(session.sandbox?.writeRoots).toEqual([fsRoot]);
    // 默认 deny 三项保留（宿主执行入口保护）
    expect(session.sandbox?.denyPaths).toEqual([
      path.join(root, ".env"),
      path.join(root, ".owc", "hooks.json"),
      path.join(root, ".owc", "mcp.json"),
    ]);
    // 落盘一致（重载后仍在）
    const reloaded = new SessionStore(path.join(root, "sessions"));
    await reloaded.initialize();
    const detail = await reloaded.get(session.id);
    expect(detail?.kind).toBe("local");
    expect(detail?.sandboxMode).toBe("off");
    expect(detail?.sandbox?.readRoots).toEqual([fsRoot]);
  });

  it("keeps regular sessions on the cwd-scoped default policy", async () => {
    const root = await tempRoot("owc-local-store-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m" });
    expect(session.kind).toBeUndefined();
    expect(session.sandbox?.readRoots).toEqual([root]);
    expect(session.sandbox?.writeRoots).toEqual([root]);
  });

  it("normalizes imported local sessions: current HOME cwd, sandbox off, roots rebuilt, no workspace/snapshot preset", async () => {
    const root = await tempRoot("owc-local-store-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    // 模拟从别的机器导出的 local 会话：旧 HOME 路径、托管工作区、快照预设
    const jsonl = JSON.stringify({
      kind: "meta",
      version: 1,
      session: {
        id: undefined,
        cwd: "/old/machine/home",
        kind: "local",
        provider: "p",
        model: "m",
        title: "imported local",
        sandboxMode: "landlock",
        sandbox: { enabled: true, readRoots: ["/"], writeRoots: ["/"], denyPaths: ["/old/machine/home/.env"], network: "allow" },
        workspace: { mode: "managed", backend: "overlayfs", originCwd: "/old/machine/home", image: "x", mountPoint: "/mnt/x" },
        snapshotBackend: "overlayfs",
      },
    }) + "\n";
    const imported = await store.importJsonl(jsonl);

    expect(imported.kind).toBe("local");
    expect(imported.cwd).toBe(os.homedir());
    expect(imported.sandboxMode).toBe("off");
    const fsRoot = path.parse(os.homedir()).root;
    expect(imported.sandbox?.readRoots).toEqual([fsRoot]);
    expect(imported.sandbox?.writeRoots).toEqual([fsRoot]);
    // denyPaths 重建为当前 HOME 三项（非导入文件的旧路径）
    expect(imported.sandbox?.denyPaths).toEqual([
      path.join(os.homedir(), ".env"),
      path.join(os.homedir(), ".owc", "hooks.json"),
      path.join(os.homedir(), ".owc", "mcp.json"),
    ]);
    expect(imported.workspace).toBeUndefined();
    expect(imported.snapshotBackend).toBeUndefined();
  });
});

describe("local session REST creation", () => {
  it("creates with HOME cwd and sandbox off, ignoring any provided cwd", async () => {
    const { app, sessions } = await makeTestApp({
      configureProviders: (registry) => registry.register({
        name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; },
      } as Provider),
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { kind: "local", provider: "fake", model: "m", cwd: "/ignored/path" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; cwd: string; kind: string; sandboxMode: string };
      expect(body.kind).toBe("local");
      expect(body.cwd).toBe(os.homedir());
      expect(body.sandboxMode).toBe("off");
      expect(sessions.get(body.id)).resolves.toMatchObject({ kind: "local", cwd: os.homedir(), sandboxMode: "off" });
      // 列表可见
      const list = await app.inject({ method: "GET", url: "/api/sessions" });
      expect(list.json().some((item: { id: string }) => item.id === body.id)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects unknown kinds and requires cwd for regular sessions", async () => {
    const { app } = await makeTestApp({
      configureProviders: (registry) => registry.register({
        name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; },
      } as Provider),
    });
    try {
      const bogus = await app.inject({ method: "POST", url: "/api/sessions", payload: { kind: "bogus", provider: "fake", model: "m", cwd: os.tmpdir() } });
      expect(bogus.statusCode).toBe(400);
      const noCwd = await app.inject({ method: "POST", url: "/api/sessions", payload: { provider: "fake", model: "m" } });
      expect(noCwd.statusCode).toBe(400);
      // kind=local 不要求 cwd
      const local = await app.inject({ method: "POST", url: "/api/sessions", payload: { kind: "local", provider: "fake", model: "m" } });
      expect(local.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("rejects managed workspace for local sessions", async () => {
    const { app } = await makeTestApp({
      configureProviders: (registry) => registry.register({
        name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; },
      } as Provider),
    });
    try {
      const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { kind: "local", workspaceMode: "managed", provider: "fake", model: "m" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("本机会话不支持托管工作区");
    } finally {
      await app.close();
    }
  });

  it("rejects sandbox mode changes and snapshot operations for local sessions", async () => {
    const { app, sessions } = await makeTestApp({
      configureProviders: (registry) => registry.register({
        name: "fake", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; },
      } as Provider),
    });
    try {
      const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { kind: "local", provider: "fake", model: "m" } });
      const sessionId = (created.json() as { id: string }).id;
      // 沙盒切换被拒（含 setupScript-only 补丁）
      const config = await app.inject({ method: "PUT", url: `/api/sessions/${sessionId}/config`, payload: { sandboxMode: "landlock" } });
      expect(config.statusCode).toBe(400);
      expect(config.json().error).toContain("不能切换沙盒");
      const script = await app.inject({ method: "PUT", url: `/api/sessions/${sessionId}/config`, payload: { setupScript: "echo hi" } });
      expect(script.statusCode).toBe(400);
      // 快照操作被拒（不探测 HOME 后端）
      const checkpoints = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/checkpoints` });
      expect(checkpoints.statusCode).toBe(400);
      expect(checkpoints.json().error).toContain("不支持快照");
      const capability = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/snapshot-capability` });
      expect(capability.statusCode).toBe(400);
      // 会话仍在、配置未变
      const detail = await sessions.get(sessionId);
      expect(detail?.sandboxMode).toBe("off");
    } finally {
      await app.close();
    }
  });
});

/** 轮询 captured 等 permission.request 事件并取其 requestId（15s 超时；Windows CI 高负载下 5s 偶发不够）。 */
function waitForPermissionRequest(captured: AppEvent[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no permission.request within 15s")), 15_000);
    const check = (): void => {
      const req = captured.find((event) => event.type === "permission.request");
      if (req) {
        clearTimeout(timer);
        resolve((req.payload as { requestId: string }).requestId);
      } else setTimeout(check, 20);
    };
    check();
  });
}

/** 仿 core path.normalize 的确定性 canonicalize（保留绝对路径根：相对输入拼接的 cwd 也以 / 开头）。 */
function canonicalize(cwd: string, p: string): string {
  const isAbs = /^([A-Za-z]:[\\/]|[\\/])/.test(p);
  if (!isAbs && /(^|[\\/])\.\.([\\/]|$)/.test(p)) throw new Error("path cannot be normalized");
  const joined = isAbs ? p : `${cwd}/${p}`;
  const parts = joined.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  // 保留路径根：POSIX 绝对路径（/x 或拼入的绝对 cwd）补前导 /，Windows 盘符（C:）自带根不补
  const hasPosixRoot = /^([\\/])/.test(joined);
  const windowsDrive = /^[A-Za-z]:$/.test(parts[0] ?? "");
  const root = hasPosixRoot && !windowsDrive ? "/" : "";
  return root + parts.join("/");
}

function createCore(cwd: string, readCalls: string[]): CoreClientLike {
  return makeFakeCore({
    async readFile(request: { sessionId: string; path: string }) { readCalls.push(request.path); return { content: "file content", totalLines: 1, encoding: "utf-8", truncated: false }; },
    async normalizePath(request: PathNormalizeRequest) {
      return { path: canonicalize(cwd, request.path), allowed: true, root: cwd };
    },
  });
}

describe("local session path gate (authorizeTool)", () => {
  let homedirSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    homedirSpy?.mockRestore();
  });

  async function setup(home: string, toolCalls: Array<{ name: string; id: string; input: Record<string, unknown> }>) {
    // 将 homedir 指向临时目录，模拟「会话 cwd=HOME」而不触碰真实 HOME
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    const root = home;
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model", kind: "local", sandboxMode: "off" });
    await sessions.updatePermissions(session.id, "ask", []);

    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (event: AppEvent) => captured.push(event));
    const readCalls: string[] = [];
    const core = createCore(root, readCalls);
    let providerCalled = false;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request: StreamChatRequest) {
        void request;
        if (!providerCalled) {
          providerCalled = true;
          for (const tc of toolCalls) yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.input };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, events, pricing);
    return { runner, session, sessions, captured, readCalls };
  }

  it("gates read_file outside HOME: permission request → allow runs the call; allow_always persists a directory rule", async () => {
    const home = await tempRoot("owc-local-gate-");
    const { runner, session, sessions, captured, readCalls } = await setup(home, [
      { name: "read_file", id: "r-1", input: { path: "/etc/hosts" } },
      { name: "read_file", id: "r-2", input: { path: "/etc/hostname" } },
    ]);

    const runPromise = runner.run(session.id, "go");
    // 第一次 HOME 外读取挂起审批；allow_always 后规则按目录前缀落库
    const requestId = await waitForPermissionRequest(captured);
    const requestPayload = captured.find((event) => event.type === "permission.request")!.payload as { input: { path: string } };
    expect(requestPayload.input.path).toBe("/etc/hosts");
    const complete = await runner.preparePermissionResponse(session.id, requestId, "allow_always");
    expect(complete).toBeDefined();
    complete!();
    await runPromise;

    // 只挂起一次：第二个调用命中同一目录前缀规则免审批
    const requests = captured.filter((event) => event.type === "permission.request");
    expect(requests).toHaveLength(1);
    const detail = await sessions.get(session.id);
    expect(detail?.permissionRules).toEqual([{ tool: "read_file", argumentPrefix: "/etc" }]);
    // 两个 read 都执行到了 core
    expect(readCalls).toEqual(["/etc/hosts", "/etc/hostname"]);
  }, 15_000);

  it("does not gate paths inside HOME", async () => {
    const home = await tempRoot("owc-local-gate-");
    const { runner, session, sessions, captured, readCalls } = await setup(home, [
      { name: "read_file", id: "r-1", input: { path: "notes.txt" } },
    ]);

    await runner.run(session.id, "go");
    expect(captured.filter((event) => event.type === "permission.request")).toHaveLength(0);
    // 分隔符无关比较：Windows 下 home 是反斜杠、canonicalize 写回的 readCalls 是正斜杠
    const strip = (p: string): string => p.replace(/\\/g, "/");
    expect(readCalls.map(strip)).toEqual([strip(`${home}/notes.txt`)]);
    // HOME 内路径不落任何 allow 规则（无新增；初始为空数组或 undefined）
    const rules = (await sessions.get(session.id))?.permissionRules;
    expect(rules === undefined || rules.length === 0).toBe(true);
  }, 15_000);

  it("denies outside-HOME reads when the user denies", async () => {
    const home = await tempRoot("owc-local-gate-");
    const { runner, session, sessions, captured, readCalls } = await setup(home, [
      { name: "read_file", id: "r-1", input: { path: "/etc/hosts" } },
    ]);

    const runPromise = runner.run(session.id, "go");
    const requestId = await waitForPermissionRequest(captured);
    const complete = await runner.preparePermissionResponse(session.id, requestId, "deny", "用户拒绝");
    complete!();
    await runPromise;

    expect(readCalls).toHaveLength(0);
    const detail = await sessions.get(session.id);
    const toolResult = detail?.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "r-1");
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as { content: string }).content).toContain("未获允许");
  }, 15_000);

  it("does not gate regular (non-local) sessions", async () => {
    const home = await tempRoot("owc-local-gate-");
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    const root = await tempRoot("owc-local-regular-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (event: AppEvent) => captured.push(event));
    const readCalls: string[] = [];
    const core = createCore(root, readCalls);
    let providerCalled = false;
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        if (!providerCalled) {
          providerCalled = true;
          yield { type: "tool_call", id: "r-1", name: "read_file", input: { path: "/etc/hosts" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, events, pricing);

    await runner.run(session.id, "go");
    // 常规会话：read_file 白名单直接放行，不挂起、不落规则
    expect(captured.filter((event) => event.type === "permission.request")).toHaveLength(0);
    expect(readCalls).toEqual(["/etc/hosts"]);
  }, 15_000);
});
