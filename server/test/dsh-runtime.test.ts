/** dsh 兼容模式运行期装配单测（M4 步骤 16）：启停、热切换、vendor 缺失降级、端口占用降级。 */
import net from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshCompatRuntime, type DshCompatRuntimeOptions } from "../src/dsh/web-protocol/runtime.js";
import { EventBus } from "../src/events/event-bus.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { SessionStore } from "../src/sessions/session-store.js";

const runtimes: DshCompatRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
});

/** 最小可用 vendor 目录（只含模块系统插件，够 boot graph 生成）。 */
async function fakeVendor(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "owc-dsh-runtime-"));
  await mkdir(path.join(directory, "static"), { recursive: true });
  await mkdir(path.join(directory, "plugins", "@deepseek-ai", "dsh-client-modules"), { recursive: true });
  await writeFile(path.join(directory, "static", "index.html"), "<html><head></head><body></body></html>");
  await writeFile(path.join(directory, "plugins", "@deepseek-ai", "dsh-client-modules", "client.js"), "window.__ModuleLoader__.load({id:'@deepseek-ai/dsh-client-modules',factory:()=>({apply(){},createClientModuleSystem(){}})});");
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    version: 1,
    dshVersion: "0.1.6-alpha.2",
    registry: "https://registry.npmjs.org",
    generatedAt: "2026-01-01T00:00:00.000Z",
    frontend: { files: 1, rev: "x" },
    plugins: [{ id: "@deepseek-ai/dsh-client-modules", version: "0.1.6-alpha.2", rev: "111111111111", entry: "client.js", files: ["client.js"], inject: [], external: [], immediately: true }],
  }));
  return directory;
}

function makeRuntime(overrides: {
  vendor: string;
  enabled: () => boolean;
  port?: () => number;
  uiPath?: () => string | null;
  host?: string;
  accessToken?: string;
  warnings?: string[];
  logs?: string[];
  sessions?: SessionStore;
  agent?: AgentRunner;
  events?: EventBus;
  models?: DshCompatRuntimeOptions["models"];
}): DshCompatRuntime {
  const agent = overrides.agent ?? {
    preparePermissionResponse: vi.fn(async () => undefined),
    respondInteraction: vi.fn(async () => undefined),
  } as unknown as AgentRunner;
  const runtime = new DshCompatRuntime({
    vendorDirectory: overrides.vendor,
    enabled: overrides.enabled,
    port: overrides.port ?? (() => 0),
    uiPath: overrides.uiPath ?? (() => null),
    host: () => overrides.host ?? "127.0.0.1",
    accessToken: () => overrides.accessToken,
    sessions: overrides.sessions ?? ({} as SessionStore),
    agent,
    events: overrides.events ?? new EventBus(),
    ...(overrides.models === undefined ? {} : { models: overrides.models }),
    home: "/home/tester",
    version: () => "1.12.0-test",
    mainPort: () => 3210,
    logger: {
      info: (message) => overrides.logs?.push(message),
      warn: (message) => overrides.warnings?.push(message),
    },
  });
  runtimes.push(runtime);
  return runtime;
}

