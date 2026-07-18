import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CoreClientLike, CoreInfo } from "../src/core-client.js";
import { CoreRouter, toSandboxPath } from "../src/sandbox/core-router.js";
import { buildWsbConfig, detectWsb } from "../src/sandbox/wsb.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";

const info: CoreInfo = { version: "0.1.0", platform: "windows", sandboxCapability: "partial" };

function fakeClient(): CoreClientLike & { [key: string]: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  return {
    start: vi.fn(async () => info),
    stop: vi.fn(async () => undefined),
    ping: vi.fn(async () => info),
    run: vi.fn(async () => ({ exitCode: 0, durationMs: 1, truncated: false })),
    configureSession: vi.fn(async () => ({ sandboxCapability: "advisory" })),
    cleanupSession: vi.fn(async () => ({ ok: true as const })),
    readFile: vi.fn(async () => ({ content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false })),
    writeFile: vi.fn(async () => ({ ok: true as const })),
    editFile: vi.fn(async () => ({ matches: 0 })),
    listFiles: vi.fn(async () => ({ entries: [], truncated: false })),
    globFiles: vi.fn(async () => ({ paths: [], truncated: false })),
    grepFiles: vi.fn(async () => ({ matches: [], truncated: false })),
    setRequestTimeoutMs: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener)),
  };
}

function makeMeta(id: string, sandboxMode?: SessionMeta["sandboxMode"]): SessionMeta {
  return {
    id,
    cwd: "D:\\work",
    provider: "development",
    model: "deterministic-tool-loop",
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(sandboxMode ? { sandboxMode } : {}),
  };
}

const policy: SandboxPolicy = {
  enabled: true,
  readRoots: ["D:\\work"],
  writeRoots: ["D:\\work"],
  denyPaths: [],
  network: "allow",
};

function makeRouter(metas: Map<string, SessionMeta>, jobObject?: { memoryMB?: number; maxProcesses?: number }) {
  const shared = fakeClient();
  const wsbClient = fakeClient();
  const wsb = {
    acquire: vi.fn(async () => wsbClient),
    peek: vi.fn(() => wsbClient as CoreClientLike | undefined),
    release: vi.fn(async () => undefined),
    releaseAll: vi.fn(async () => undefined),
    onClientCreated: undefined as undefined | ((sessionId: string, client: CoreClientLike) => void),
  };
  const sessions = { get: async (id: string) => metas.get(id) };
  // CoreRouter 只用到 acquire/peek/release/releaseAll 与 onClientCreated 赋值
  const router = new CoreRouter(shared, sessions, wsb as never, jobObject);
  return { router, shared, wsbClient, wsb };
}

describe("buildWsbConfig", () => {
  it("generates mapped folders, logon command and networking without setupScript", () => {
    const xml = buildWsbConfig({ workspace: "D:\\dev\\demo", distDir: "D:\\dev\\openwebcode\\build\\Debug", hostIp: "192.168.1.10", port: 54321 });
    expect(xml).toMatchSnapshot();
  });

  it("inlines setupScript into the logon command and escapes XML", () => {
    const xml = buildWsbConfig({ workspace: "D:\\dev\\a&b<c>", distDir: "D:\\owc\\dist", hostIp: "10.0.0.2", port: 1, setupScript: "set A=1&& echo ready" });
    expect(xml).toContain('cmd /c "set A=1&amp;&amp; echo ready &amp;&amp; C:\\owc\\owc-exec.exe --connect 10.0.0.2:1"');
    expect(xml).toContain("<HostFolder>D:\\dev\\a&amp;b&lt;c&gt;</HostFolder>");
    expect(xml).toMatchSnapshot();
  });
});

describe("detectWsb", () => {
  it("reports available when WindowsSandbox.exe exists", () => {
    expect(detectWsb({ exists: () => true, systemRoot: "C:\\Windows" })).toEqual({ available: true });
  });

  it("reports unavailable with reason when missing", () => {
    const result = detectWsb({ exists: () => false, systemRoot: "C:\\Windows" });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("Windows Sandbox");
  });
});

describe("toSandboxPath", () => {
  it("maps the workspace root and children into the sandbox mount", () => {
    expect(toSandboxPath("D:\\work", "D:\\work")).toBe("C:\\owc-workspace");
    expect(toSandboxPath("D:\\work\\src\\a.ts", "D:\\work")).toBe("C:\\owc-workspace\\src\\a.ts");
  });

  it("tolerates forward slashes and case differences", () => {
    expect(toSandboxPath("d:/work/SRC/a.ts", "D:\\work")).toBe("C:\\owc-workspace\\SRC\\a.ts");
  });

  it("leaves paths outside the workspace unchanged", () => {
    expect(toSandboxPath("C:\\Windows\\system32", "D:\\work")).toBe("C:\\Windows\\system32");
    // 仅前缀相同但不是目录边界（D:\\work2 不在 D:\\work 下）
    expect(toSandboxPath("D:\\work2\\a.ts", "D:\\work")).toBe("D:\\work2\\a.ts");
  });
});

