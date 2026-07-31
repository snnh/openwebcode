import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, CoreRpcError, type CoreClientLike, type ExecResult, type PtyInputRequest, type PtyOpenRequest } from "../src/core-client.js";
import {
  MAX_SHELL_OUTPUT_CHARS,
  PersistentShellManager,
  PersistentShellUnavailableError,
  SentinelParser,
  repairShellOutput,
  errorlevelResetLine,
  sentinelLine,
  shellInitLines,
  stripAnsi,
  venvActivationCommand,
} from "../src/agent/persistent-shell.js";
import { UvPythonEnvironments } from "../src/python-env.js";
import { detectHostShells } from "../src/agent/shell-detect.js";
import { defaultSandboxPolicy } from "../src/sessions/default-sandbox.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { SessionMeta, ShellBackend } from "../src/sessions/types.js";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

const roots: string[] = [];
const clients: CoreClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => undefined)));
  // Windows 竞态：pty 进程树（pwsh/conhost）退出滞后于 closePty，残留句柄会让 rm 撞 EBUSY，重试几次
  await Promise.all(roots.splice(0).map(async (root) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }));
});

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
const hasCore = existsSync(corePath);
const isWindows = process.platform === "win32";
const hasPwsh = isWindows && spawnSync("pwsh", ["--version"], { windowsHide: true }).status === 0;
const gitBashPath = isWindows ? detectHostShells("win32", process.env, existsSync).gitBash : undefined;

// ---------- 纯单测：sentinel 解析器 ----------

