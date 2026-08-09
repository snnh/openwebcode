import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobOutputRequest, JobOutputResult, JobStartRequest, JobStatus } from "../core-client.js";
import type { SandboxPolicy } from "../sessions/types.js";
import type { ChatPythonEnv } from "./chat-python-env.js";

export interface PythonExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  images?: { data: string; mediaType: string }[];
  /** 是否经 bwrap 隔离运行；Windows / bwrap 缺失时如实为 false。 */
  isolated: boolean;
  /** 隔离边界形态：bwrap（POSIX 全隔离）/ jobobject（Windows 进程树 containment，无网络/FS 隔离）/ none（直启）。 */
  containment?: "bwrap" | "jobobject" | "none";
  /** core 路由下 configureSession 上报的执行级别，如实透传。 */
  sandboxCapability?: string;
  sandboxReason?: string;
}

/**
 * chat python 经 core 执行所需的最小 core 面（CoreRouter 结构化满足）。
 * 与 CoreClientLike 同构的子集，便于测试注入 fake。
 */
export interface ChatPythonCoreBridge {
  configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string; sandboxReason?: string }>;
  startJob(request: JobStartRequest): Promise<JobStatus>;
  jobStatus(request: { sessionId: string; jobId: string }): Promise<JobStatus>;
  jobOutput(request: JobOutputRequest): Promise<JobOutputResult>;
  cancelJob(request: { sessionId: string; jobId: string }): Promise<unknown>;
}

export interface PythonExecOptions {
  /** meta.cwd 覆盖：已设置且为存在目录时作为子进程 cwd，否则回落 sessionDir。 */
  cwd?: string | undefined;
  /** core 桥接（CoreRouter）；Windows 上提供时经 job.* 在 Job Object 内运行。 */
  core?: ChatPythonCoreBridge | undefined;
  /** 平台判定（测试注入）；缺省 process.platform。 */
  platform?: NodeJS.Platform | undefined;
  /** chat 会话 id；core 路由时拼为 "chat-python-<id>" 作为 core 侧会话。 */
  sessionId?: string | undefined;
}

/** 单条输出流上限（超出截断，防止用户代码打爆内存/上下文）。 */
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 30_000;
/** SIGTERM 后的宽限期，超时未退出升级 SIGKILL。 */
const KILL_GRACE_MS = 5_000;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/**
 * 在聊天 Python 环境中执行用户代码。
 * 隔离为两层：第一层 bwrap（mount/net namespace 隔离，POSIX 且 bwrap 可用时）
 * 或 Job Object（Windows 且注入 core 桥接时：进程树 containment + 内存/进程数上限，
 * 无网络/FS 隔离，partial 如实上报），第二层 wrapper 的 Python 内加固（模块黑名单 +
 * 属性封印 + env 清洗）；后者只是抬高门槛，边界主要靠前者。
 */
export async function executePython(
  env: ChatPythonEnv,
  sessionDir: string,
  code: string,
  signal: AbortSignal,
  options?: PythonExecOptions,
): Promise<PythonExecResult> {
  signal.throwIfAborted();
  await env.ensure();

  const tmpDir = path.join(sessionDir, "tmp");
  const mplDir = path.join(tmpDir, "mpl");
  const imgDir = path.join(tmpDir, "img");
  await mkdir(mplDir, { recursive: true });
  // 批次隔离：清空上一轮图片，只收集本次执行产生的
  await rm(imgDir, { recursive: true, force: true });
  await mkdir(imgDir, { recursive: true });
  const scriptPath = path.join(tmpDir, `${randomUUID()}.py`);
  const wrapperPath = path.join(tmpDir, "wrapper.py");

  // wrapper 拦截危险模块、强制 matplotlib Agg 后端、施加资源限制
  const wrapper = buildWrapper(scriptPath, imgDir, mplDir, sessionDir);
  await writeFile(wrapperPath, wrapper, "utf8");
  await writeFile(scriptPath, code, "utf8");

  const cwd = await resolveCwd(sessionDir, options?.cwd);
  const platform = options?.platform ?? process.platform;

  let result: PythonExecResult;
  if (platform === "win32" && options?.core && options.sessionId) {
    // Windows：经 CoreRouter job.* 在 Job Object 内运行（进程树 containment）
    result = await runViaCore(options.core, env, sessionDir, options.sessionId, wrapperPath, cwd, signal);
  } else {
    const sandboxEnv = buildSandboxEnv(sessionDir, mplDir);
    let cmd = env.pythonPath();
    let args = [wrapperPath];
    let isolated = false;
    if (platform !== "win32" && (await probeBwrap())) {
      args = buildBwrapArgs({
        venvDir: env.dir,
        sessionDir,
        cwd,
        python: env.pythonPath(),
        wrapperPath,
        env: sandboxEnv,
      });
      cmd = "bwrap";
      isolated = true;
    }
    const run = await runWithLimits(cmd, args, { cwd, env: sandboxEnv }, signal);
    result = { ...run, isolated, containment: isolated ? "bwrap" : "none" };
  }
  const images = await collectImages(imgDir);
  return { ...result, images };
}