describe("CoreRouter", () => {
  it("routes wsb sessions to the sandbox client with sandbox disabled (VM is the boundary)", async () => {
    const metas = new Map([["s1", makeMeta("s1", "wsb")]]);
    const { router, shared, wsbClient, wsb } = makeRouter(metas);
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(wsb.acquire).toHaveBeenCalledWith("s1", metas.get("s1"));
    // 工作目录翻译为沙盒内挂载点，沙盒策略关闭（VM 即边界）
    expect(wsbClient.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "C:\\owc-workspace", sandbox: { ...policy, enabled: false } });
    expect(shared.configureSession).not.toHaveBeenCalled();
    await router.run({ sessionId: "s1", execId: "e1", cmd: "dir", cwd: "D:\\work" });
    expect(wsbClient.run).toHaveBeenCalledWith({ sessionId: "s1", execId: "e1", cmd: "dir", cwd: "C:\\owc-workspace" });
    expect(shared.run).not.toHaveBeenCalled();
  });

  it("translates fs request paths into the sandbox mount for wsb sessions", async () => {
    const metas = new Map([["s1", makeMeta("s1", "wsb")]]);
    const { router, wsbClient } = makeRouter(metas);
    await router.readFile({ sessionId: "s1", path: "D:\\work\\src\\a.ts" });
    expect(wsbClient.readFile).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\owc-workspace\\src\\a.ts" });
    await router.writeFile({ sessionId: "s1", path: "D:/work/b.md", content: "x" });
    expect(wsbClient.writeFile).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\owc-workspace\\b.md", content: "x" });
    // 工作目录外的路径原样透传（沙盒看不到，由沙盒内 core 拒绝）
    await router.listFiles({ sessionId: "s1", path: "C:\\Windows" });
    expect(wsbClient.listFiles).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\Windows" });
  });

  it("keeps non-wsb sessions on the shared client with the policy untouched", async () => {
    const metas = new Map([["s1", makeMeta("s1")]]);
    const { router, shared, wsb } = makeRouter(metas);
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(wsb.acquire).not.toHaveBeenCalled();
  });

  it("maps sandboxMode off to sandbox.enabled=false on the shared client", async () => {
    const metas = new Map([["s1", makeMeta("s1", "off")]]);
    const { router, shared } = makeRouter(metas);
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, enabled: false } });
  });

  it("maps sandboxMode jobobject to sandbox.mode=jobobject on the shared client", async () => {
    const metas = new Map([["s1", makeMeta("s1", "jobobject")]]);
    const { router, shared } = makeRouter(metas);
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, mode: "jobobject" } });
  });

  it("merges configured global jobObject limits into the jobobject policy", async () => {
    const metas = new Map([["s1", makeMeta("s1", "jobobject")]]);
    const { router, shared } = makeRouter(metas, { memoryMB: 2048, maxProcesses: 32 });
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, mode: "jobobject", jobMemoryMB: 2048, jobMaxProcesses: 32 } });
  });

  it("omits jobObject fields when no global limits are configured", async () => {
    const metas = new Map([["s1", makeMeta("s1", "jobobject")]]);
    const { router, shared } = makeRouter(metas);
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    const sent = shared.configureSession.mock.calls[0]?.[0]?.sandbox as Record<string, unknown>;
    expect("jobMemoryMB" in sent).toBe(false);
    expect("jobMaxProcesses" in sent).toBe(false);
  });

  it("applies global jobObject limits to appcontainer sessions as well (core enforces them in both modes)", async () => {
    const metas = new Map([["s1", makeMeta("s1")]]);
    const { router, shared } = makeRouter(metas, { maxProcesses: 16 });
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, jobMaxProcesses: 16 } });
  });

  it("cleanupSession on wsb sessions never boots a VM and skips the shared client", async () => {
    const metas = new Map([["s1", makeMeta("s1", "wsb")]]);
    const { router, shared, wsb, wsbClient } = makeRouter(metas);
    await router.cleanupSession("s1");
    expect(wsb.acquire).not.toHaveBeenCalled();
    expect(wsb.peek).toHaveBeenCalledWith("s1");
    expect(wsbClient.cleanupSession).toHaveBeenCalledWith("s1");
    expect(shared.cleanupSession).not.toHaveBeenCalled();
    await router.cleanupSession("missing");
    expect(shared.cleanupSession).toHaveBeenCalledWith("missing");
  });

  it("release delegates to the WsbManager", async () => {
    const { router, wsb } = makeRouter(new Map());
    await router.release("s1");
    expect(wsb.release).toHaveBeenCalledWith("s1");
  });
});