describe("SentinelParser（纯单测）", () => {
  const rand = "abc123";
  const cmdLine = "echo hello";
  const sentinel = sentinelLine("cmd", rand);

  function makeParser(echoLines: string[] = [cmdLine, sentinel]) {
    return { parser: new SentinelParser(rand, echoLines), sentinelLine: sentinel };
  }

  it("回显行被跳过，独立成行的 sentinel 解析出 exit code", () => {
    const { parser, sentinelLine: line } = makeParser();
    const text = `D:\\work>${cmdLine}\r\nhello\r\nD:\\work>${line}\r\n__OWC_DONE_${rand}_0__\r\nD:\\work>`;
    expect(parser.feed(text)).toBe(0);
    expect(parser.output()).toBe("hello");
  });

  it("非零与负 exit code 均可解析", () => {
    const { parser } = makeParser();
    expect(parser.feed(`${cmdLine}\n__OWC_DONE_${rand}_-1073741510__\n`)).toBe(-1073741510);
  });

  it("pwsh 空码（$LASTEXITCODE 为 $null）按 0 处理", () => {
    const { parser } = makeParser();
    expect(parser.feed(`out\n__OWC_DONE_${rand}___\n`)).toBe(0);
    expect(parser.output()).toBe("out");
  });

  it("CRLF 与多行输出：换行归一，输出保持行序", () => {
    const { parser, sentinelLine: line } = makeParser();
    const text = `${cmdLine}\r\nline1\r\nline2\r\n  padded  \r\n${line}\r\n__OWC_DONE_${rand}_3__\r\n`;
    expect(parser.feed(text)).toBe(3);
    expect(parser.output()).toBe("line1\nline2\n  padded");
  });

  it("sentinel 跨 chunk 拼接：分块到达不误判", () => {
    const { parser } = makeParser();
    expect(parser.feed(`${cmdLine}\npart1\n__OWC_D`)).toBeNull();
    expect(parser.feed(`ONE_${rand}_7`)).toBeNull();
    expect(parser.feed(`__\r\n`)).toBe(7);
    expect(parser.output()).toBe("part1");
  });

  it("伪 sentinel（随机后缀不同）按普通输出保留，不触发结束", () => {
    const { parser, sentinelLine: line } = makeParser();
    expect(parser.feed(`${cmdLine}\n__OWC_DONE_000000000000_9__\nreal output\n`)).toBeNull();
    expect(parser.feed(`${line}\n__OWC_DONE_${rand}_0__\n`)).toBe(0);
    const output = parser.output();
    expect(output).toContain("__OWC_DONE_000000000000_9__");
    expect(output).toContain("real output");
  });

  it("回显行内嵌 marker（未展开 %ERRORLEVEL%）不匹配、不进入输出", () => {
    const { parser, sentinelLine: line } = makeParser();
    const text = `D:\\work>${cmdLine}\nout\nD:\\work>${line}\n__OWC_DONE_${rand}_1__\n`;
    expect(parser.feed(text)).toBe(1);
    expect(parser.output()).toBe("out");
  });

  it("输出超过上限截断（truncated=true），仍继续扫 sentinel", () => {
    const { parser } = makeParser();
    const big = "x".repeat(MAX_SHELL_OUTPUT_CHARS + 100);
    expect(parser.feed(`${cmdLine}\n${big}\n`)).toBeNull();
    expect(parser.truncated).toBe(true);
    expect(parser.feed(`__OWC_DONE_${rand}_0__\n`)).toBe(0);
  });

  it("ANSI 转义序列被剥离（PSReadLine 重绘/颜色不影响匹配）", () => {
    const { parser } = makeParser();
    const colored = `\x1b[93m${cmdLine}\x1b[0m\n\x1b[36mhello\x1b[0m\n__OWC_DONE_${rand}_0__\n`;
    expect(parser.feed(colored)).toBe(0);
    expect(parser.output()).toBe("hello");
    expect(stripAnsi("\x1b]0;title\x07rest")).toBe("rest");
  });

  it("命中后余量清空：尾随的新提示符不污染下一条命令", () => {
    const { parser } = makeParser();
    expect(parser.feed(`${cmdLine}\nout\n__OWC_DONE_${rand}_0__\nD:\\work>`)).toBe(0);
    const next = new SentinelParser("def456", ["echo next", sentinelLine("cmd", "def456")]);
    expect(next.feed("D:\\work>echo next\nnext out\n__OWC_DONE_def456_0__\n")).toBe(0);
    expect(next.output()).toBe("next out");
  });

  it("sentinel 后无换行（ConPTY 用光标定位序列接续提示符）也能命中", () => {
    const { parser } = makeParser();
    const text = `${cmdLine}\r\nout\r\n__OWC_DONE_${rand}_0__\x1b[11;1HD:\\work>\x1b[?25h`;
    expect(parser.feed(text)).toBe(0);
    expect(parser.output()).toBe("out");
  });

  it("sentinel 与无换行输出粘连（printf 无尾换行）也能命中", () => {
    const { parser } = makeParser();
    expect(parser.feed(`${cmdLine}\r\nprintf-out__OWC_DONE_${rand}_2__`)).toBe(2);
    expect(parser.output()).toBe("printf-out");
  });

  it("sentinelLine / venvActivationCommand 三语法族（cmd/pwsh/sh，含 Windows Git Bash）", () => {
    expect(sentinelLine("cmd", "r1")).toBe("echo __OWC_DONE_r1_%ERRORLEVEL%__");
    expect(sentinelLine("sh", "r1")).toBe("echo __OWC_DONE_r1_$?__");
    expect(sentinelLine("pwsh", "r1")).toContain("__OWC_DONE_r1_$(");
    expect(sentinelLine("pwsh", "r1")).toContain("$global:LASTEXITCODE = 0");
    expect(venvActivationCommand("cmd", "C:\\v", "win32")).toBe('set "PATH=C:\\v\\Scripts;%PATH%"');
    expect(venvActivationCommand("sh", "/v", "linux")).toBe("export PATH='/v/bin':$PATH");
    // Windows Git Bash：venv 仍在 Scripts，反斜杠必须转正斜杠（bash 里 \ 是转义符）
    expect(venvActivationCommand("sh", "C:\\v", "win32")).toBe("export PATH='C:/v/Scripts':$PATH");
    expect(venvActivationCommand("pwsh", "C:\\v", "win32")).toBe("$env:Path = 'C:\\v\\Scripts;' + $env:Path");
  });

  it("shellInitLines：cmd 仅 chcp 65001（pty 已在 cwd）；pwsh 带落点校验；posix 归一 cd；Git Bash chcp.com + 正斜杠 cd", () => {
    expect(shellInitLines("cmd", "C:\\w", "win32")).toEqual(["chcp 65001"]);
    expect(shellInitLines("sh", "/w", "linux")).toEqual(["cd '/w'"]);
    expect(shellInitLines("sh", "C:\\w", "win32")).toEqual(["chcp.com 65001", "cd 'C:/w'"]);
    const pwsh = shellInitLines("pwsh", "C:\\w", "win32");
    expect(pwsh[0]).toContain("HistorySaveStyle SaveNothing");
    expect(pwsh[1]).toContain("Set-Location -LiteralPath 'C:\\w'");
    expect(pwsh[2]).toContain("$PWD.Path -ieq 'C:\\w'");
    expect(shellInitLines("pwsh", "/w", "linux")[2]).toContain("$PWD.Path -ceq '/w'");
  });

  it("errorlevelResetLine：仅 win cmd 需要 (call ) 复位", () => {
    expect(errorlevelResetLine("cmd", "win32")).toBe("(call )");
    expect(errorlevelResetLine("sh", "linux")).toBeNull();
    expect(errorlevelResetLine("sh", "win32")).toBeNull(); // Git Bash 走 $?，无陈旧 ERRORLEVEL
    expect(errorlevelResetLine("pwsh", "win32")).toBeNull();
  });
});

