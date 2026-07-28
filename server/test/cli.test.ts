import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike, CoreEvent, CoreInfo, ExecResult } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-cli-"));
  roots.push(root);
  return root;
}

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

/** 纯文本 fake provider：直接产出一段 assistant 文本后收尾 */
const textProvider = makeStubProvider("test-stub", async function* () {
  yield { type: "text_delta", text: "hello from assistant" };
  yield { type: "done", stopReason: "end_turn" };
});

/** 工具调用 fake provider：首轮固定请求 bash；看到 tool 结果后产出文本收尾 */
const bashProvider = makeStubProvider("test-stub", async function* (request) {
  const last = request.messages[request.messages.length - 1];
  if (last?.role === "tool") {
    yield { type: "text_delta", text: "command finished" };
    yield { type: "done", stopReason: "end_turn" };
    return;
  }
  yield { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "echo hi" } };
  yield { type: "done", stopReason: "tool_use" };
});

const FAKE_CORE_INFO: CoreInfo = {
  version: "0.2.4-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

/** 可控 fake CoreClient（同 shell.test.ts）：run() 挂起，由 release() 驱动 resolve */
function createControllableCore(): {
  client: CoreClientLike;
  release: (result: ExecResult) => void;
  runCalls: Array<{ sessionId: string; execId: string; cmd: string; cwd: string }>;
} {
  let runResolve: ((result: ExecResult) => void) | undefined;
  const emitter = new EventEmitter();
  const runCalls: Array<{ sessionId: string; execId: string; cmd: string; cwd: string }> = [];
  const client: CoreClientLike = {
    on(eventName: string, listener: (...args: unknown[]) => void) {
      emitter.on(eventName, listener);
      return client;
    },
    async start() { return FAKE_CORE_INFO; },
    async stop() { return; },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async run(request) {
      runCalls.push({ sessionId: request.sessionId, execId: request.execId, cmd: request.cmd, cwd: request.cwd });
      return new Promise<ExecResult>((resolve) => { runResolve = resolve; });
    },
    async ping() { return FAKE_CORE_INFO; },
    async cleanupSession() { return { ok: true as const }; },
    async readFile() { return { content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 0 }; },
    async listFiles() { return { entries: [], truncated: false }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    setRequestTimeoutMs() {},
  } as unknown as CoreClientLike;
  return {
    client,
    release: (result) => { if (runResolve) { runResolve(result); runResolve = undefined; } },
    runCalls,
  };
}

async function setup(provider: Provider) {
  const root = await tempRoot();
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(provider);
  const core = createControllableCore();
  const agent = new AgentRunner(sessions, providers, core.client, events, pricing);
  const app = await buildServer({ core: core.client, sessions, agent, events, providers, pricing });
  // 真监听随机端口：cli 是独立子进程，只能走 TCP/WS
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { root, sessions, events, core, app, baseUrl: `http://127.0.0.1:${port}` };
}

function runCli(args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli 子进程超时。stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe("headless CLI（owc run）", () => {
  it("文本模式：stdout 含 assistant 文本，agent.state=idle 后退出码 0", async () => {
    const harness = await setup(textProvider);
    try {
      const result = await runCli(["run", "say hi", "--cwd", harness.root, "--server", harness.baseUrl]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("hello from assistant");
    } finally {
      await harness.app.close();
    }
  }, 40_000);

  it("ask 模式 + 需审批工具（无 --yolo）：退出码 2", async () => {
    const harness = await setup(bashProvider);
    try {
      const session = await harness.sessions.create({ cwd: harness.root, provider: "test-stub", model: "deterministic-tool-loop", title: "cli ask" });
      await harness.sessions.updatePermissions(session.id, "ask", []);
      const result = await runCli(["run", "run ls", "--session", session.id, "--server", harness.baseUrl]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("审批");
    } finally {
      await harness.app.close();
    }
  }, 40_000);

  it("--yolo：permission.request 自动 allow，工具执行后退出码 0", async () => {
    const harness = await setup(bashProvider);
    try {
      const session = await harness.sessions.create({ cwd: harness.root, provider: "test-stub", model: "deterministic-tool-loop", title: "cli yolo" });
      await harness.sessions.updatePermissions(session.id, "ask", []);
      const running = runCli(["run", "run ls", "--session", session.id, "--server", harness.baseUrl, "--yolo"]);
      // 自动 allow 后工具真正执行：core.run 被调用，release 驱动完成
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1), { timeout: 10_000 });
      harness.core.release({ exitCode: 0, durationMs: 1, truncated: false });
      const result = await running;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("command finished");
      expect(result.stdout).toContain("[tool: bash]");
    } finally {
      await harness.app.close();
    }
  }, 40_000);

  it("--json：stdout 每行都是可 JSON.parse 的 NDJSON 事件", async () => {
    const harness = await setup(textProvider);
    try {
      const result = await runCli(["run", "say hi", "--cwd", harness.root, "--server", harness.baseUrl, "--json"]);
      expect(result.code).toBe(0);
      const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      const events = lines.map((line) => JSON.parse(line) as { type?: string });
      expect(events.map((event) => event.type)).toContain("message.delta");
      expect(events.map((event) => event.type)).toContain("agent.state");
    } finally {
      await harness.app.close();
    }
  }, 40_000);
});

describe("CLI --help", () => {
  it("owc --help / -h：打印双语帮助，退出码 0，无需 server", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli([flag], 10_000);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("用法");
      expect(result.stdout).toContain("owc run");
      expect(result.stdout).toContain("--yolo");
      expect(result.stdout).toContain("Exit codes");
      expect(result.stdout).toContain("OWC_ACCESS_TOKEN");
    }
  }, 30_000);

  it("owc run --help：打印帮助，退出码 0", async () => {
    const result = await runCli(["run", "--help"], 10_000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--session");
  }, 30_000);

  it("未知命令：帮助写 stderr，退出码 1", async () => {
    const result = await runCli(["frobnicate"], 10_000);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("用法");
  }, 30_000);
});
