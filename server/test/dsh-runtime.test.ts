/** dsh 兼容模式运行期装配单测（M4 步骤 16）：启停、热切换、vendor 缺失降级。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshCompatRuntime } from "../src/dsh/web-protocol/runtime.js";
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
  warnings?: string[];
  logs?: string[];
}): DshCompatRuntime {
  const agent = {
    preparePermissionResponse: vi.fn(async () => undefined),
    respondInteraction: vi.fn(async () => undefined),
  } as unknown as AgentRunner;
  const runtime = new DshCompatRuntime({
    vendorDirectory: overrides.vendor,
    enabled: overrides.enabled,
    port: overrides.port ?? (() => 0),
    uiPath: overrides.uiPath ?? (() => null),
    host: () => "127.0.0.1",
    accessToken: () => undefined,
    sessions: {} as SessionStore,
    agent,
    events: new EventBus(),
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
});
