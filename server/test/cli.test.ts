import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeControllableCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

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

async function setup(provider: Provider) {
  const root = await tempRoot("owc-cli-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(provider);
  const core = makeControllableCore();
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

describe("CLI 工具限制旗标", () => {
  it("--read-only 与 --tools 互斥：报错误退出码 1，不连接 server", async () => {
    const result = await runCli(["run", "hi", "--read-only", "--tools", "read_file"], 10_000);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("互斥");
  }, 30_000);

  it("--tools / --exclude-tools 缺值：打印用法退出码 1", async () => {
    for (const args of [["run", "hi", "--tools"], ["run", "hi", "--exclude-tools"]]) {
      const result = await runCli(args, 10_000);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("用法");
    }
  }, 30_000);

  it("--tools/--exclude-tools：新建会话携带 toolsAllow/toolsDeny 并持久化", async () => {
    const harness = await setup(textProvider);
    try {
      const result = await runCli(["run", "say hi", "--cwd", harness.root, "--server", harness.baseUrl, "--tools", "read_file, grep ,", "--exclude-tools", "grep"], 40_000);
      expect(result.code).toBe(0);
      const created = (await harness.sessions.list()).find((session) => session.toolsAllow !== undefined);
      expect(created).toMatchObject({ toolsAllow: ["read_file", "grep"], toolsDeny: ["grep"] });
    } finally {
      await harness.app.close();
    }
  }, 50_000);

  it("--read-only：等价 toolsAllow=只读集（含 read_file，不含 bash/write_file）", async () => {
    const harness = await setup(textProvider);
    try {
      const result = await runCli(["run", "say hi", "--cwd", harness.root, "--server", harness.baseUrl, "--read-only"], 40_000);
      expect(result.code).toBe(0);
      const created = (await harness.sessions.list()).find((session) => session.toolsAllow !== undefined);
      expect(created?.toolsAllow).toContain("read_file");
      expect(created?.toolsAllow).toContain("repo_map");
      expect(created?.toolsAllow).not.toContain("bash");
      expect(created?.toolsAllow).not.toContain("write_file");
    } finally {
      await harness.app.close();
    }
  }, 50_000);
});

describe("CLI --fallback-models", () => {
  it("格式错误（缺 / 或空段）：报错误退出码 1，不连接 server", async () => {
    for (const value of ["no-slash", "/model", "provider/"]) {
      const result = await runCli(["run", "hi", "--fallback-models", value], 10_000);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--fallback-models 格式错误");
    }
  }, 30_000);

  it("超过 3 个：报错误退出码 1", async () => {
    const result = await runCli(["run", "hi", "--fallback-models", "a/1,b/2,c/3,d/4"], 10_000);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("最多 3 个");
  }, 30_000);

  it("合法：新建会话携带 fallbackModels 并持久化（重复项被剔除）", async () => {
    const harness = await setup(textProvider);
    try {
      const result = await runCli(["run", "say hi", "--cwd", harness.root, "--server", harness.baseUrl, "--fallback-models", "test-stub/m2, test-stub/m2"], 40_000);
      expect(result.code).toBe(0);
      const created = (await harness.sessions.list()).find((session) => session.fallbackModels !== undefined);
      expect(created?.fallbackModels).toEqual([{ provider: "test-stub", model: "m2" }]);
    } finally {
      await harness.app.close();
    }
  }, 50_000);
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
    // owc run --help 同样打印帮助，退出码 0
    const runHelp = await runCli(["run", "--help"], 10_000);
    expect(runHelp.code).toBe(0);
    expect(runHelp.stdout).toContain("--session");
  }, 30_000);

  it("未知命令：帮助写 stderr，退出码 1", async () => {
    const result = await runCli(["frobnicate"], 10_000);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("用法");
  }, 30_000);
});
