import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { UpdateApplier, UpdateApplyError, type UpdateApplyState } from "../src/update-applier.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

const RELEASE_URL = "https://api.github.com/repos/snnh/openwebcode/releases/latest";
const ASSET_BASE = "https://github.com/snnh/openwebcode/releases/download/v0.6.0";
const TARGET_VERSION = "0.6.0";

function assetNameFor(platform: "win32" | "linux", arch = "x64"): string {
  return platform === "win32"
    ? `openwebcode-${TARGET_VERSION}-windows-x64.msi`
    : `openwebcode-${TARGET_VERSION}-linux-${arch}.tar.gz`;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

interface FakeFetchOptions {
  platform: "win32" | "linux";
  /** linux 资产名架构后缀（缺省 x64） */
  arch?: string;
  tag?: string;
  assetBytes?: Buffer;
  /** 提供时 SHA256SUMS.txt 内容（缺省按 assetBytes 计算） */
  sumsText?: string;
  /** 覆盖资产的 browser_download_url（用于非 github.com 拒绝用例） */
  assetUrlOverride?: string;
  /** 提供时资产响应使用该流（可挂起以测试并发互斥） */
  assetBody?: ReadableStream<Uint8Array>;
}

function makeFetch(options: FakeFetchOptions): typeof fetch {
  const tag = options.tag ?? `v${TARGET_VERSION}`;
  const assetName = assetNameFor(options.platform, options.arch);
  const assetBytes = options.assetBytes ?? Buffer.from(`fake-${options.platform}-payload`);
  const assetUrl = options.assetUrlOverride ?? `${ASSET_BASE}/${assetName}`;
  const sumsUrl = `${ASSET_BASE}/SHA256SUMS.txt`;
  const sumsText = options.sumsText ?? `${sha256Hex(assetBytes)}  ${assetName}\n`;
  return (async (input: unknown) => {
    const url = String(input);
    if (url === RELEASE_URL) {
      return new Response(JSON.stringify({
        tag_name: tag,
        html_url: `https://github.com/snnh/openwebcode/releases/tag/${tag}`,
        assets: [
          { name: assetName, browser_download_url: assetUrl },
          { name: "SHA256SUMS.txt", browser_download_url: sumsUrl },
        ],
      }), { status: 200 });
    }
    if (url === assetUrl) {
      const body = options.assetBody ?? new Response(new Uint8Array(assetBytes)).body;
      return new Response(body, { status: 200, headers: { "content-length": String(assetBytes.length) } });
    }
    if (url === sumsUrl) return new Response(sumsText, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

interface SpawnCall {
  command: string;
  args: string[];
  options?: unknown;
}

/** fake spawn：tar -tzf 返回固定列表；tar -xzf 在目标目录生成仿真的解压产物；其余直接成功。 */
function makeSpawn(): { calls: SpawnCall[]; impl: typeof spawn } {
  const calls: SpawnCall[] = [];
  const impl = ((command: string, args: readonly string[], options?: unknown) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as ChildProcess;
    const streams = child as unknown as { stdout: EventEmitter; stderr: EventEmitter; unref: () => void };
    streams.stdout = new EventEmitter();
    streams.stderr = new EventEmitter();
    streams.unref = () => undefined;
    setImmediate(() => {
      void (async () => {
        if (command === "tar" && args[0] === "-tzf") {
          streams.stdout.emit("data", Buffer.from("server/\nserver/dist/\nserver/dist/index.js\nweb/\nweb/index.html\ninstall.sh\n"));
        } else if (command === "tar" && args[0] === "-xzf") {
          const dir = args[args.indexOf("-C") + 1]!;
          await mkdir(path.join(dir, "server", "dist"), { recursive: true });
          await writeFile(path.join(dir, "server", "dist", "index.js"), "// new version\n", "utf8");
          await mkdir(path.join(dir, "web"), { recursive: true });
          await writeFile(path.join(dir, "web", "index.html"), "<html></html>\n", "utf8");
          await writeFile(path.join(dir, "install.sh"), "#!/bin/sh\n", "utf8");
        }
        child.emit("close", 0);
      })().catch(() => child.emit("close", 1));
    });
    return child;
  }) as unknown as typeof spawn;
  return { calls, impl };
}

interface ApplierFixture {
  applier: UpdateApplier;
  dataDir: string;
  installRoot: string;
}

async function makeApplier(overrides: {
  platform: "win32" | "linux";
  arch?: string;
  fetchImpl: typeof fetch;
  spawnImpl: typeof spawn;
  exitImpl: () => void;
  currentVersion?: string;
}): Promise<ApplierFixture> {
  const dataDir = await tempRoot("owc-update-apply-");
  const installRoot = path.join(await tempRoot("owc-update-apply-"), "owc-home");
  await mkdir(installRoot, { recursive: true });
  const applier = new UpdateApplier({
    dataDir,
    installRoot,
    platform: overrides.platform,
    // 与宿主架构解耦：缺省固定 x64（arm64 CI runner 上 process.arch 会让资产名错配）；
    // 架构映射/不支持架构用例显式传 arch 覆盖
    arch: overrides.arch ?? "x64",
    getReleaseUrl: () => RELEASE_URL,
    getCurrentVersion: () => overrides.currentVersion ?? "0.5.2",
    fetchImpl: overrides.fetchImpl,
    spawnImpl: overrides.spawnImpl,
    exitImpl: overrides.exitImpl,
  });
  return { applier, dataDir, installRoot };
}

async function withConfigHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
}

describe("UpdateApplier", () => {
  it("linux 全流程：下载/校验/解压/复制，无 systemd unit 时 done 且不退出", async () => {
    const spawn = makeSpawn();
    let exitCalls = 0;
    const fixture = await makeApplier({
      platform: "linux",
      fetchImpl: makeFetch({ platform: "linux" }),
      spawnImpl: spawn.impl,
      exitImpl: () => { exitCalls += 1; },
    });
    const configHome = await tempRoot("owc-update-apply-");
    await withConfigHome(configHome, async () => {
      const state = await fixture.applier.apply();
      expect(state.status).toBe("done");
      expect(state.version).toBe(TARGET_VERSION);
      expect(state.message).toContain("手动重启");
      expect(state.startedAt).toBeTruthy();
    });
    // 复制进 installRoot；install.sh 不复制
    expect(existsSync(path.join(fixture.installRoot, "server", "dist", "index.js"))).toBe(true);
    expect(existsSync(path.join(fixture.installRoot, "web", "index.html"))).toBe(true);
    expect(existsSync(path.join(fixture.installRoot, "install.sh"))).toBe(false);
    // 解压使用了系统 tar
    expect(spawn.calls.some((call) => call.command === "tar" && call.args[0] === "-xzf")).toBe(true);
    expect(exitCalls).toBe(0);
    // 资产保留在 dataDir/updates 且长度正确
    const downloaded = await readFile(path.join(fixture.dataDir, "updates", TARGET_VERSION, assetNameFor("linux")));
    expect(downloaded.length).toBe(Buffer.from("fake-linux-payload").length);
  });

  it("linux 有 systemd user unit 时 restarting，spawn systemctl 且调用 exitImpl", async () => {
    const spawn = makeSpawn();
    let exitCalls = 0;
    const fixture = await makeApplier({
      platform: "linux",
      fetchImpl: makeFetch({ platform: "linux" }),
      spawnImpl: spawn.impl,
      exitImpl: () => { exitCalls += 1; },
    });
    const configHome = await tempRoot("owc-update-apply-");
    await mkdir(path.join(configHome, "systemd", "user"), { recursive: true });
    await writeFile(path.join(configHome, "systemd", "user", "openwebcode.service"), "[Unit]\n", "utf8");
    await withConfigHome(configHome, async () => {
      const state = await fixture.applier.apply();
      expect(state.status).toBe("restarting");
      expect(state.message).toContain("自动重启");
    });
    const restartCall = spawn.calls.find((call) => call.command === "sh");
    expect(restartCall?.args.join(" ")).toContain("systemctl --user restart openwebcode.service");
    expect(restartCall?.args.join(" ")).not.toContain("try-restart");
    expect(exitCalls).toBe(1);
    expect(existsSync(path.join(fixture.installRoot, "server", "dist", "index.js"))).toBe(true);
  });

  it("linux 系统级 unit（root 安装）时用 systemctl restart 自动重启", async () => {
    const spawn = makeSpawn();
    let exitCalls = 0;
    const dataDir = await tempRoot("owc-update-apply-");
    const installRoot = path.join(await tempRoot("owc-update-apply-"), "owc-home");
    await mkdir(installRoot, { recursive: true });
    const systemUnitDir = await tempRoot("owc-update-apply-");
    const systemUnitPath = path.join(systemUnitDir, "openwebcode.service");
    await writeFile(systemUnitPath, "[Unit]\n", "utf8");
    const applier = new UpdateApplier({
      dataDir,
      installRoot,
      platform: "linux",
      getReleaseUrl: () => RELEASE_URL,
      getCurrentVersion: () => "0.5.2",
      fetchImpl: makeFetch({ platform: "linux" }),
      spawnImpl: spawn.impl,
      exitImpl: () => { exitCalls += 1; },
      getuidImpl: () => 0,
      systemUnitPath,
    });
    // 用户级 unit 同时存在时系统级优先（root 安装下 server 即 root）
    const configHome = await tempRoot("owc-update-apply-");
    await mkdir(path.join(configHome, "systemd", "user"), { recursive: true });
    await writeFile(path.join(configHome, "systemd", "user", "openwebcode.service"), "[Unit]\n", "utf8");
    await withConfigHome(configHome, async () => {
      const state = await applier.apply();
      expect(state.status).toBe("restarting");
      expect(state.message).toContain("自动重启");
    });
    const restartCall = spawn.calls.find((call) => call.command === "sh");
    expect(restartCall?.args.join(" ")).toContain("systemctl restart openwebcode.service");
    expect(restartCall?.args.join(" ")).not.toContain("--user");
    expect(restartCall?.args.join(" ")).not.toContain("try-restart");
    expect(exitCalls).toBe(1);
  });

  it("sha256 不匹配：error，不复制文件，状态保留", async () => {
    const spawn = makeSpawn();
    const fixture = await makeApplier({
      platform: "linux",
      fetchImpl: makeFetch({ platform: "linux", sumsText: `${"0".repeat(64)}  ${assetNameFor("linux")}\n` }),
      spawnImpl: spawn.impl,
      exitImpl: () => undefined,
    });
    await expect(fixture.applier.apply()).rejects.toThrow(/SHA256/);
    const state = fixture.applier.state();
    expect(state?.status).toBe("error");
    expect(state?.error).toContain("SHA256");
    expect(existsSync(path.join(fixture.installRoot, "server"))).toBe(false);
    // 校验失败发生在解压之前
    expect(spawn.calls.some((call) => call.command === "tar")).toBe(false);
  });

  it("linux 资产名按架构映射：arm64 与 loong64（→loongarch64）", async () => {
    for (const [nodeArch, assetArch] of [["arm64", "arm64"], ["loong64", "loongarch64"]] as const) {
      const spawn = makeSpawn();
      const fixture = await makeApplier({
        platform: "linux",
        arch: nodeArch,
        fetchImpl: makeFetch({ platform: "linux", arch: assetArch }),
        spawnImpl: spawn.impl,
        exitImpl: () => undefined,
      });
      const configHome = await tempRoot("owc-update-apply-");
      await withConfigHome(configHome, async () => {
        const state = await fixture.applier.apply();
        expect(state.status).toBe("done");
      });
      const downloaded = await readFile(path.join(fixture.dataDir, "updates", TARGET_VERSION, assetNameFor("linux", assetArch)));
      expect(downloaded.length).toBe(Buffer.from("fake-linux-payload").length);
    }
  });

  it("未映射的 linux 架构拒绝在线更新（400 语义）", async () => {
    const spawn = makeSpawn();
    const fixture = await makeApplier({
      platform: "linux",
      arch: "riscv64",
      fetchImpl: makeFetch({ platform: "linux" }),
      spawnImpl: spawn.impl,
      exitImpl: () => undefined,
    });
    const error = await fixture.applier.apply().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UpdateApplyError);
    expect((error as UpdateApplyError).statusCode).toBe(400);
    expect((error as UpdateApplyError).message).toContain("riscv64");
  });

  it("非 github.com 的资产 URL 被拒绝（400 语义）", async () => {
    const spawn = makeSpawn();
    const fixture = await makeApplier({
      platform: "linux",
      fetchImpl: makeFetch({ platform: "linux", assetUrlOverride: "https://evil.example.com/payload.tar.gz" }),
      spawnImpl: spawn.impl,
      exitImpl: () => undefined,
    });
    const error = await fixture.applier.apply().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UpdateApplyError);
    expect((error as UpdateApplyError).statusCode).toBe(400);
  });

  it("tag 不新于当前版本：400 语义「已是最新版本」", async () => {
    const spawn = makeSpawn();
    const fixture = await makeApplier({
      platform: "linux",
      fetchImpl: makeFetch({ platform: "linux", tag: "v0.5.2" }),
      spawnImpl: spawn.impl,
      exitImpl: () => undefined,
      currentVersion: "0.5.2",
    });
    const error = await fixture.applier.apply().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UpdateApplyError);
    expect((error as UpdateApplyError).statusCode).toBe(400);
    expect((error as UpdateApplyError).message).toContain("已是最新版本");
    // 未开始更新流程，内存状态保持空
    expect(fixture.applier.state()).toBeNull();
  });

  it("win32：spawn msiexec 延迟安装并调用 exitImpl，状态 restarting", async () => {
    const spawn = makeSpawn();
    let exitCalls = 0;
    const fixture = await makeApplier({
      platform: "win32",
      fetchImpl: makeFetch({ platform: "win32" }),
      spawnImpl: spawn.impl,
      exitImpl: () => { exitCalls += 1; },
    });
    const state = await fixture.applier.apply();
    expect(state.status).toBe("restarting");
    expect(state.version).toBe(TARGET_VERSION);
    const cmdCall = spawn.calls.find((call) => call.command === "cmd.exe");
    expect(cmdCall).toBeTruthy();
    expect(cmdCall?.args.join(" ")).toContain("msiexec /i");
    expect(cmdCall?.args.join(" ")).toContain(assetNameFor("win32"));
    expect(exitCalls).toBe(1);
  });

  it("并发 apply：第二个得到 409 语义", async () => {
    const spawn = makeSpawn();
    const assetBytes = Buffer.from("fake-linux-payload");
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const assetBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(assetBytes));
        await gate;
        controller.close();
      },
    });
    const fixture = await makeApplier({
      platform: "linux",
      fetchImpl: makeFetch({ platform: "linux", assetBytes, assetBody }),
      spawnImpl: spawn.impl,
      exitImpl: () => undefined,
    });
    const configHome = await tempRoot("owc-update-apply-");
    await withConfigHome(configHome, async () => {
      const first = fixture.applier.apply();
      await vi.waitFor(() => expect(fixture.applier.state()?.status).toBe("downloading"), { timeout: 5000 });
      const error = await fixture.applier.apply().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(UpdateApplyError);
      expect((error as UpdateApplyError).statusCode).toBe(409);
      releaseGate();
      const state = await first;
      expect(state.status).toBe("done");
    });
  });
});

