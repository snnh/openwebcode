import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CoreClientLike, CoreInfo } from "../src/core-client.js";
import { CoreRouter, toSandboxPath } from "../src/sandbox/core-router.js";
import { buildWsbConfig, detectWsb } from "../src/sandbox/wsb.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";

const info: CoreInfo = { version: "0.2.3", platform: "windows", sandboxCapability: "partial" };

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
    writeFileBase64: vi.fn(async () => ({ ok: true as const })),
    editFile: vi.fn(async () => ({ matches: 0 })),
    statFile: vi.fn(async () => ({ type: "file" as const, size: 0, modifiedMs: 0 })),
    statFiles: vi.fn(async () => ({ entries: [] })),
    hashFile: vi.fn(async () => ({ sha256: "0".repeat(64), size: 0 })),
    scanFiles: vi.fn(async () => ({ entries: [], truncated: false })),
    watchFiles: vi.fn(async () => ({ watchId: 1 })),
    pollWatch: vi.fn(async () => ({ events: [], overflow: false })),
    cancelWatch: vi.fn(async () => ({ ok: true as const })),
    startJob: vi.fn(async () => ({ jobId: "j1", state: "running" as const })),
    cancelJob: vi.fn(async () => ({ jobId: "j1", accepted: true as const })),
    jobStatus: vi.fn(async () => ({ jobId: "j1", state: "completed" as const })),
    jobOutput: vi.fn(async () => ({ chunks: [], nextSeq: 0, truncated: false })),
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
    provider: "test-stub",
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

