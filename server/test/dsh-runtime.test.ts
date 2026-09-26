/** dsh 兼容模式运行期装配单测：启停、热切换、vendor 缺失降级、端口占用降级、写路径可见性链路。 */
import net from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DshCompatRuntime } from "../src/dsh/web-protocol/runtime.js";
import { EventBus } from "../src/events/event-bus.js";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import type { SessionStore } from "../src/sessions/session-store.js";

const runtimes: DshCompatRuntime[] = [];
afterEach(async () => { while (runtimes.length > 0) await runtimes.pop()?.close(); });

/** 最小可用 vendor 目录（只含模块系统插件，够 boot graph 生成）。 */
async function fakeVendor(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "owc-dsh-runtime-"));
  await mkdir(path.join(directory, "static"), { recursive: true });
  await mkdir(path.join(directory, "plugins", "@deepseek-ai", "dsh-client-modules"), { recursive: true });
  await writeFile(path.join(directory, "static", "index.html"), "<html><head></head><body></body></html>");
  await writeFile(path.join(directory, "plugins", "@deepseek-ai", "dsh-client-modules", "client.js"), "window.__ModuleLoader__.load({id:'@deepseek-ai/dsh-client-modules',factory:()=>({apply(){},createClientModuleSystem(){}})});");
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    version: 1, dshVersion: "0.1.6-alpha.2", registry: "https://registry.npmjs.org", generatedAt: "2026-01-01T00:00:00.000Z", frontend: { files: 1, rev: "x" },
    plugins: [{ id: "@deepseek-ai/dsh-client-modules", version: "0.1.6-alpha.2", rev: "111111111111", entry: "client.js", files: ["client.js"], inject: [], external: [], immediately: true }],
  }));
  return directory;
}

type RuntimeOptions = {
  vendor: string; enabled: () => boolean; port?: () => number; uiPath?: () => string | null; host?: string; accessToken?: string;
  warnings?: string[]; sessions?: unknown; agent?: unknown; events?: unknown; models?: unknown; totpBlocked?: boolean;
};

function makeRuntime(options: RuntimeOptions): DshCompatRuntime {
  const runtime = new DshCompatRuntime({
    vendorDirectory: options.vendor, enabled: options.enabled, port: options.port ?? (() => 0), uiPath: options.uiPath ?? (() => null),
    host: () => options.host ?? "127.0.0.1", accessToken: () => options.accessToken,
    sessions: (options.sessions ?? {}) as SessionStore, agent: (options.agent ?? {}) as AgentRunner,
    events: (options.events ?? new EventBus()) as EventBus,
    ...(options.models === undefined ? {} : { models: options.models as never }),
    home: "/home/tester", version: () => "1.12.0-test", mainPort: () => 3210,
    logger: { info: () => {}, warn: (message) => options.warnings?.push(message) },
  });
  runtimes.push(runtime);
  return runtime;
}