/** meta.cwd 覆盖：存在且为目录才采用，否则回落 sessionDir。 */
async function resolveCwd(sessionDir: string, override: string | undefined): Promise<string> {
  if (override) {
    try {
      if ((await stat(override)).isDirectory()) return override;
    } catch {
      // 不存在/不可访问：回落 sessionDir
    }
  }
  return sessionDir;
}

/**
 * 子进程环境白名单：不继承 process.env（provider API Key 等绝不进入沙盒进程）。
 * 仅保留运行所需最小集。
 */
export function buildSandboxEnv(home: string, mplConfigDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
      : "/usr/bin:/bin",
    HOME: home,
    MPLBACKEND: "Agg",
    MPLCONFIGDIR: mplConfigDir,
    PYTHONNOUSERSITE: "1",
  };
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.TZ) env.TZ = process.env.TZ;
  return env;
}

/** 探测 bwrap 是否可用（spawn bwrap --version，失败/不存在均视为不可用）。 */
export function probeBwrap(): Promise<boolean> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("bwrap", ["--version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    proc.on("error", () => resolve(false));
    proc.on("close", (code: number | null) => resolve(code === 0));
  });
}

export interface BwrapSpec {
  venvDir: string;
  sessionDir: string;
  cwd: string;
  python: string;
  wrapperPath: string;
  env: Record<string, string>;
  /** 测试注入；默认 existsSync。 */
  exists?: (p: string) => boolean;
}

/**
 * 构造 bwrap 命令行：user/net/pid 等 namespace 全隔离、父死随死、
 * 系统目录只读绑定（存在的才绑）、venv 只读、会话目录可写、/tmp 为 tmpfs、
 * 环境经 --clearenv + --setenv 白名单注入。
 */
export function buildBwrapArgs(spec: BwrapSpec): string[] {
  const exists = spec.exists ?? existsSync;
  const args: string[] = ["--unshare-all", "--die-with-parent", "--new-session"];
  for (const dir of ["/usr", "/lib", "/lib64"]) {
    if (exists(dir)) args.push("--ro-bind", dir, dir);
  }
  args.push("--ro-bind", spec.venvDir, spec.venvDir);
  args.push("--bind", spec.sessionDir, spec.sessionDir);
  // meta.cwd 在会话目录之外时额外绑定，否则 bwrap 内不可见
  if (spec.cwd !== spec.sessionDir && !spec.cwd.startsWith(spec.sessionDir + path.sep)) {
    args.push("--bind", spec.cwd, spec.cwd);
  }
  args.push("--tmpfs", "/tmp");
  args.push("--chdir", spec.cwd);
  args.push("--clearenv");
  for (const [key, value] of Object.entries(spec.env)) {
    args.push("--setenv", key, value);
  }
  args.push(spec.python, spec.wrapperPath);
  return args;
}

/** Windows 路径写入 Python 字符串字面量前需转义反斜杠。 */
function pyLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

