import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import path from "node:path";
import { CoreRpcError, type CoreClientLike, type PtyOpenResult } from "../core-client.js";
import { errorMessage } from "../error-utils.js";
import { decodeChildProcessOutput } from "./output-decoder.js";
import { effectivePythonEnv, uvVenvDir, type UvPythonEnvironments } from "../python-env.js";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import type { PythonEnv, SessionMeta, ShellBackend } from "../sessions/types.js";
import { resolveShell, type ResolvedShell, type ShellFlavor } from "./shell-detect.js";

/**
 * 提交⑩：agent bash 的持久 shell。每会话每 shellBackend 懒建一个 pty（sandbox=true，
 * 走会话沙盒策略，与⑦的人类终端 sandbox=false 通道严格区分），cwd/env 跨调用保持。
 * 命令边界用随机后缀 sentinel 切分；pty 不可用（旧 core）时由调用方回退一次性 exec.run。
 */

/** pty 尺寸：取 core 上限 512 列，尽量避免回显折行干扰 sentinel 解析。 */
export const PERSISTENT_SHELL_COLS = 512;
export const PERSISTENT_SHELL_ROWS = 30;
/** 单命令超时：与 jobControl 路径一致（10 分钟）；超时销毁 shell，下条命令透明重建。 */
export const PERSISTENT_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** 输出字符上限：与 core job output_limit（1 MiB）对齐，超出截断但仍继续扫 sentinel。 */
export const MAX_SHELL_OUTPUT_CHARS = 1_000_000;
/** core pty.input 单帧解码后 ≤8KB，按字符边界切块发送。 */
const INPUT_CHUNK_BYTES = 4096;
/** 开 shell 后的初始静默排干：丢弃 banner / profile 输出，避免污染首条命令的解析。 */
const DRAIN_QUIET_MS = 250;
const DRAIN_MAX_MS = 5_000;

/** pty 能力不可用（旧 core / 策略拒绝），调用方回退一次性 exec.run，不向用户报错。 */
export class PersistentShellUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistentShellUnavailableError";
  }
}

export interface PersistentShellResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  durationMs: number;
  sandboxCapability?: string;
  sandboxReason?: string;
}

/**
 * 三语法族的 sentinel 输入行（独立成行发送，不回显进结果）：
 * - cmd：%ERRORLEVEL% 在行解析期展开，同行 `& echo ...%ERRORLEVEL%...` 会拿到旧值
 *   （真机探针验证），必须放独立输入行——cmd 逐行读取执行，解析该行时才是新值。
 * - pwsh：$? 覆盖 cmdlet 成败，$LASTEXITCODE 保留原生命令退出码；每条命令后复位
 *   $LASTEXITCODE 防止 cmdlet 成功时读到上一条原生命令的陈旧值。
 * - sh（含 Windows Git Bash）：$? 在执行期展开，独立行即可。
 */
export function sentinelLine(flavor: ShellFlavor, rand: string): string {
  const marker = `__OWC_DONE_${rand}_`;
  if (flavor === "pwsh") {
    return `echo "${marker}$(if ($?) { $LASTEXITCODE } elseif ($LASTEXITCODE -gt 0) { $LASTEXITCODE } else { 1 })__"; $global:LASTEXITCODE = 0`;
  }
  if (flavor === "cmd") return `echo ${marker}%ERRORLEVEL%__`;
  return `echo ${marker}$?__`;
}