describe("repairShellOutput（代码页修复）", () => {
  const GBK_DENIED = Buffer.from([0xBE, 0xDC, 0xBE, 0xF8, 0xB7, 0xC3, 0xCE, 0xCA, 0xA1, 0xA3]); // GBK: 拒绝访问。

  it("lossy UTF-8 乱码按 GBK 重解码", () => {
    const rand = "a1b2c3d4e5f6";
    // 完整一轮：命令回显 + GBK 错误输出 + sentinel（ASCII 与 GBK 兼容）
    const raw = Buffer.concat([
      Buffer.from("D:\\work>dir\r\n", "ascii"),
      GBK_DENIED,
      Buffer.from("\r\n__OWC_DONE_a1b2c3d4e5f6_0__\r\n", "ascii"),
    ]);
    const lossy = raw.toString("utf8");
    expect(lossy).toContain("\uFFFD");
    expect(repairShellOutput(lossy, [raw], rand, ["dir"])).toContain("拒绝访问。");
  });

  it("正常 UTF-8 输出原样返回；空 raw 不重解码", () => {
    expect(repairShellOutput("正常输出", [], "a1b2c3d4e5f6", ["echo"])).toBe("正常输出");
    expect(repairShellOutput("含�但无原始字节", [], "a1b2c3d4e5f6", ["echo"])).toBe("含�但无原始字节");
  });
});

// ---------- 纯单测：manager（fake core 带 pty） ----------

interface FakePty {
  core: CoreClientLike;
  emitter: EventEmitter;
  openCalls: PtyOpenRequest[];
  inputCalls: PtyInputRequest[];
  closeCalls: number[];
  failOpen?: Error;
}

function makeFakePtyCore(): FakePty {
  const emitter = new EventEmitter();
  const fake: FakePty = {
    emitter,
    openCalls: [],
    inputCalls: [],
    closeCalls: [],
    core: undefined as unknown as CoreClientLike,
  };
  fake.core = {
    on() { return fake.core; },
    async configureSession() { return { sandboxCapability: "enforced" }; },
    async openPty(request: PtyOpenRequest) {
      fake.openCalls.push(request);
      if (fake.failOpen) throw fake.failOpen;
      return { ptyId: 1, sandboxCapability: "enforced", sandboxReason: "test" };
    },
    async inputPty(request: PtyInputRequest) {
      fake.inputCalls.push(request);
      return { ok: true as const };
    },
    async closePty(request: { ptyId: number }) {
      fake.closeCalls.push(request.ptyId);
      return { ok: true as const };
    },
    ptyEvents: () => emitter,
    removePtyEvents: () => undefined,
  } as unknown as CoreClientLike;
  return fake;
}

function fakeSession(id: string, backend: ShellBackend = "cmd"): SessionMeta {
  return { id, cwd: "D:\\work", provider: "test", model: "test", shellBackend: backend } as SessionMeta;
}

function decodeInputs(fake: FakePty): string {
  return fake.inputCalls.map((call) => Buffer.from(call.data, "base64").toString("utf8")).join("");
}