function makeRouter(metas: Map<string, SessionMeta>, jobObject?: { memoryMB?: number; maxProcesses?: number }, allowPaths?: string[]) {
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
  // CoreRouter 只用到 acquire/peek/release/releaseAll 与 onClientCreated 赋值；
  // 用例全是 Windows 路径与 WSB 场景，固定平台为 win32（缺省模式断言 jobobject 不因 CI 平台漂移）
  const router = new CoreRouter(shared, sessions, wsb as never, jobObject, allowPaths, "win32");
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
    await router.writeFileBase64({ sessionId: "s1", path: "D:/work/.owc/uploads/a.pdf", data: "JVBERi0=", createDirs: true });
    expect(wsbClient.writeFileBase64).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\owc-workspace\\.owc\\uploads\\a.pdf", data: "JVBERi0=", createDirs: true });
    await router.hashFile({ sessionId: "s1", path: "D:/work/src/a.ts" });
    expect(wsbClient.hashFile).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\owc-workspace\\src\\a.ts" });
    await router.statFiles({ sessionId: "s1", paths: ["D:/work/src/a.ts", "D:/work/b.md"] });
    expect(wsbClient.statFiles).toHaveBeenCalledWith({ sessionId: "s1", paths: ["C:\\owc-workspace\\src\\a.ts", "C:\\owc-workspace\\b.md"] });
    await router.scanFiles({ sessionId: "s1", path: "D:/work/src", limit: 8, maxDepth: 2 });
    expect(wsbClient.scanFiles).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\owc-workspace\\src", limit: 8, maxDepth: 2 });
    await router.watchFiles({ sessionId: "s1", path: "D:/work/src", recursive: true });
    expect(wsbClient.watchFiles).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\owc-workspace\\src", recursive: true });
    await router.pollWatch({ sessionId: "s1", watchId: 1 });
    expect(wsbClient.pollWatch).toHaveBeenCalledWith({ sessionId: "s1", watchId: 1 });
    await router.cancelWatch({ sessionId: "s1", watchId: 1 });
    expect(wsbClient.cancelWatch).toHaveBeenCalledWith({ sessionId: "s1", watchId: 1 });
    await router.startJob({ sessionId: "s1", jobId: "j1", kind: "exec", cmd: "dir", cwd: "D:/work" });
    expect(wsbClient.startJob).toHaveBeenCalledWith({ sessionId: "s1", jobId: "j1", kind: "exec", cmd: "dir", cwd: "C:\\owc-workspace" });
    await router.cancelJob({ sessionId: "s1", jobId: "j1" });
    expect(wsbClient.cancelJob).toHaveBeenCalledWith({ sessionId: "s1", jobId: "j1" });
    // 工作目录外的路径原样透传（沙盒看不到，由沙盒内 core 拒绝）
    await router.listFiles({ sessionId: "s1", path: "C:\\Windows" });
    expect(wsbClient.listFiles).toHaveBeenCalledWith({ sessionId: "s1", path: "C:\\Windows" });
  });

  it("keeps non-wsb sessions on the shared client and defaults to jobobject mode", async () => {
    const metas = new Map([["s1", makeMeta("s1")]]);
    const { router, shared, wsb } = makeRouter(metas);
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, mode: "jobobject" } });
    expect(wsb.acquire).not.toHaveBeenCalled();
  });

  it("reconfigures a session before the first tool call after the shared core restarts", async () => {
    const metas = new Map([["s1", makeMeta("s1")]]);
    const { router, shared } = makeRouter(metas);
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledTimes(1);

    const eventListener = shared.on.mock.calls.find(([event]) => event === "event")?.[1] as ((event: unknown) => void) | undefined;
    expect(eventListener).toBeTypeOf("function");
    eventListener?.({ source: "core", type: "core.exit", payload: { message: "crashed" } });

    await router.readFile({ sessionId: "s1", path: "." });
    expect(shared.start).toHaveBeenCalledOnce();
    expect(shared.configureSession).toHaveBeenCalledTimes(2);
    expect(shared.configureSession).toHaveBeenLastCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, mode: "jobobject" } });
    expect(shared.readFile).toHaveBeenCalledWith({ sessionId: "s1", path: "." });
  });

  it("auto-configures restored sessions even when the app-level cache predates this core", async () => {
    const meta = makeMeta("s1");
    meta.sandbox = policy;
    const { router, shared } = makeRouter(new Map([["s1", meta]]));

    await router.startJob({ sessionId: "s1", jobId: "j1", kind: "exec", cmd: "dir", cwd: "D:\\work" });

    expect(shared.start).toHaveBeenCalledOnce();
    expect(shared.configureSession).toHaveBeenCalledOnce();
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, mode: "jobobject" } });
    expect(shared.startJob).toHaveBeenCalledWith({ sessionId: "s1", jobId: "j1", kind: "exec", cmd: "dir", cwd: "D:\\work" });
  });

  it("adds global allow paths only to host (non-WSB) policies", async () => {
    const allowPaths = ["D:\\cache", "D:\\shared"];
    const host = makeRouter(new Map([["host", makeMeta("host")]]), undefined, allowPaths);
    await host.router.configureSession({ sessionId: "host", cwd: "D:\\work", sandbox: policy });
    expect(host.shared.configureSession).toHaveBeenCalledWith({
      sessionId: "host",
      cwd: "D:\\work",
      sandbox: { ...policy, allowPaths, mode: "jobobject" },
    });

    const guest = makeRouter(new Map([["guest", makeMeta("guest", "wsb")]]), undefined, allowPaths);
    await guest.router.configureSession({ sessionId: "guest", cwd: "D:\\work", sandbox: policy });
    expect(guest.wsbClient.configureSession).toHaveBeenCalledWith({
      sessionId: "guest",
      cwd: "C:\\owc-workspace",
      sandbox: { ...policy, enabled: false },
    });
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
    const metas = new Map([["s1", makeMeta("s1", "appcontainer")]]);
    const { router, shared } = makeRouter(metas, { maxProcesses: 16 });
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(shared.configureSession).toHaveBeenCalledWith({ sessionId: "s1", cwd: "D:\\work", sandbox: { ...policy, mode: "appcontainer", jobMaxProcesses: 16 } });
  });

  it("searchJob delegates to client.searchJob with sandbox path translation for wsb sessions", async () => {
    const metas = new Map([["s1", makeMeta("s1", "wsb")]]);
    const { router, wsbClient } = makeRouter(metas);
    wsbClient.searchJob = vi.fn(async () => ({ paths: [], truncated: false }));
    await router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    await router.searchJob({ sessionId: "s1", cwd: "D:\\work", kind: "glob", path: "D:/work/src", pattern: "*.ts" });
    expect(wsbClient.searchJob).toHaveBeenCalledWith({ sessionId: "s1", cwd: "C:\\owc-workspace", kind: "glob", path: "C:\\owc-workspace\\src", pattern: "*.ts" });
    expect(wsbClient.globFiles).not.toHaveBeenCalled();
  });

  it("searchJob falls back to sync globFiles/grepFiles when the client lacks searchJob", async () => {
    const metas = new Map([["s1", makeMeta("s1")]]);
    const { router, shared } = makeRouter(metas);
    await router.searchJob({ sessionId: "s1", cwd: "D:\\work", kind: "glob", path: ".", pattern: "*.ts" });
    expect(shared.globFiles).toHaveBeenCalledWith({ sessionId: "s1", path: ".", pattern: "*.ts" });
    await router.searchJob({ sessionId: "s1", cwd: "D:\\work", kind: "grep", path: "src", pattern: "beta" });
    expect(shared.grepFiles).toHaveBeenCalledWith({ sessionId: "s1", path: "src", pattern: "beta" });
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