/** pythonEnv=uv-* 的 venv 激活命令（PATH 前置一次，整个会话受益）；语法与 python-env.ts 的 wrapCommandWithVenv 对齐。 */
export function venvActivationCommand(flavor: ShellFlavor, venvDir: string, platform: NodeJS.Platform = process.platform): string {
  if (flavor === "pwsh") {
    const join = platform === "win32" ? path.win32.join : path.posix.join;
    const dir = join(venvDir, platform === "win32" ? "Scripts" : "bin");
    const separator = platform === "win32" ? ";" : ":";
    return `$env:Path = '${dir.replace(/'/g, "''")}${separator}' + $env:Path`;
  }
  if (flavor === "cmd") return `set "PATH=${path.win32.join(venvDir, "Scripts")};%PATH%"`;
  // sh：Windows Git Bash 下 venv 仍在 Scripts，反斜杠须换为正斜杠（bash 里 \ 是转义符）
  const dir = platform === "win32"
    ? path.win32.join(venvDir, "Scripts").replace(/\\/g, "/")
    : path.posix.join(venvDir, "bin");
  return `export PATH='${dir.replace(/'/g, `'\\''`)}':$PATH`;
}

/** CSI / OSC / 字符集等终端转义序列 + 裸 BEL/BS（PSReadLine 渲染会产生大量重绘序列）。 */
// eslint-disable-next-line no-control-regex -- 匹配终端转义序列，控制字符（ESC/BEL/BS）本身就是匹配目标
const ANSI_ESCAPE = /\x1b\[[0-9;:?>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#@A-Z\\-_]|\x07|\x08/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** chunk 末尾疑似半个转义序列的起始下标（ESC 开头但未成形的后缀）；无则返回 text.length。 */
function danglingEscapeIndex(text: string): number {
  // eslint-disable-next-line no-control-regex -- 匹配未成形终端转义序列后缀，ESC/BEL 是刻意目标
  const match = /\x1b(?:\[[0-9;:?>]*|\][^\x07\x1b]*|[()][0-9A-B]?)?$/.exec(text);
  return match && match[0].length > 0 ? match.index : text.length;
}

/**
 * 光标定位序列（CUP）：ConPTY 常用它代替 \r\n 绘制下一行（命令输出后、提示符前），
 * 不做替换会把输出和提示符粘成一行。解析前统一换成 \n。
 */
// eslint-disable-next-line no-control-regex -- 匹配 ConPTY 光标定位序列，ESC 是刻意目标
const CURSOR_POSITION = /\x1b\[[0-9]*(?:;[0-9]*)?[Hf]/g;

/**
 * sentinel 解析器（纯逻辑，供单测）。PTY 会回显输入行，解析规则：
 * - sentinel 按子串匹配 `__OWC_DONE_<rand>_<code>__`：ConPTY 在 sentinel 输出后直接用
 *   光标定位序列画下一个提示符，sentinel 行往往没有换行结尾，不能行锚定。
 *   回显行里 marker 后跟的是未展开的 %ERRORLEVEL% / $? / $(...)，永远不会匹配
 *   （marker 后必须是可选负号 + 数字 + __；随机后缀防输出文本碰撞）。
 * - 回显剔除：echo 阶段的行若包含完整输入行 / 输入行前 40 字符 / marker，丢弃；
 *   首个非回显行之后进入输出阶段，此后只有含 marker 的行（sentinel 输入行回显）被丢弃。
 * - 跨 chunk 的不完整行留在 buf 里拼接（含跨 chunk 的半个转义序列）；CRLF 归一；
 *   命中后清空 buf（丢弃新提示符残段）。
 */
export class SentinelParser {
  private buf = "";
  private rawTail = "";
  private readonly marker: string;
  private readonly sentinel: RegExp;
  /** 任意 rand 的 sentinel 输入行回显（marker 后是未展开形式）：上一条命令的回显可能迟到进本命令的流。 */
  private readonly staleSentinelEcho = /__OWC_DONE_[0-9a-f]{12}_(?:%ERRORLEVEL%__|\$\?__|\$\()/;
  private readonly echoNeedles: string[];
  private readonly lines: string[] = [];
  private chars = 0;
  private echoPhase = true;
  truncated = false;

  constructor(rand: string, echoLines: string[]) {
    this.marker = `__OWC_DONE_${rand}_`;
    this.sentinel = new RegExp(`__OWC_DONE_${rand}_(-?\\d*)__`);
    this.echoNeedles = echoLines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  }

  /** 喂入解码文本；命中 sentinel 返回 exit code（空码按 0，pwsh 首个命令前 $LASTEXITCODE 为 $null），否则 null。 */
  feed(text: string): number | null {
    const combined = this.rawTail + text;
    const splitAt = danglingEscapeIndex(combined);
    this.rawTail = combined.slice(splitAt);
    this.buf += stripAnsi(combined.slice(0, splitAt).replace(CURSOR_POSITION, "\n"));
    const match = this.sentinel.exec(this.buf);
    if (match) {
      // sentinel 之前可能粘着无换行的输出（如 printf 不带尾换行），一并成行处理
      this.consumeLines(this.buf.slice(0, match.index), true);
      this.buf = "";
      return match[1] ? Number.parseInt(match[1], 10) : 0;
    }
    const lastNewline = this.buf.lastIndexOf("\n");
    if (lastNewline >= 0) {
      const complete = this.buf.slice(0, lastNewline + 1);
      this.buf = this.buf.slice(lastNewline + 1);
      this.consumeLines(complete, false);
    }
    // 无换行的超长单行（如 base64 dump）防内存膨胀：冲掉头部，保留尾巴继续等 sentinel
    if (this.buf.length > MAX_SHELL_OUTPUT_CHARS) {
      this.truncated = true;
      this.buf = this.buf.slice(-64);
    }
    return null;
  }

  output(): string {
    return this.lines.join("\n").trimEnd();
  }

  /** 把一段已成流的文本按行处理；final 时末尾无换行的残段也按一行处理（sentinel 前粘连的输出）。 */
  private consumeLines(text: string, final: boolean): void {
    const parts = text.split("\n");
    const last = final ? parts.length : parts.length - 1;
    for (let i = 0; i < last; i++) {
      const line = parts[i]!.replace(/\r$/, "");
      if (this.echoPhase) {
        // CUP 换行转换会制造空行：echo 阶段的空行跳过且不结束 echo 阶段
        if (line === "" || this.isEcho(line)) continue;
        this.echoPhase = false;
      } else if (line.includes(this.marker) || this.staleSentinelEcho.test(line) || this.hasFullNeedle(line)) {
        continue; // sentinel 输入行回显（含迟到者）/ 用户命令输入行回显
      }
      if (this.chars + line.length > MAX_SHELL_OUTPUT_CHARS) {
        this.truncated = true;
        continue;
      }
      this.chars += line.length + 1;
      this.lines.push(line);
    }
    // 非 final 时末段是不完整行，已由调用方留在 buf 里
  }

  private isEcho(line: string): boolean {
    if (line.includes(this.marker) || this.staleSentinelEcho.test(line)) return true;
    if (this.hasFullNeedle(line)) return true;
    for (const needle of this.echoNeedles) {
      // 回显折行（罕见，>470 字符的命令）首段：提示符前缀 + 输入行开头
      if (needle.length > 40 && line.includes(needle.slice(0, 40))) return true;
    }
    return false;
  }

  private hasFullNeedle(line: string): boolean {
    return this.echoNeedles.some((needle) => line.includes(needle));
  }
}

/** 持久 shell 命令输出的代码页修复：pty 输出按 lossy UTF-8 增量喂给 sentinel 解析
 * （sentinel 为 ASCII，GBK/UTF-8 下位置一致），若结果含 U+FFFD 则用原始字节按
 * UTF-8 严格 / GBK 回退整体重解码并重跑解析；仍乱码则保留原输出。 */
export function repairShellOutput(output: string, raw: readonly Buffer[], rand: string, lines: readonly string[], platform: NodeJS.Platform = process.platform): string {
  if (!output.includes("�") || raw.length === 0) return output;
  const reparsed = new SentinelParser(rand, [...lines]);
  reparsed.feed(decodeChildProcessOutput(Buffer.concat(raw), platform));
  const repaired = reparsed.output();
  return repaired.includes("�") ? output : repaired;
}

interface ActiveCommand {
  parser: SentinelParser;
  resolve: (result: { code: number; raw: Buffer[] }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort: () => void;
  /** 本命令的原始输出字节（base64 解码后）：lossy UTF-8 出现乱码时按代码页重解码。 */
  raw: Buffer[];
  rawBytes: number;
}

interface ShellRecord {
  key: string;
  ptyId: number;
  shell: ResolvedShell;
  dead: boolean;
  active: ActiveCommand | null;
  /** uv 环境不可用时的说明：并入首条命令输出（对齐一次性路径 wrapCommandWithNote 的可见性）。 */
  pythonEnvNote?: string;
  sandboxCapability?: string;
  sandboxReason?: string;
}

export class PersistentShellManager {
  private readonly shells = new Map<string, ShellRecord>();
  /** 同一会话同一后端的 bash 调用串行化，避免交错污染 sentinel 解析。 */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** 能力级失败（旧 core 无 pty）后不再尝试，直接由调用方回退一次性 exec。 */
  private capabilityFailed = false;
  /** 初始化失败的 session:backend（如 pwsh 在 AppContainer 下进不了工作区）：直接回退，避免每条命令付出开壳代价。 */
  private readonly initFailed = new Set<string>();

  constructor(
    private readonly core: CoreClientLike,
    private readonly pythonEnv: UvPythonEnvironments,
    private readonly getPythonEnvDefault: () => PythonEnv,
    private readonly dataDir?: string,
  ) {}

  get supported(): boolean {
    return !this.capabilityFailed && Boolean(this.core.openPty && this.core.inputPty && this.core.closePty && this.core.ptyEvents);
  }

  run(session: SessionMeta, cmd: string, signal: AbortSignal): Promise<PersistentShellResult> {
    const backend = session.shellBackend ?? "default";
    const key = `${session.id}:${backend}`;
    const queued = (this.queues.get(key) ?? Promise.resolve()).then(() => this.runExclusive(key, session, backend, cmd, signal));
    this.queues.set(key, queued.then(() => undefined, () => undefined));
    return queued;
  }

  /** 会话删除时回收该会话的全部持久 shell。 */
  disposeSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const [key, shell] of [...this.shells]) {
      if (key.startsWith(prefix)) this.destroy(shell);
    }
  }

  disposeAll(): void {
    for (const shell of [...this.shells.values()]) this.destroy(shell);
  }

  private async runExclusive(
    key: string,
    session: SessionMeta,
    backend: ShellBackend,
    cmd: string,
    signal: AbortSignal,
  ): Promise<PersistentShellResult> {
    signal.throwIfAborted();
    if (!this.supported) throw new PersistentShellUnavailableError("Core pty support is unavailable");
    if (this.initFailed.has(key)) throw new PersistentShellUnavailableError("Persistent shell initialization previously failed for this session backend");
    const shell = resolveShell(backend);
    // core 重启后旧 ptyId 失效（"pty not found"）：销毁重建一次再执行，不把错误抛给模型
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await this.ensureShell(key, session, shell, signal);
      const rand = randomBytes(6).toString("hex");
      const eol = process.platform === "win32" ? "\r" : "\n";
      const cmdLines = cmd.replace(/\r\n/g, "\n").split("\n");
      const reset = errorlevelResetLine(record.shell.flavor);
      const lines = [...(reset ? [reset] : []), ...cmdLines, sentinelLine(record.shell.flavor, rand)];
      const parser = new SentinelParser(rand, lines);
      const started = Date.now();
      try {
        const { code: exitCode, raw } = await this.execOnShell(record, parser, lines.join(eol) + eol, signal);
        let output = repairShellOutput(parser.output(), raw, rand, lines);
        if (record.pythonEnvNote) {
          output = `[openwebcode] ${record.pythonEnvNote}\n${output}`;
          delete record.pythonEnvNote;
        }
        return {
          exitCode,
          output,
          truncated: parser.truncated,
          durationMs: Date.now() - started,
          ...(record.sandboxCapability !== undefined ? { sandboxCapability: record.sandboxCapability } : {}),
          ...(record.sandboxReason !== undefined ? { sandboxReason: record.sandboxReason } : {}),
        };
      } catch (error) {
        if (attempt === 0 && errorMessage(error).includes("pty not found")) {
          this.destroy(record);
          continue;
        }
        throw error;
      }
    }
    throw new Error("unreachable");
  }

  /** 懒建持久 shell：open -> 静默排干 -> pythonEnv 激活（首个用户命令前注入一次）。 */
  private async ensureShell(key: string, session: SessionMeta, shell: ResolvedShell, signal: AbortSignal): Promise<ShellRecord> {
    const existing = this.shells.get(key);
    if (existing && !existing.dead) return existing;
    if (!this.core.openPty || !this.core.inputPty || !this.core.closePty || !this.core.ptyEvents) {
      this.capabilityFailed = true;
      throw new PersistentShellUnavailableError("Core pty support is unavailable");
    }
    // 沙盒配置幂等（与 runShell 同款）；sandbox=true 由 core 按会话策略施加
    await this.core.configureSession({
      sessionId: session.id,
      cwd: session.cwd,
      sandbox: session.sandbox ?? defaultSandboxPolicy(session.cwd),
    });
    let opened: PtyOpenResult;
    try {
      opened = await this.core.openPty({
        session: session.id,
        cwd: session.cwd,
        cols: PERSISTENT_SHELL_COLS,
        rows: PERSISTENT_SHELL_ROWS,
        sandbox: true,
        shell: shell.executable,
      });
    } catch (error) {
      if (error instanceof CoreRpcError && error.code === -32601) this.capabilityFailed = true;
      throw new PersistentShellUnavailableError(errorMessage(error));
    }
    const record: ShellRecord = {
      key,
      ptyId: opened.ptyId,
      shell,
      dead: false,
      active: null,
      ...(opened.sandboxCapability !== undefined ? { sandboxCapability: opened.sandboxCapability } : {}),
      ...(opened.sandboxReason !== undefined ? { sandboxReason: opened.sandboxReason } : {}),
    };
    this.shells.set(key, record);
    this.attach(record, this.core.ptyEvents(opened.ptyId));
    try {
      await this.drain(record);
      // shell 起来即死（如 pwsh 缺失）：回退一次性 exec，由旧路径给出规范报错
      if (record.dead) throw new PersistentShellUnavailableError("pty shell exited immediately after open");
      // 启动初始化（见 shellInitLines 注释）：输出全部丢弃；与 pythonEnv 激活合并为
      // 一次 sentinel 往返。init exit code 非零 = shell 进不了会话 cwd（pwsh/AppContainer
      // 场景），销毁并回退一次性 exec.run，并缓存该 session:backend 不再重试。
      const initLines = shellInitLines(shell.flavor, session.cwd);
      const activation = await this.pythonEnvActivation(record, session);
      const lines = [...initLines, ...(activation ? [activation] : [])];
      const rand = randomBytes(6).toString("hex");
      const eol = process.platform === "win32" ? "\r" : "\n";
      lines.push(sentinelLine(shell.flavor, rand));
      const { code: initCode } = await this.execOnShell(record, new SentinelParser(rand, lines), lines.join(eol) + eol, signal);
      if (initCode !== 0) {
        this.initFailed.add(key);
        throw new PersistentShellUnavailableError(`Persistent shell could not enter the session cwd (init code ${initCode}); falling back to one-shot exec`);
      }
    } catch (error) {
      this.destroy(record);
      // init 期间 shell 死亡（如 MSYS bash 在 AppContainer 下 DLL 初始化失败）：与
      // 开壳即死同等处理，统一回退一次性 exec，并缓存该 session:backend 不再重试
      if (record.dead) {
        this.initFailed.add(key);
        throw new PersistentShellUnavailableError(`pty shell exited during initialization (${errorMessage(error)}); falling back to one-shot exec`);
      }
      throw error;
    }
    return record;
  }

  /** uv 模式：先确保 venv 存在（host 侧懒创建，与一次性路径同逻辑），返回 shell 内 PATH 前置命令；失败记 note 返回 null。 */
  private async pythonEnvActivation(record: ShellRecord, session: SessionMeta): Promise<string | null> {
    const mode = effectivePythonEnv(session.pythonEnv, this.getPythonEnvDefault());
    if (mode === "global") return null;
    const venvDir = uvVenvDir(mode, session.cwd, this.dataDir);
    if (!venvDir) return null;
    const ensured = await this.pythonEnv.ensure(venvDir);
    if (!ensured.ok) {
      record.pythonEnvNote = ensured.note ?? "uv environment unavailable; using the host python environment";
      return null;
    }
    return venvActivationCommand(record.shell.flavor, venvDir);
  }

  /** 静默排干：等输出停止 DRAIN_QUIET_MS（上限 DRAIN_MAX_MS），期间输出全部丢弃。 */
  private drain(record: ShellRecord): Promise<void> {
    return new Promise((resolve) => {
      const emitter = this.core.ptyEvents?.(record.ptyId);
      if (!emitter) { resolve(); return; }
      let quietTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        clearTimeout(maxTimer);
        if (quietTimer) clearTimeout(quietTimer);
        emitter.off("output", onData);
        resolve();
      };
      const onData = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, DRAIN_QUIET_MS);
      };
      const maxTimer = setTimeout(finish, DRAIN_MAX_MS);
      emitter.on("output", onData);
      quietTimer = setTimeout(finish, DRAIN_QUIET_MS);
    });
  }

  /** 在 shell 上执行一段输入（命令 + sentinel），解析到 sentinel 返回 exit code。 */
  private execOnShell(shell: ShellRecord, parser: SentinelParser, payload: string, signal: AbortSignal): Promise<{ code: number; raw: Buffer[] }> {
    if (shell.dead) return Promise.reject(new Error("Persistent shell is not running"));
    return new Promise<{ code: number; raw: Buffer[] }>((resolve, reject) => {
      const onAbort = () => {
        this.settle(shell, () => {
          this.destroy(shell);
          try {
            signal.throwIfAborted();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      };
      const timer = setTimeout(() => {
        this.settle(shell, () => {
          // 超时的命令可能仍占着 shell：销毁重建，避免下条命令读到残流
          this.destroy(shell);
          // 附带已捕获输出的尾部：命令跑飞（如全盘遍历）时模型能看到现场并自我纠正
          const tail = parser.output().slice(-2000).trim();
          reject(new Error(`command timed out after ${PERSISTENT_COMMAND_TIMEOUT_MS}ms` + (tail ? `\ncaptured output before timeout (tail):\n${tail}` : "")));
        });
      }, PERSISTENT_COMMAND_TIMEOUT_MS);
      shell.active = { parser, resolve, reject, timer, signal, onAbort, raw: [], rawBytes: 0 };
      signal.addEventListener("abort", onAbort, { once: true });
      this.writeInput(shell, payload).catch((error: unknown) => {
        this.settle(shell, () => {
          this.destroy(shell);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });
  }

  /** 收齐一次命令的结束信号：清定时器与 abort 监听后执行结算动作（幂等）。 */
  private settle(shell: ShellRecord, action: () => void): void {
    const active = shell.active;
    if (!active) return;
    shell.active = null;
    clearTimeout(active.timer);
    active.signal.removeEventListener("abort", active.onAbort);
    action();
  }

  private attach(record: ShellRecord, emitter: EventEmitter): void {
    emitter.on("output", (params: { data?: unknown }) => {
      const active = record.active;
      if (!active || record.dead) return;
      if (!params || typeof params.data !== "string") return;
      const bytes = Buffer.from(params.data, "base64");
      // 原始字节上限 2 MiB：超限后放弃代码页修复（输出仍走 lossy 路径）
      if (active.rawBytes + bytes.length <= 2 * 1024 * 1024) {
        active.raw.push(bytes);
        active.rawBytes += bytes.length;
      }
      const code = active.parser.feed(bytes.toString("utf8"));
      if (code !== null) this.settle(record, () => active.resolve({ code, raw: active.raw }));
    });
    // core 崩溃 / pty.exit：在途命令报错，记录移除；下条命令 ensureShell 透明重建
    emitter.on("exit", (params: { exitCode?: unknown }) => {
      const code = params && typeof params.exitCode === "number" ? params.exitCode : undefined;
      const active = record.active;
      this.discard(record);
      if (active) {
        this.settle(record, () => active.reject(new Error(`Persistent shell exited${code !== undefined ? ` (code ${code})` : ""}`)));
      }
      this.closePty(record);
    });
  }

  /** 标记死亡并移出表（不触碰 active，由调用方结算）。 */
  private discard(record: ShellRecord): void {
    record.dead = true;
    if (this.shells.get(record.key) === record) this.shells.delete(record.key);
  }

  private closePty(record: ShellRecord): void {
    this.core.removePtyEvents?.(record.ptyId);
    void this.core.closePty?.({ ptyId: record.ptyId }).catch(() => undefined);
  }

  private destroy(record: ShellRecord): void {
    this.discard(record);
    this.closePty(record);
  }

  /** core pty.input 单帧解码后 ≤8KB：按 UTF-8 字符边界切块发送。 */
  private async writeInput(shell: ShellRecord, payload: string): Promise<void> {
    if (!this.core.inputPty) throw new PersistentShellUnavailableError("Core pty support is unavailable");
    let chunk = "";
    let bytes = 0;
    for (const char of payload) {
      const size = Buffer.byteLength(char, "utf8");
      if (bytes + size > INPUT_CHUNK_BYTES && chunk) {
        await this.core.inputPty({ ptyId: shell.ptyId, data: Buffer.from(chunk, "utf8").toString("base64") });
        chunk = "";
        bytes = 0;
      }
      chunk += char;
      bytes += size;
    }
    if (chunk) await this.core.inputPty({ ptyId: shell.ptyId, data: Buffer.from(chunk, "utf8").toString("base64") });
  }
}

/**
 * 持久 shell 的启动初始化行（输出丢弃；init sentinel 的 exit code 非零视为建壳失败，回退一次性 exec）：
 * - cmd：pty 由 core 以会话 cwd 启动（真机探针验证提示符即工作区），无需再 cd——
 *   且 core AppContainer 的 ACL 授权现状下"按路径打开目录"会被拒（exec.run 同样如此，
 *   文件读写正常），`cd /d` 必失败并把 ERRORLEVEL 污染为 1（cmd 内建命令不复位它），
 *   之后每条 sentinel 都会读到陈旧失败码。故 cmd 不做 cd 类 init。
 *   唯一 init 是 `chcp 65001`：ConPTY 以控制台代码页解析输出，默认 936 时中文程序的
 *   GBK 输出会被当作 UTF-8 解析，FFFD 直接烤进字节流（不可逆）；切到 UTF-8 代码页后
 *   中文输出与中文输入双向正确。`>nul` 不能加（AppContainer x ConPTY 拒绝重定向 NUL），
 *   其提示行随 init 输出一并丢弃。
 * - pwsh：AppContainer 下初始 cwd 落到 C:\（FileSystem provider 初始化失败回退），
 *   PSReadLine 历史文件在用户配置目录（非沙盒读根）每次提示符渲染都报拒绝访问。
 *   显式 Set-Location 回会话 cwd 并关闭历史保存；末行校验落点——目录不可达（祖先
 *   ACL 非用户可写时 traverse 授权不生效）时把 $LASTEXITCODE 置 1，让 ensureShell
 *   识别并回退一次性 exec.run，而不是留一个卡在 C:\ 的坏 shell。
 * - sh（POSIX 与 Windows Git Bash）：pty 正常落在 cwd，cd 一次做归一；$? 逐命令求值，
 *   无陈旧污染问题。Git Bash 额外先发 `chcp.com 65001`（与 cmd 同理由：ConPTY 按控制台
 *   代码页解析原生子进程输出），cwd 的反斜杠换为正斜杠（bash 里 \ 是转义符）。
 */
export function shellInitLines(flavor: ShellFlavor, cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  const quoted = cwd.replace(/'/g, "''");
  if (flavor === "pwsh") {
    const eq = platform === "win32" ? "-ieq" : "-ceq";
    return [
      "try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch {}",
      `try { Set-Location -LiteralPath '${quoted}' } catch {}`,
      `$global:LASTEXITCODE = ($PWD.Path ${eq} '${quoted}') ? 0 : 1`,
    ];
  }
  if (flavor === "cmd") return ["chcp 65001"];
  if (platform === "win32") {
    const dir = cwd.replace(/\\/g, "/");
    return ["chcp.com 65001", `cd '${dir.replace(/'/g, `'\\''`)}'`];
  }
  return [`cd '${cwd.replace(/'/g, `'\\''`)}'`];
}

/**
 * 用户命令前的 ERRORLEVEL 复位行（仅 win cmd）：cmd 很多内建命令（set/echo/cd 等）
 * 成功时不复位 ERRORLEVEL，上一条失败命令的陈旧码会被本条的 sentinel 误读。
 * `(call )`（带空格）置 ERRORLEVEL=0、无输出（真机探针验证；`(call)` 无空格反而置 1）。
 * 不能用 `>nul` 类重定向——AppContainer x ConPTY 下重定向 NUL 会被拒。
 */
export function errorlevelResetLine(flavor: ShellFlavor, platform: NodeJS.Platform = process.platform): string | null {
  return flavor === "cmd" && platform === "win32" ? "(call )" : null;
}
