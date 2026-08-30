import { existsSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreClient, CoreRpcError, type CoreClientLike, type ExecResult, type PtyInputRequest, type PtyOpenRequest } from "../src/core-client.js";
import {
  MAX_SHELL_OUTPUT_CHARS,
  PersistentShellManager,
  PersistentShellUnavailableError,
  SentinelParser,
  repairShellOutput,
  errorlevelResetLine,
  sanitizeShellOutput,
  sentinelLine,
  shellInitLines,
  stripAnsi,
  venvActivationCommand,
} from "../src/agent/persistent-shell.js";
import { UvPythonEnvironments } from "../src/python-env.js";
import { NodeEnvManagers } from "../src/node-env.js";
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
import { tempRoot, tempRootRetry } from "./helpers/temp-roots.js";

const clients: CoreClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => undefined)));
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

  it("rawTail 上限：未终结的超长 OSC 按普通文本放行，后续 sentinel 正常命中", () => {
    const { parser } = makeParser();
    // 未终结 OSC 超过 4KB：不设上限时残段会把后续每个 chunk（含 sentinel）一并吞进 rawTail
    expect(parser.feed(`${cmdLine}\nout\n\x1b]${"A".repeat(10_000)}`)).toBeNull();
    expect(parser.feed(`__OWC_DONE_${rand}_7__`)).toBe(7);
    expect(parser.output()).toContain("out");
  });

  it("输出清洗（对齐 pi）：\\r 覆写帧拼接、控制字符与 Unicode Format 字符剥离，\\t 保留", () => {
    expect(sanitizeShellOutput("a\x00b\x7fc\uFFF9d\te\nf")).toBe("abcd\te\nf");
    const { parser } = makeParser();
    // 进度条覆写（\r 不回车换行）与夹杂的控制字符：\r 全删后帧直接拼接，控制字符剥离
    expect(parser.feed(`${cmdLine}\r\nloading 10%\rloading 20%\x07done\x01!\r\n__OWC_DONE_${rand}_0__\r\n`)).toBe(0);
    expect(parser.output()).toBe("loading 10%loading 20%done!");
  });

  it("命中后余量清空：尾随的新提示符不污染下一条命令", () => {
    const { parser } = makeParser();
    expect(parser.feed(`${cmdLine}\nout\n__OWC_DONE_${rand}_0__\nD:\\work>`)).toBe(0);
    const next = new SentinelParser("def456", ["echo next", sentinelLine("cmd", "def456")]);
    expect(next.feed("D:\\work>echo next\nnext out\n__OWC_DONE_def456_0__\n")).toBe(0);
    expect(next.output()).toBe("next out");
  });

  it("sentinel 在缓冲末尾（无尾换行）也能命中：光标定位序列接续 / 输出粘连", () => {
    // ConPTY 用光标定位序列接续提示符
    const { parser } = makeParser();
    expect(parser.feed(`${cmdLine}\r\nout\r\n__OWC_DONE_${rand}_0__\x1b[11;1HD:\\work>\x1b[?25h`)).toBe(0);
    expect(parser.output()).toBe("out");
    // printf 无尾换行：输出与 sentinel 粘连
    const glued = makeParser();
    expect(glued.parser.feed(`${cmdLine}\r\nprintf-out__OWC_DONE_${rand}_2__`)).toBe(2);
    expect(glued.parser.output()).toBe("printf-out");
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

  it("shellInitLines：cmd chcp + pager 屏蔽（pty 已在 cwd）；pwsh 带落点校验；posix 归一 cd；Git Bash chcp.com + 正斜杠 cd", () => {
    expect(shellInitLines("cmd", "C:\\w", "win32")).toEqual(["chcp 65001", `set "PAGER=cat"`, `set "GIT_PAGER=cat"`]);
    expect(shellInitLines("sh", "/w", "linux")).toEqual(["export PAGER=cat GIT_PAGER=cat", "cd '/w'"]);
    expect(shellInitLines("sh", "C:\\w", "win32")).toEqual(["chcp.com 65001", "export PAGER=cat GIT_PAGER=cat", "cd 'C:/w'"]);
    const pwsh = shellInitLines("pwsh", "C:\\w", "win32");
    expect(pwsh[0]).toContain("HistorySaveStyle SaveNothing");
    expect(pwsh[1]).toContain("$env:PAGER = 'cat'; $env:GIT_PAGER = 'cat'");
    expect(pwsh[2]).toContain("Set-Location -LiteralPath 'C:\\w'");
    expect(pwsh[3]).toContain("$PWD.Path -ieq 'C:\\w'");
    expect(shellInitLines("pwsh", "/w", "linux")[3]).toContain("$PWD.Path -ceq '/w'");
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
    expect(repairShellOutput(lossy, [raw], rand, ["dir"], "win32")).toContain("拒绝访问。");
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
  const newManager = (core: CoreClientLike) => new PersistentShellManager(core, new UvPythonEnvironments(), () => "global", new NodeEnvManagers(), () => "global");

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // 各用例共用同一 fake core + manager + 会话（s1），仅输入/应答序列不同
  let fake: FakePty;
  let manager: PersistentShellManager;
  let session: SessionMeta;
  beforeEach(() => {
    fake = makeFakePtyCore();
    manager = newManager(fake.core);
    session = fakeSession("s1");
  });

  // ensureShell 现在有两次 sentinel 往返：init（cd/激活）+ 用户命令。acked 记录已应答的 rand，
  // 轮询输入流应答新出现的 rand（替代固定 sleep，慢机器上更稳）。
  const acked = new Set<string>();
  const pendingRands = (fake: FakePty): string[] =>
    [...decodeInputs(fake).matchAll(/__OWC_DONE_([0-9a-f]{12})_/g)].map((m) => m[1]!).filter((rand) => !acked.has(rand));

  async function waitPending(fake: FakePty): Promise<void> {
    await vi.waitFor(() => expect(pendingRands(fake).length).toBeGreaterThan(0), { timeout: 10_000, interval: 20 });
  }

  /** 等出现未应答的 sentinel rand 后全部以 exit 0 应答 */
  async function drive(fake: FakePty): Promise<void> {
    await waitPending(fake);
    for (const rand of pendingRands(fake)) {
      acked.add(rand);
      emitOutput(fake, `__OWC_DONE_${rand}_0__\n`);
    }
  }

  /** 等第一个未应答 rand 出现并标记（用于自定义应答的场景） */
  async function nextRand(fake: FakePty): Promise<string> {
    await waitPending(fake);
    const rand = pendingRands(fake)[0]!;
    acked.add(rand);
    return rand;
  }

  /** 等输入流出现 text（如用户命令已下发） */
  async function waitForInput(fake: FakePty, text: string): Promise<void> {
    await vi.waitFor(() => expect(decodeInputs(fake)).toContain(text), { timeout: 10_000, interval: 20 });
  }

  /** 标准一轮驱动：run → init sentinel → 等用户命令下发 → （可选）推用户输出 → 命令 sentinel → 收结果 */
  async function runDriven(
    fake: FakePty,
    manager: PersistentShellManager,
    session: SessionMeta,
    cmd: string,
    emitUserOutput?: () => void,
  ) {
    const run = manager.run(session, cmd, new AbortController().signal);
    await drive(fake); // init 往返
    await waitForInput(fake, cmd); // 等用户命令下发
    emitUserOutput?.();
    await drive(fake); // 用户命令 sentinel
    return run;
  }

  it("open 参数：sandbox=true / 会话 cwd / 后端 shell；init sentinel + (call ) 复位 + 命令 + sentinel 作为输入下发", async () => {
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

  it("开壳激活会话元数据环境变量（OWC_SESSION_ID/OWC_WORKSPACE 等随 init 注入一次）", async () => {
    await runDriven(fake, manager, session, "echo hi");
    const sent = decodeInputs(fake);
    expect(sent).toContain("OWC_SESSION_ID");
    expect(sent).toContain("s1");
    expect(sent).toContain("OWC_WORKSPACE");
    expect(sent).toContain("OWC_SANDBOX_MODE");
    expect(sent).toContain("OWC_AGENT_MODE");
  });

  it("同会话 bash 调用串行化：第二条输入在第一条 sentinel 结算后才下发", async () => {
    const first = manager.run(session, "cmd-one", new AbortController().signal);
    await drive(fake); // init
    await waitForInput(fake, "cmd-one");
    const second = manager.run(session, "cmd-two", new AbortController().signal);
    await sleep(100); // 负向断言需要一个观察窗口
    expect(decodeInputs(fake)).not.toContain("cmd-two"); // 未交错
    emitOutput(fake, "one-out\n");
    await drive(fake); // cmd-one sentinel
    await first;
    await waitForInput(fake, "cmd-two");
    emitOutput(fake, "two-out\n");
    await drive(fake); // cmd-two sentinel
    const secondResult = await second;
    expect(secondResult.output).toBe("two-out");
  });

  // GBK 回退仅 Windows 生效（decodeChildProcessOutput 按平台门控），Linux 上无法重解码
  it.skipIf(!isWindows)("GBK（CP936）输出乱码时按原始字节重解码", async () => {
    // GBK 编码的"拒绝访问。"（cmd 中文错误的典型形态）
    const result = await runDriven(fake, manager, session, "dir", () => {
      fake.emitter.emit("output", { data: Buffer.from([0xBE, 0xDC, 0xBE, 0xF8, 0xB7, 0xC3, 0xCE, 0xCA, 0xA1, 0xA3, 0x0D, 0x0A]).toString("base64") });
    });
    expect(result.output).toContain("拒绝访问。");
    expect(result.output).not.toContain("�");
  });

  it("core 重启后 pty not found：销毁重建并重试同一命令", async () => {
    await runDriven(fake, manager, session, "echo one", () => emitOutput(fake, "one\n"));
    expect(fake.openCalls).toHaveLength(1);

    // 模拟 core 重启：旧 ptyId 失效，下一次 input 报 pty not found（仅失败一次）
    let failures = 1;
    (fake.core as unknown as { inputPty: (request: PtyInputRequest) => Promise<{ ok: true }> }).inputPty =
      async (request: PtyInputRequest) => {
        fake.inputCalls.push(request);
        if (failures-- > 0) {
          // 失败尝试的 payload 已入流（含其 sentinel rand）：rand 随该次尝试作废，直接标记，
          // 否则 drive 会把它当成重建后新 init 的 rand 应答并提前收工（新 init rand 稍后才写入）
          for (const m of Buffer.from(request.data, "base64").toString("utf8").matchAll(/__OWC_DONE_([0-9a-f]{12})_/g)) {
            acked.add(m[1]!);
          }
          throw new CoreRpcError(-32003, "pty not found");
        }
        return { ok: true as const };
      };
    const result = await runDriven(fake, manager, session, "echo two", () => emitOutput(fake, "two\n"));
    expect(result.output).toBe("two");
    expect(fake.openCalls).toHaveLength(2);
  });

  it("pty.exit 后在途命令报错；下一条命令透明重建（再次 openPty）", async () => {
    const first = manager.run(session, "exit", new AbortController().signal);
    await drive(fake); // init
    await waitForInput(fake, "exit");
    fake.emitter.emit("exit", { exitCode: 0 });
    await expect(first).rejects.toThrow(/Persistent shell exited/);
    // 在途命令的 sentinel rand 随 pty 死亡作废：标记掉，防止 runDriven 的 drive 把它
    // 当成下一条命令的 init rand 应答后提前收工（新 init rand 稍后才写入）
    for (const rand of pendingRands(fake)) acked.add(rand);
    const result = await runDriven(fake, manager, session, "echo back", () => emitOutput(fake, "back\n"));
    expect(fake.openCalls).toHaveLength(2);
    expect(result.output).toBe("back");
  });

  it("disposeSession 回收持久 pty（closePty + 从表中移除）", async () => {
    await runDriven(fake, manager, session, "echo hi", () => emitOutput(fake, "hi\n"));
    manager.disposeSession("s1");
    expect(fake.closeCalls).toEqual([1]);
  });

  it("disposeSession 一并清理串行化队列条目（session:backend → Promise 不随会话数泄漏）", async () => {
    // 本地覆盖 beforeEach 的 manager：不支持 pty 的 core，run 直接 Unavailable，但 session:backend 的队列条目已写入
    const manager = newManager(makeFakeCore());
    await expect(manager.run(fakeSession("s1"), "echo hi", new AbortController().signal))
      .rejects.toBeInstanceOf(PersistentShellUnavailableError);
    await expect(manager.run(fakeSession("s2"), "echo hi", new AbortController().signal))
      .rejects.toBeInstanceOf(PersistentShellUnavailableError);
    const queues = (manager as unknown as { queues: Map<string, Promise<unknown>> }).queues;
    expect([...queues.keys()].sort()).toEqual(["s1:cmd", "s2:cmd"]);
    manager.disposeSession("s1");
    expect([...queues.keys()]).toEqual(["s2:cmd"]);
  });

  it("init 非零（shell 进不了 cwd）抛 Unavailable 并缓存，后续直接回退不再开 pty", async () => {
    const run = manager.run(session, "echo hi", new AbortController().signal);
    const rand = await nextRand(fake);
    emitOutput(fake, `__OWC_DONE_${rand}_1__\n`); // init 失败（模拟 pwsh 落 C:\）
    await expect(run).rejects.toBeInstanceOf(PersistentShellUnavailableError);
    await expect(manager.run(session, "echo again", new AbortController().signal))
      .rejects.toBeInstanceOf(PersistentShellUnavailableError);
    expect(fake.openCalls).toHaveLength(1); // 第二次直接回退，不再开 pty
  });

  it("open 失败（能力缺失 -32601）抛 PersistentShellUnavailableError 供回退", async () => {
    fake.failOpen = new CoreRpcError(-32601, "unknown method pty.open");
    await expect(manager.run(session, "echo hi", new AbortController().signal))
      .rejects.toBeInstanceOf(PersistentShellUnavailableError);
    expect(manager.supported).toBe(false); // 能力级失败缓存，后续直接回退
  });
});

// ---------- 真 core 集成（缺二进制跳过） ----------

describe.skipIf(!hasCore)("PersistentShellManager（真 core）", () => {
  async function setup(backend: ShellBackend = "cmd", sandboxMode?: "jobobject") {
    // pty 进程树退出滞后于 closePty，清理需重试（rmWithRetry 变体）
    const root = await tempRootRetry("owc-pshell-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test", model: "test", title: "pshell" });
    await sessions.updateConfig(session.id, { provider: "test", model: "test", shellBackend: backend });
    const meta = (await sessions.get(session.id))!;
    // MSYS bash 在 AppContainer 下 DLL 初始化失败（0xC0000142）；缺省（不下发 mode）即
    // AppContainer，测试对 git bash 显式 jobobject 对齐（cmd/pwsh 用例保持 AppContainer 默认）
    if (sandboxMode) meta.sandbox = { ...defaultSandboxPolicy(root), mode: sandboxMode };
    const client = new CoreClient(corePath);
    clients.push(client);
    await client.start();
    await client.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: meta.sandbox ?? defaultSandboxPolicy(session.cwd) });
    const manager = new PersistentShellManager(client, new UvPythonEnvironments(), () => "global", new NodeEnvManagers(), () => "global");
    const controller = new AbortController();
    const run = (cmd: string) => manager.run(meta, cmd, controller.signal);
    return { root, session, meta, client, manager, controller, run };
  }

  it("cd 与环境变量跨调用保持（win=cmd / posix=sh）", async () => {
    const { run, manager, session } = await setup();
    await run(isWindows ? "mkdir owcpsub" : "mkdir -p owcpsub");
    await run("cd owcpsub");
    const cwd = await run(isWindows ? "cd" : "pwd");
    expect(cwd.exitCode).toBe(0);
    expect(cwd.output.replace(/\//g, "\\")).toContain("owcpsub");
    await run(isWindows ? "set OWC_PS_VAR=hello42" : "export OWC_PS_VAR=hello42");
    const env = await run(isWindows ? "echo %OWC_PS_VAR%" : "echo $OWC_PS_VAR");
    expect(env.exitCode).toBe(0);
    expect(env.output).toContain("hello42");
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
  async function setupSession(providerName: string) {
    const root = await tempRoot("owc-pshell-it-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: providerName, model: "m", title: "it" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    return { sessions, session, pricing };
  }

  it("持久 shell 不可用时 runShell 仍走 core.run（回退不报错）", async () => {
    const { sessions, session, pricing } = await setupSession("stub");
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
    const { sessions, session, pricing } = await setupSession("fake");
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