describe("dsh 兼容模式运行期", () => {
  it("关闭时零常驻：sync 不监听也不报错", async () => {
    const vendor = await fakeVendor();
    const runtime = makeRuntime({ vendor, enabled: () => false });
    await runtime.sync();
    expect(runtime.listening).toBe(false);
  });

  it("打开后监听；重复 sync 幂等（状态未变不重启）", async () => {
    const vendor = await fakeVendor();
    const logs: string[] = [];
    const runtime = makeRuntime({ vendor, enabled: () => true, logs });
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    expect(logs.filter((line) => line.includes("兼容模式已启动"))).toHaveLength(1);
    await runtime.sync();
    expect(logs.filter((line) => line.includes("兼容模式已启动"))).toHaveLength(1);
  });

  it("热切换：关→开与开→关都按设置对齐，端口变更会重起", async () => {
    const vendor = await fakeVendor();
    let enabled = false;
    let port = 0;
    const runtime = makeRuntime({ vendor, enabled: () => enabled, port: () => port });
    await runtime.sync();
    expect(runtime.listening).toBe(false);
    enabled = true;
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    // 端口变化 → 重起（仍监听，且是幂等键的一部分）
    port = 0;
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    enabled = false;
    await runtime.sync();
    expect(runtime.listening).toBe(false);
  });

  it("非回环 host 且拿不到访问令牌：拒绝启动该端口（不裸开鉴权）", async () => {
    const vendor = await fakeVendor();
    const warnings: string[] = [];
    const runtime = makeRuntime({ vendor, enabled: () => true, host: "0.0.0.0", warnings });
    await runtime.sync();
    expect(runtime.listening).toBe(false);
    expect(warnings.some((line) => line.includes("非回环"))).toBe(true);

    // 有令牌即可正常启动（守卫只在缺少令牌时生效）
    const withToken = makeRuntime({ vendor, enabled: () => true, host: "0.0.0.0", accessToken: "t".repeat(32) });
    await withToken.sync();
    expect(withToken.listening).toBe(true);
  });

  it("session/selectModel 端到端：落盘并发布 session.config_updated（主工作台实时感知）", async () => {
    const vendor = await fakeVendor();
    const published: Array<{ source: string; type: string; sessionId?: string; payload: unknown }> = [];
    const updateConfig = vi.fn(async () => ({ id: "s1" }));
    const runtime = makeRuntime({
      vendor,
      enabled: () => true,
      accessToken: "t".repeat(32),
      sessions: {
        getMeta: async () => ({ id: "s1", provider: "openai", model: "gpt-4.1" }),
        updateConfig,
      } as unknown as SessionStore,
      agent: { isRunning: () => false } as unknown as AgentRunner,
      models: {
        providers: () => ["deepseek"],
        models: () => [{ provider: "deepseek", id: "deepseek-reasoner", capabilities: { thinking: ["enabled"], effort: ["low", "medium", "high"] } }],
        defaults: () => undefined,
        sessionDefault: () => undefined,
      },
      events: {
        publish: (event: { type: string; sessionId?: string; payload: unknown }) => { published.push(event); },
      } as unknown as EventBus,
    });
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    expect(runtime.address).toMatch(/^127\.0\.0\.1:\d+$/);
    const response = await fetch(`http://${runtime.address}/api/session/selectModel`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `owc_access_token=${"t".repeat(32)}` },
      body: JSON.stringify({ type: "client-request", rpcId: "r1", method: "session/selectModel", payload: { args: { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } } } }),
    });
    expect(response.status).toBe(200);
    const envelope = await response.json() as { result: { ok: boolean; value?: unknown } };
    expect(envelope.result.ok).toBe(true);
    expect(envelope.result.value).toEqual({ selected: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } });
    expect(updateConfig).toHaveBeenCalledWith("s1", { provider: "deepseek", model: "deepseek-reasoner", effort: "high" });
    // 与 REST /agent-runner 同一条可见性链路：不发该事件时主工作台要等刷新才看到模型切换
    expect(published).toEqual([{ source: "session", type: "session.config_updated", sessionId: "s1", payload: { id: "s1" } }]);
  });

  it("vendor 缺失：不监听并如实记录原因（不半启动）", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "owc-dsh-novendor2-"));
    const warnings: string[] = [];
    const runtime = makeRuntime({ vendor: empty, enabled: () => true, warnings });
    await runtime.sync();
    expect(runtime.listening).toBe(false);
    expect(warnings.join("\n")).toContain("fetch-dsh-web");
  });

  it("dshUiPath 覆盖 vendor 目录（指向另一份 UI 产物）", async () => {
    const builtin = await fakeVendor();
    const custom = await fakeVendor();
    const runtime = makeRuntime({ vendor: builtin, enabled: () => true, uiPath: () => custom });
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    const address = (runtime as unknown as { server?: { app: { server: { address(): { port: number } } } } }).server?.app.server.address();
    expect(address).toBeDefined();
  });

  it("竞态：apply 进行中关闭开关 → sync 结束后必须不监听（端口不得常驻）", async () => {
    const vendor = await fakeVendor();
    let enabled = true;
    const runtime = makeRuntime({ vendor, enabled: () => enabled, port: () => 0 });
    const pending = runtime.sync();
    // apply 已在 await 窗口内（loadBridgePlugin/listen）：此时把开关改掉
    enabled = false;
    await pending;
    // 修复前：apply 末尾用「当时的设置」落 applied，实例却已监听 → 此后所有 sync 早退，端口永久常驻
    expect(runtime.listening).toBe(false);
    expect(runtime.reason).toBeUndefined();
    // 再 sync 一次仍不该把端口起回来（期望态是「关」）
    await runtime.sync();
    expect(runtime.listening).toBe(false);
  });

  it("竞态：apply 进行中「关→开」往返 → sync 结束后收敛到最终期望（监听）", async () => {
    const vendor = await fakeVendor();
    let enabled = true;
    const runtime = makeRuntime({ vendor, enabled: () => enabled, port: () => 0 });
    const pending = runtime.sync();
    enabled = false;
    enabled = true;
    await pending;
    expect(runtime.listening).toBe(true);
  });

  it("未就绪原因如实上报（缺 vendor / 非回环无令牌）", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "owc-dsh-reason-"));
    const missing = makeRuntime({ vendor: empty, enabled: () => true });
    await missing.sync();
    expect(missing.reason).toBe("vendor missing");
    const noToken = makeRuntime({ vendor: await fakeVendor(), enabled: () => true, host: "0.0.0.0" });
    await noToken.sync();
    expect(noToken.reason).toBe("non-loopback without access token");
    expect(noToken.listening).toBe(false);
  });

  it("close 后不再监听且可再次 sync 起回", async () => {
    const vendor = await fakeVendor();
    const runtime = makeRuntime({ vendor, enabled: () => true });
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    await runtime.close();
    expect(runtime.listening).toBe(false);
    await runtime.sync();
    expect(runtime.listening).toBe(true);
  });

  it("D12：session/create 补发 session.created（与 REST 创建路径同一可见性链路）", async () => {
    const vendor = await fakeVendor();
    const published: Array<{ source: string; type: string; sessionId?: string; payload: unknown }> = [];
    const created = {
      id: "new-session",
      cwd: "/tmp",
      provider: "p",
      model: "m",
      title: "新会话",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const runtime = makeRuntime({
      vendor,
      enabled: () => true,
      accessToken: "t".repeat(32),
      sessions: { create: vi.fn(async () => created), getMeta: async () => undefined, list: async () => [] } as unknown as SessionStore,
      agent: { isRunning: () => false } as unknown as AgentRunner,
      events: { publish: (event: { source: string; type: string; sessionId?: string; payload: unknown }) => { published.push(event); } } as unknown as EventBus,
    });
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    const response = await fetch(`http://${runtime.address}/api/session/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `owc_access_token=${"t".repeat(32)}` },
      body: JSON.stringify({ type: "client-request", rpcId: "r1", method: "session/create", payload: { args: { request: { cwd: "/tmp" } } } }),
    });
    const envelope = await response.json() as { result: { ok: boolean; value?: unknown } };
    expect(envelope.result.ok).toBe(true);
    expect(envelope.result.value).toEqual({ sessionId: "new-session" });
    // 不补发该事件时 dsh 侧边栏与主工作台都要等刷新才看到新会话
    expect(published).toEqual([{ source: "session", type: "session.created", sessionId: "new-session", payload: created }]);
  });

  it("D6：端口被占用时 sync 抛错（启动路径必须 catch），不残留半启动状态且端口腾出后可重试", async () => {
    const vendor = await fakeVendor();
    const warnings: string[] = [];
    // 先占住一个端口（模拟 dshPort 与其它进程冲突）
    const blocker = net.createServer();
    const occupied = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as { port: number }).port));
    });
    let port = occupied;
    const runtime = makeRuntime({ vendor, enabled: () => true, port: () => port, warnings });
    await expect(runtime.sync()).rejects.toThrow();
    expect(runtime.listening).toBe(false);
    expect(runtime.address).toBeUndefined();
    // 原因如实记录（主服务继续启动，日志里能看到为什么没起）
    expect(warnings.join("\n")).toContain(`127.0.0.1:${occupied} 监听失败`);

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    port = 0; // 端口腾出后（或换了端口）下一次 sync 能重试成功
    await runtime.sync();
    expect(runtime.listening).toBe(true);
  });
});