function emitOutput(fake: FakePty, text: string): void {
  fake.emitter.emit("output", { data: Buffer.from(text, "utf8").toString("base64") });
}

describe("PersistentShellManager（fake core）", () => {
  const newManager = (core: CoreClientLike) => new PersistentShellManager(core, new UvPythonEnvironments(), () => "global");

  // ensureShell 现在有两次 sentinel 往返：init（cd/激活）+ 用户命令。应答输入流中所有尚未应答的 rand。
  const acked = new Set<string>();
  async function drive(fake: FakePty): Promise<void> {
    for (const m of decodeInputs(fake).matchAll(/__OWC_DONE_([0-9a-f]{12})_/g)) {
      if (!acked.has(m[1]!)) {
        acked.add(m[1]!);
        emitOutput(fake, `__OWC_DONE_${m[1]}_0__\n`);
      }
    }
  }

  /** 标准一轮驱动：run → drain → init sentinel → 等用户命令下发 → （可选）推用户输出 → 命令 sentinel → 收结果 */
  async function runDriven(
    fake: FakePty,
    manager: PersistentShellManager,
    session: SessionMeta,
    cmd: string,
    emitUserOutput?: () => void,
  ) {
    const run = manager.run(session, cmd, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 600)); // drain
    await drive(fake); // init 往返
    await new Promise((resolve) => setTimeout(resolve, 50)); // 等用户命令下发
    emitUserOutput?.();
    await drive(fake); // 用户命令 sentinel
    return run;
  }

  it("open 参数：sandbox=true / 会话 cwd / 后端 shell；init sentinel + (call ) 复位 + 命令 + sentinel 作为输入下发", async () => {
    const fake = makeFakePtyCore();
    const manager = newManager(fake.core);
    const session = fakeSession("s1");
    const result = await runDriven(fake, manager, session, "echo hi", () => emitOutput(fake, `D:\\work>echo hi\r\nhi\r\n`));
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("hi");
    expect(fake.openCalls[0]).toMatchObject({ session: "s1", cwd: "D:\\work", sandbox: true, shell: isWindows ? "cmd.exe" : expect.any(String) });
    const sent = decodeInputs(fake);
    if (isWindows) {
      expect(sent).toContain("(call )"); // ERRORLEVEL 复位在每条用户命令前
      expect(sent).not.toContain("cd /d"); // cmd 由 core 以会话 cwd 启动，不做 init cd（AppContainer 下必失败）
    } else {
      expect(sent).toContain("cd 'D:\\work'"); // posix init 归一 cwd
    }
    expect(sent).toContain("echo hi");
  });

  it("同会话 bash 调用串行化：第二条输入在第一条 sentinel 结算后才下发", async () => {
    const fake = makeFakePtyCore();
    const manager = newManager(fake.core);
    const session = fakeSession("s1");
    const first = manager.run(session, "cmd-one", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await drive(fake); // init
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = manager.run(session, "cmd-two", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decodeInputs(fake)).toContain("cmd-one");
    expect(decodeInputs(fake)).not.toContain("cmd-two"); // 未交错
    emitOutput(fake, "one-out\n");
    await drive(fake); // cmd-one sentinel
    await first;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decodeInputs(fake)).toContain("cmd-two");
    emitOutput(fake, "two-out\n");
    await drive(fake); // cmd-two sentinel
    const secondResult = await second;
    expect(secondResult.output).toBe("two-out");
  });

  it("GBK（CP936）输出乱码时按原始字节重解码", async () => {
    const fake = makeFakePtyCore();
    const manager = newManager(fake.core);
    const session = fakeSession("s1");
    // GBK 编码的"拒绝访问。"（cmd 中文错误的典型形态）
    const result = await runDriven(fake, manager, session, "dir", () => {
      fake.emitter.emit("output", { data: Buffer.from([0xBE, 0xDC, 0xBE, 0xF8, 0xB7, 0xC3, 0xCE, 0xCA, 0xA1, 0xA3, 0x0D, 0x0A]).toString("base64") });
    });
    expect(result.output).toContain("拒绝访问。");
    expect(result.output).not.toContain("�");
  });

  it("core 重启后 pty not found：销毁重建并重试同一命令", async () => {
    const fake = makeFakePtyCore();
    const manager = newManager(fake.core);
    const session = fakeSession("s1");
    await runDriven(fake, manager, session, "echo one", () => emitOutput(fake, "one\n"));
    expect(fake.openCalls).toHaveLength(1);

    // 模拟 core 重启：旧 ptyId 失效，下一次 input 报 pty not found（仅失败一次）
    let failures = 1;
    (fake.core as unknown as { inputPty: (request: PtyInputRequest) => Promise<{ ok: true }> }).inputPty =
      async (request: PtyInputRequest) => {
        fake.inputCalls.push(request);
        if (failures-- > 0) throw new CoreRpcError(-32003, "pty not found");
        return { ok: true as const };
      };
    const result = await runDriven(fake, manager, session, "echo two", () => emitOutput(fake, "two\n"));
    expect(result.output).toBe("two");
    expect(fake.openCalls).toHaveLength(2);
  });

  it("pty.exit 后在途命令报错；下一条命令透明重建（再次 openPty）", async () => {
    const fake = makeFakePtyCore();
    const manager = newManager(fake.core);
    const session = fakeSession("s1");
    const first = manager.run(session, "exit", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await drive(fake); // init
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decodeInputs(fake)).toContain("exit");
    fake.emitter.emit("exit", { exitCode: 0 });
    await expect(first).rejects.toThrow(/Persistent shell exited/);
    const second = runDriven(fake, manager, session, "echo back", () => emitOutput(fake, "back\n"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fake.openCalls).toHaveLength(2);
    expect((await second).output).toBe("back");
    expect(decodeInputs(fake)).toContain("echo back");
  });

  it("disposeSession 回收持久 pty（closePty + 从表中移除）", async () => {
    const fake = makeFakePtyCore();
    const manager = newManager(fake.core);
    const session = fakeSession("s1");
    await runDriven(fake, manager, session, "echo hi", () => emitOutput(fake, "hi\n"));
    manager.disposeSession("s1");
    expect(fake.closeCalls).toEqual([1]);
  });

  it("init 非零（shell 进不了 cwd）抛 Unavailable 并缓存，后续直接回退不再开 pty", async () => {
    const fake = makeFakePtyCore();
    const manager = newManager(fake.core);
    const session = fakeSession("s1");
    const run = manager.run(session, "echo hi", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const rand = /__OWC_DONE_([0-9a-f]{12})_/.exec(decodeInputs(fake))![1]!;
    acked.add(rand);
    emitOutput(fake, `__OWC_DONE_${rand}_1__\n`); // init 失败（模拟 pwsh 落 C:\）
    await expect(run).rejects.toBeInstanceOf(PersistentShellUnavailableError);
    await expect(manager.run(session, "echo again", new AbortController().signal))
      .rejects.toBeInstanceOf(PersistentShellUnavailableError);
    expect(fake.openCalls).toHaveLength(1); // 第二次直接回退，不再开 pty
  });

  it("open 失败（能力缺失 -32601）抛 PersistentShellUnavailableError 供回退", async () => {
    const fake = makeFakePtyCore();
    fake.failOpen = new CoreRpcError(-32601, "unknown method pty.open");
    const manager = newManager(fake.core);
    await expect(manager.run(fakeSession("s1"), "echo hi", new AbortController().signal))
      .rejects.toBeInstanceOf(PersistentShellUnavailableError);
    expect(manager.supported).toBe(false); // 能力级失败缓存，后续直接回退
  });
});

// ---------- 真 core 集成（缺二进制跳过） ----------

describe.skipIf(!hasCore)("PersistentShellManager（真 core）", () => {
  async function setup(backend: ShellBackend = "cmd", sandboxMode?: "jobobject") {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-pshell-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test", title: "pshell" });
    await sessions.updateConfig(session.id, { provider: "test", model: "test", shellBackend: backend });
    const meta = (await sessions.get(session.id))!;
    // MSYS bash 在 AppContainer 下 DLL 初始化失败（0xC0000142）；真实会话经 CoreRouter
    // 缺省走 jobobject 兼容模式，测试显式对齐（cmd/pwsh 用例保持 AppContainer 默认）
    if (sandboxMode) meta.sandbox = { ...defaultSandboxPolicy(root), mode: sandboxMode };
    const client = new CoreClient(corePath);
    clients.push(client);
    await client.start();
    await client.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: meta.sandbox ?? defaultSandboxPolicy(session.cwd) });
    const manager = new PersistentShellManager(client, new UvPythonEnvironments(), () => "global");
    const controller = new AbortController();
    const run = (cmd: string) => manager.run(meta, cmd, controller.signal);
    return { root, session, meta, client, manager, controller, run };
  }

  it("cd 跨调用保持", async () => {
    const { run, manager, session } = await setup();
    await run(isWindows ? "mkdir owcpsub" : "mkdir -p owcpsub");
    await run("cd owcpsub");
    const result = await run(isWindows ? "cd" : "pwd");
    expect(result.exitCode).toBe(0);
    expect(result.output.replace(/\//g, "\\")).toContain("owcpsub");
    manager.disposeSession(session.id);
  }, 30_000);

  it("环境变量跨调用保持（win=cmd / posix=sh）", async () => {
    const { run, manager, session } = await setup("cmd");
    await run(isWindows ? "set OWC_PS_VAR=hello42" : "export OWC_PS_VAR=hello42");
    const result = await run(isWindows ? "echo %OWC_PS_VAR%" : "echo $OWC_PS_VAR");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello42");
    manager.disposeSession(session.id);
  }, 30_000);

  // pwsh / Git Bash 两后端同一脚本：cd 与 env 跨调用保持；后端起不来时按设计回退一次性 exec -> skip
  for (const { name, available, backend, sandboxMode, mkdirCmd, cwdCmd, setEnvCmd, echoEnvCmd } of [
    {
      name: "pwsh 后端：cd 与 $env: 跨调用保持（AppContainer 下工作区不可达时回退跳过）",
      available: isWindows && hasPwsh,
      backend: "pwsh" as ShellBackend,
      sandboxMode: undefined as "jobobject" | undefined,
      mkdirCmd: "mkdir owcpsub",
      cwdCmd: "Get-Location",
      setEnvCmd: `$env:OWC_PS_VAR = "hello42"`,
      echoEnvCmd: "echo $env:OWC_PS_VAR",
    },
    {
      name: "Git Bash 后端：POSIX 语法 + cd/env 跨调用保持（jobobject 兼容模式）",
      available: isWindows && !!gitBashPath,
      backend: "bash" as ShellBackend,
      sandboxMode: "jobobject" as const,
      mkdirCmd: "mkdir -p owcpsub",
      cwdCmd: "pwd",
      setEnvCmd: "export OWC_PS_VAR=hello42",
      echoEnvCmd: "echo $OWC_PS_VAR",
    },
  ]) {
    it.skipIf(!available)(name, async (ctx) => {
      const { run, manager, session } = await setup(backend, sandboxMode);
      try {
        await run(mkdirCmd);
        await run("cd owcpsub");
        const cwd = await run(cwdCmd);
        expect(cwd.output.replace(/\//g, "\\")).toContain("owcpsub");
        await run(setEnvCmd);
        const env = await run(echoEnvCmd);
        expect(env.output).toContain("hello42");
      } catch (error) {
        // core AppContainer 的祖先 traverse 授权在非用户自有 ACL 上不生效 / MSYS bash 在
        // AppContainer/ConPTY 下起不来 -> init 校验失败 -> 回退一次性 exec.run（设计内降级）
        if (error instanceof PersistentShellUnavailableError) {
          manager.disposeSession(session.id);
          ctx.skip();
        }
        throw error;
      }
      manager.disposeSession(session.id);
    }, 60_000);
  }

  it("非零 exit code 正确解析", async () => {
    const { run, manager, session } = await setup();
    const result = await run(isWindows ? "cmd /c exit 5" : "(exit 5)");
    expect(result.exitCode).toBe(5);
    const ok = await run(isWindows ? "cmd /c exit 0" : "true");
    expect(ok.exitCode).toBe(0);
    manager.disposeSession(session.id);
  }, 30_000);

  it("多行输出 + 伪 sentinel 文本不触发提前结束", async () => {
    const { run, manager, session } = await setup();
    const result = await run(isWindows
      ? "echo line1& echo __OWC_DONE_000000000000_9__& echo line3"
      : "printf 'line1\\n__OWC_DONE_000000000000_9__\\nline3\\n'");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("line1");
    expect(result.output).toContain("__OWC_DONE_000000000000_9__");
    expect(result.output).toContain("line3");
    manager.disposeSession(session.id);
  }, 30_000);

  it("并发 bash 调用串行化：输出不交错", async () => {
    const { run, manager, session } = await setup();
    const [first, second] = await Promise.all([
      run(isWindows ? "ping -n 3 127.0.0.1 & echo FIRST_MARK" : "sleep 1; echo FIRST_MARK"),
      run("echo SECOND_MARK"),
    ]);
    expect(first.output).toContain("FIRST_MARK");
    expect(first.output).not.toContain("SECOND_MARK");
    expect(second.output).toContain("SECOND_MARK");
    expect(second.output).not.toContain("FIRST_MARK");
    manager.disposeSession(session.id);
  }, 60_000);

  it("shell 被杀（exit）后下一条命令透明重建", async () => {
    const { run, manager, session } = await setup();
    await expect(run("exit")).rejects.toThrow(/Persistent shell exited/);
    const result = await run("echo BACK_AGAIN");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("BACK_AGAIN");
    manager.disposeSession(session.id);
  }, 30_000);
});

// ---------- AgentRunner 集成：pty 缺失回退 + run_in_background 不受影响 ----------

describe("bash 工具集成（fake core 无 pty → 回退一次性 exec）", () => {
  it("持久 shell 不可用时 runShell 仍走 core.run（回退不报错）", async () => {
    const root = await tempRoot("owc-pshell-fb-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "stub", model: "m", title: "fallback" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("stub"));
    const runCalls: string[] = [];
    // 故意不提供 openPty/inputPty/closePty/ptyEvents：模拟旧 core
    const core = makeFakeCore({
      async run(request) { runCalls.push(request.cmd); return { exitCode: 0, durationMs: 1, truncated: false } as ExecResult; },
    });
    const agent = new AgentRunner(sessions, providers, core, new EventBus(), pricing);
    await agent.runShell(session.id, "echo fallback-ok");
    expect(runCalls).toEqual(["echo fallback-ok"]);
    const detail = await sessions.get(session.id);
    const toolResult = detail?.messages.find((m) => m.role === "tool")?.content[0] as { isError?: boolean; content: string };
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content).toContain('"exitCode":0');
  }, 15_000);

  it("run_in_background 不受影响：仍走 backgroundTasks.start，不触持久 shell", async () => {
    const root = await tempRoot("owc-pshell-bg-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "m", title: "bg" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const queue: Array<Array<Record<string, unknown>>> = [
      [{ type: "tool_call", id: "bg-1", name: "bash", input: { cmd: "npm run build", run_in_background: true } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "text_delta", text: "ok" }, { type: "done", stopReason: "end_turn" }],
    ];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request: StreamChatRequest) {
        request.signal.throwIfAborted();
        const batch = queue.shift() ?? [{ type: "text_delta", text: "done" }, { type: "done", stopReason: "end_turn" }];
        for (const event of batch) yield event as never;
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const starts: Array<{ cmd: string; shellBackend?: string }> = [];
    const backgroundTasks = {
      start: async (request: { cmd: string; shellBackend?: string }) => { starts.push(request); },
      hasRunningForSession: () => false,
      drainNotices: () => [],
    };
    // 无 pty 方法：run_in_background 分支本就不触持久 shell
    const core = makeFakeCore({
      async run() { throw new Error("run_in_background 不应走 exec.run"); },
    });
    const agent = new AgentRunner(
      sessions, providers, core, new EventBus(), pricing,
      undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      backgroundTasks as never,
    );
    await agent.run(session.id, "后台构建");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ cmd: "npm run build" });
    const detail = await sessions.get(session.id);
    const toolResult = detail?.messages.filter((m) => m.role === "tool").at(-1)?.content[0] as { isError?: boolean; content: string };
    expect(toolResult.isError).toBe(false);
    expect(JSON.parse(toolResult.content)).toMatchObject({ status: "started" });
  }, 15_000);
});