export function buildWrapper(scriptPath: string, imgDir: string, mplConfigDir: string, home: string): string {
  return `import builtins
import importlib
import sys

# Layer 2 of the chat python sandbox. Layer 1 is bwrap (namespaces, read-only
# system dirs, no network) on POSIX, or a core-routed Job Object (process-tree
# containment only) on Windows. This wrapper only raises the bar inside the
# interpreter: a determined in-process attacker can still escape Python-level
# hardening (object graph tricks, C extensions), so the real isolation boundary
# is the layer-1 mechanism, not this file.

# Whole-module blacklist: refused at import time.
_BLOCKED_MODULES = frozenset({"subprocess", "shutil", "ctypes", "socket"})

# Attribute sealing: os stays importable (numpy/pandas/matplotlib need it) but
# its process-control attributes are replaced with stubs raising PermissionError.
_OS_SEALED_NAMES = frozenset({"system", "popen", "fork", "forkpty", "kill", "killpg"})
_OS_SEALED_PREFIXES = ("spawn", "exec")

def _blocked_callable(qualname):
    def _blocked(*args, **kwargs):
        raise PermissionError(f"'{qualname}' is blocked in the chat python sandbox")
    _blocked.__name__ = qualname
    return _blocked

def _seal_module(mod):
    if getattr(mod, "__name__", None) != "os":
        return
    for attr in dir(mod):
        if attr in _OS_SEALED_NAMES or attr.startswith(_OS_SEALED_PREFIXES):
            try:
                setattr(mod, attr, _blocked_callable("os." + attr))
            except (AttributeError, TypeError):
                pass

_orig_import = builtins.__import__
def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root in _BLOCKED_MODULES:
        raise ImportError(f"module '{name}' is blocked in the chat python sandbox")
    mod = _orig_import(name, globals, locals, fromlist, level)
    target = sys.modules.get(root)
    if target is not None:
        _seal_module(target)
    return mod
builtins.__import__ = _guarded_import

_orig_import_module = importlib.import_module
def _guarded_import_module(name, package=None):
    root = name.lstrip(".").split(".")[0]
    if root in _BLOCKED_MODULES:
        raise ImportError(f"module '{name}' is blocked in the chat python sandbox")
    mod = _orig_import_module(name, package)
    target = sys.modules.get(root)
    if target is not None:
        _seal_module(target)
    return mod
importlib.import_module = _guarded_import_module

# Seal os eagerly in case something imported it before the hooks were installed.
import os as _os
_seal_module(_os)

# Defense in depth: trim os.environ down to a whitelist. When the runner goes
# through core (Windows Job Object), the child inherits the core process
# environment; this Python-level scrub only covers the interpreter view — the
# C-level environ still resides in process memory.
# Windows env keys are case-insensitive, so compare upper-cased.
_ENV_KEEP = frozenset({"PATH", "SYSTEMROOT", "HOME", "LANG", "TZ", "MPLBACKEND", "MPLCONFIGDIR", "PYTHONNOUSERSITE", "TEMP", "TMP"})
for _key in list(_os.environ.keys()):
    if _key.upper() not in _ENV_KEEP:
        del _os.environ[_key]
_os.environ["MPLBACKEND"] = "Agg"
_os.environ["MPLCONFIGDIR"] = r"${pyLiteral(mplConfigDir)}"
_os.environ["HOME"] = r"${pyLiteral(home)}"

# matplotlib: non-interactive backend, savefig defaults into the image batch dir.
try:
    import matplotlib
    matplotlib.use("Agg")
    matplotlib.rcParams["savefig.directory"] = r"${pyLiteral(imgDir)}"
except ImportError:
    pass

# Resource limits (POSIX only; the resource module is absent on Windows).
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
except (ImportError, AttributeError):
    pass

# Run user code in its own restricted namespace: it shares no globals with this
# wrapper, so _orig_import / _orig_import_module stay out of reach.
with open(r"${pyLiteral(scriptPath)}", "r", encoding="utf-8") as _f:
    _source = _f.read()
_user_globals = {"__name__": "__main__", "__file__": r"${pyLiteral(scriptPath)}"}
exec(compile(_source, r"${pyLiteral(scriptPath)}", "exec"), _user_globals)
`;
}

/** core 路由轮询间隔（jobOutput/jobStatus）。 */
const CORE_POLL_MS = 200;

/**
 * Windows 路径：经 CoreRouter 的 job.* 在会话 Job Object 内运行 python wrapper。
 * containment 只有进程树维度（jobMemoryMB/jobMaxProcesses + 超时整树杀），
 * 网络/文件系统不隔离——sandboxCapability/partial 如实透传给工具结果。
 * configureSession/startJob 失败如实上抛（core 不可用时由工具 handler 错误路径兜底），
 * 不静默回落直启。
 */