/** dsh 端口上的 unary 调用（cookie 鉴权 + 精确 application/json）。 */
function unary(runtime: DshCompatRuntime, endpoint: string, args: Record<string, unknown>) {
  const token = "t".repeat(32);
  return fetch(`http://${runtime.address}/api/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `owc_access_token=${token}` },
    body: JSON.stringify({ type: "client-request", rpcId: "r1", method: endpoint, payload: { args } }),
  });
}

describe("dsh 兼容模式运行期", () => {
  it("生命周期：关闭零常驻、打开监听、重复 sync 幂等、热切换与端口变更、close 后仍可再起", async () => {
    const vendor = await fakeVendor();
    let enabled = false;
    let port = 0;
    const runtime = makeRuntime({ vendor, enabled: () => enabled, port: () => port });
    await runtime.sync();
    expect(runtime.listening).toBe(false);
    enabled = true;
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    await runtime.sync(); // 状态未变不重启
    expect(runtime.listening).toBe(true);
    port = 3210;
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    enabled = false;
    await runtime.sync();
    expect(runtime.listening).toBe(false);
    enabled = true;
    await runtime.sync();
    await runtime.close();
    expect(runtime.listening).toBe(false);
    await runtime.sync();
    expect(runtime.listening).toBe(true);
  });

  it("启动守卫：非回环且拿不到访问令牌时拒绝启动并如实记原因；有令牌才放行", async () => {
    const vendor = await fakeVendor();
    const warnings: string[] = [];
    const blocked = makeRuntime({ vendor, enabled: () => true, host: "0.0.0.0", warnings });
    await blocked.sync();
    expect([blocked.listening, blocked.reason]).toEqual([false, "non-loopback without access token"]);
    expect(warnings.some((line) => line.includes("非回环"))).toBe(true);
    const allowed = makeRuntime({ vendor, enabled: () => true, host: "0.0.0.0", accessToken: "t".repeat(32) });
    await allowed.sync();
    expect(allowed.listening).toBe(true);
  });

  it("vendor 缺失或 UI 目录不可用时如实降级（不半启动）；dshUiPath 可覆盖 vendor 目录", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "owc-dsh-novendor2-"));
    const warnings: string[] = [];
    const missing = makeRuntime({ vendor: empty, enabled: () => true, warnings });
    await missing.sync();
    expect([missing.listening, missing.reason]).toEqual([false, "vendor missing"]);
    expect(warnings.join("\n")).toContain("fetch-dsh-web");
    // dshUiPath 指向另一份 UI 产物时必须优先于内置 vendor 目录
    const custom = await fakeVendor();
    const overridden = makeRuntime({ vendor: await fakeVendor(), enabled: () => true, uiPath: () => custom });
    await overridden.sync();
    expect([overridden.listening, overridden.address]).toEqual([true, expect.stringMatching(/^127\.0\.0\.1:\d+$/)]);
  });

  it("写路径端到端：selectModel 落盘并发布 session.config_updated、create 补发 session.created（主工作台实时感知）", async () => {
    const vendor = await fakeVendor();
    const published: Array<{ source: string; type: string; sessionId?: string; payload: unknown }> = [];
    const created = { id: "new-session", cwd: "/tmp", provider: "p", model: "m", title: "新会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const configWrites: unknown[][] = [];
    const runtime = makeRuntime({
      vendor, enabled: () => true, accessToken: "t".repeat(32),
      sessions: {
        getMeta: async () => ({ id: "s1", provider: "openai", model: "gpt-4.1" }), list: async () => [], create: async () => created,
        updateConfig: async (sessionId: string, patch: unknown) => { configWrites.push([sessionId, patch]); return { id: "s1" }; },
      },
      agent: { isRunning: () => false },
      events: { publish: (event: { source: string; type: string; sessionId?: string; payload: unknown }) => { published.push(event); } },
      models: { providers: () => ["deepseek"], models: () => [{ provider: "deepseek", id: "deepseek-reasoner", capabilities: { thinking: ["enabled"], effort: ["low", "medium", "high"] } }], defaults: () => undefined, sessionDefault: () => undefined },
    });
    await runtime.sync();
    expect(runtime.listening).toBe(true);
    const selected = await (await unary(runtime, "session/selectModel", { request: { sessionId: "s1", provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } })).json() as { result: { ok: boolean; value?: unknown } };
    expect([selected.result.ok, selected.result.value]).toEqual([true, { selected: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" } }]);
    expect(configWrites).toEqual([["s1", { provider: "deepseek", model: "deepseek-reasoner", effort: "high" }]]);
    const createResponse = await unary(runtime, "session/create", { request: { cwd: "/tmp" } });
    expect((await createResponse.json() as { result: { value?: unknown } }).result.value).toEqual({ sessionId: "new-session" });
    // 不补发这两个事件时 dsh 侧边栏与主工作台都要等刷新才看到变化
    expect(published).toEqual([
      { source: "session", type: "session.config_updated", sessionId: "s1", payload: { id: "s1" } },
      { source: "session", type: "session.created", sessionId: "new-session", payload: created },
    ]);
  });

  it("竞态：apply 窗口内改开关不会让端口永久常驻（关→不监听、关→开→收敛到监听）", async () => {
    const vendor = await fakeVendor();
    let enabled = true;
    const closing = makeRuntime({ vendor, enabled: () => enabled });
    const pendingClose = closing.sync();
    enabled = false;
    await pendingClose;
    expect([closing.listening, closing.reason]).toEqual([false, undefined]);
    await closing.sync(); // 期望态是「关」，不该把端口起回来
    expect(closing.listening).toBe(false);
    const toggling = makeRuntime({ vendor, enabled: () => enabled });
    enabled = true;
    const pendingOpen = toggling.sync();
    enabled = false;
    enabled = true;
    await pendingOpen;
    expect(toggling.listening).toBe(true);
  });

  it("端口占用：sync 抛错（启动路径必须 catch）且不残留半启动，端口腾出后可重试成功", async () => {
    const vendor = await fakeVendor();
    const warnings: string[] = [];
    const blocker = net.createServer();
    const occupied = await new Promise<number>((resolve) => { blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as { port: number }).port)); });
    let port = occupied;
    const runtime = makeRuntime({ vendor, enabled: () => true, port: () => port, warnings });
    await expect(runtime.sync()).rejects.toThrow();
    expect([runtime.listening, runtime.address]).toEqual([false, undefined]);
    // 原因如实写入日志：主服务继续启动，运维能看到为什么没起
    expect(warnings.join("\n")).toContain(`127.0.0.1:${occupied} 监听失败`);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    port = 0;
    await runtime.sync();
    expect(runtime.listening).toBe(true);
  });
});