async function setupApp(updateApplier?: UpdateApplier) {
  const root = await tempRoot("owc-update-apply-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "model-pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const core = makeFakeCore();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, ...(updateApplier ? { updateApplier } : {}) });
  return app;
}

const DONE_STATE: UpdateApplyState = {
  status: "done",
  version: TARGET_VERSION,
  progress: null,
  message: "更新已应用，请手动重启服务生效",
  startedAt: "2026-07-27T00:00:00.000Z",
};

describe("/api/update/apply", () => {
  it("未注入 applier 时 GET/POST 返回 501", async () => {
    const app = await setupApp();
    try {
      const got = await app.inject({ method: "GET", url: "/api/update/apply" });
      expect(got.statusCode).toBe(501);
      const posted = await app.inject({ method: "POST", url: "/api/update/apply" });
      expect(posted.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("GET 返回当前状态（无记录为 null）", async () => {
    const applier = {
      state: () => DONE_STATE,
      apply: async () => DONE_STATE,
    } as unknown as UpdateApplier;
    const app = await setupApp(applier);
    try {
      const response = await app.inject({ method: "GET", url: "/api/update/apply" });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ state: UpdateApplyState | null }>().state?.status).toBe("done");
    } finally {
      await app.close();
    }
  });

  it("POST 成功返回 202 与状态", async () => {
    const applier = {
      state: () => null,
      apply: async () => DONE_STATE,
    } as unknown as UpdateApplier;
    const app = await setupApp(applier);
    try {
      const response = await app.inject({ method: "POST", url: "/api/update/apply" });
      expect(response.statusCode).toBe(202);
      const body = response.json<{ state: UpdateApplyState }>();
      expect(body.state.status).toBe("done");
      expect(body.state.version).toBe(TARGET_VERSION);
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: "POST 已是最新返回 400", statusCode: 400, message: "已是最新版本" },
    { name: "POST 已有进行中的更新返回 409", statusCode: 409, message: "已有进行中的更新" },
  ])("$name", async ({ statusCode, message }) => {
    const applier = {
      state: () => null,
      apply: async () => { throw new UpdateApplyError(statusCode, message); },
    } as unknown as UpdateApplier;
    const app = await setupApp(applier);
    try {
      const response = await app.inject({ method: "POST", url: "/api/update/apply" });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json<{ error: string }>().error).toContain(message);
    } finally {
      await app.close();
    }
  });
});