async function runViaCore(
  core: ChatPythonCoreBridge,
  env: ChatPythonEnv,
  sessionDir: string,
  sessionId: string,
  wrapperPath: string,
  cwd: string,
  signal: AbortSignal,
): Promise<PythonExecResult> {
  const coreSessionId = `chat-python-${sessionId}`;
  const configured = await core.configureSession({
    sessionId: coreSessionId,
    cwd: sessionDir,
    sandbox: {
      enabled: true,
      readRoots: [sessionDir, env.dir],
      writeRoots: [sessionDir],
      denyPaths: [],
      network: "allow",
      jobMemoryMB: 512,
      jobMaxProcesses: 64,
    },
  });
  const capability = {
    sandboxCapability: configured.sandboxCapability,
    ...(configured.sandboxReason !== undefined ? { sandboxReason: configured.sandboxReason } : {}),
  };

  const jobId = randomUUID();
  // 双引号包裹防路径含空格（cmd 由 core 侧命令行解析）
  const cmd = `"${env.pythonPath()}" "${wrapperPath}"`;
  await core.startJob({
    sessionId: coreSessionId,
    jobId,
    kind: "exec",
    cmd,
    cwd,
    timeoutMs: TIMEOUT_MS,
    network: "allow",
  });

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let afterSeq = 0;
  const drain = async (): Promise<void> => {
    const out = await core.jobOutput({ sessionId: coreSessionId, jobId, afterSeq });
    for (const chunk of out.chunks) {
      const bytes = Buffer.byteLength(chunk.data, "utf8");
      if (chunk.stream === "stdout") {
        stdoutBytes += bytes;
        if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.data;
      } else {
        stderrBytes += bytes;
        if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.data;
      }
    }
    afterSeq = out.nextSeq;
  };
  const finish = (exitCode: number, extraStderr?: string): PythonExecResult => {
    if (stdoutBytes > MAX_OUTPUT_BYTES) stdout += "\n... (output truncated)";
    if (stderrBytes > MAX_OUTPUT_BYTES) stderr += "\n... (stderr truncated)";
    if (extraStderr) stderr += stderr ? `\n${extraStderr}` : extraStderr;
    return { stdout, stderr, exitCode, isolated: false, containment: "jobobject", ...capability };
  };

  let status: JobStatus;
  while (true) {
    if (signal.aborted) {
      // 主动停止：尽力取消 job（整树杀），再尽力收尾剩余输出
      await core.cancelJob({ sessionId: coreSessionId, jobId }).catch(() => undefined);
      await drain().catch(() => undefined);
      return finish(1, "(aborted)");
    }
    await drain();
    status = await core.jobStatus({ sessionId: coreSessionId, jobId });
    if (status.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, CORE_POLL_MS));
  }
  // 终态后再拉一次，冲刷终态前最后一段输出
  await drain().catch(() => undefined);
  if (status.state === "timed_out") return finish(status.exitCode ?? 1, "(timed out after 30s)");
  if (status.state === "cancelled") return finish(status.exitCode ?? 1, "(cancelled)");
  return finish(status.exitCode ?? 1);
}

function runWithLimits(
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;

    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      proc.kill("SIGTERM");
      // 5 秒宽限后仍未退出则升级 SIGKILL
      killTimer ??= setTimeout(() => {
        proc.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const timeout = setTimeout(terminate, TIMEOUT_MS);
    const onAbort = terminate;
    signal.addEventListener("abort", onAbort);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      if (stdoutBytes > MAX_OUTPUT_BYTES) stdout += "\n... (output truncated)";
      if (stderrBytes > MAX_OUTPUT_BYTES) stderr += "\n... (stderr truncated)";
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/** 收集 img 目录中本次执行生成的图片（base64 内联返回）。 */
async function collectImages(imgDir: string): Promise<{ data: string; mediaType: string }[]> {
  try {
    const files = await readdir(imgDir);
    const images: { data: string; mediaType: string }[] = [];
    for (const file of files) {
      const mediaType = IMAGE_MEDIA_TYPES[path.extname(file).toLowerCase()];
      if (!mediaType) continue;
      const data = await readFile(path.join(imgDir, file));
      images.push({ data: data.toString("base64"), mediaType });
    }
    return images;
  } catch {
    return [];
  }
}
