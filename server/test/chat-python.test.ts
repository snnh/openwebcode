import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobOutputResult, JobStartRequest, JobStatus } from "../src/core-client.js";
import type { SandboxPolicy } from "../src/sessions/types.js";
import { ChatPythonEnv } from "../src/chat/chat-python-env.js";
import { buildBwrapArgs, buildSandboxEnv, buildWrapper, executePython, type ChatPythonCoreBridge } from "../src/chat/chat-python-runner.js";
import { chatTools, type ChatToolContext } from "../src/chat/chat-tools.js";
import { tempRoot } from "./helpers/temp-roots.js";

interface SpawnCall {
  cmd: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string>; stdio?: unknown };
  child: FakeChild;
}
interface FakeChild {
  on(event: string, listener: (...a: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: { on(event: string, listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: string, listener: (chunk: Buffer) => void): unknown };
}

const h = vi.hoisted(() => ({
  spawnCalls: [] as SpawnCall[],
  handler: ((_cmd: string, _args: string[], child: FakeChild) => {
    child.emit("close", 0);
  }) as (cmd: string, args: string[], child: FakeChild) => void,
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: vi.fn((cmd: string, args: string[], options: SpawnCall["options"]) => {
      const child = new EventEmitter() as unknown as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      h.spawnCalls.push({ cmd, args, options, child });
      setImmediate(() => h.handler(cmd, args, child));
      return child;
    }),
  };
});

const makeRoot = (): Promise<string> => tempRoot("owc-chat-py-");

/** 造一个"解释器存在"的假 venv（python --version 由 spawn mock 放行）。 */
async function makeUsableEnv(root: string): Promise<ChatPythonEnv> {
  const env = new ChatPythonEnv(path.join(root, "venv"), ["numpy"]);
  const py = env.pythonPath();
  await mkdir(path.dirname(py), { recursive: true });
  await writeFile(py, "fake-python");
  return env;
}

/** 找到真正的 python 运行调用（参数里带 wrapper.py；区别于 --version / bwrap --version 探测）。 */
function runCalls(): SpawnCall[] {
  return h.spawnCalls.filter((c) => c.args.some((a) => String(a).endsWith("wrapper.py")));
}

beforeEach(() => {
  h.spawnCalls.length = 0;
  h.handler = (_cmd, _args, child) => {
    child.emit("close", 0);
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWrapper", () => {
  it("整体黑名单 subprocess/shutil/ctypes/socket", () => {
    const w = buildWrapper("C:\\t\\s.py", "C:\\t\\img", "C:\\t\\mpl", "C:\\t\\home");
    expect(w).toContain('frozenset({"subprocess", "shutil", "ctypes", "socket"})');
  });

  it("os 危险属性导入后封印（非带点名黑名单）", () => {
    const w = buildWrapper("C:\\t\\s.py", "C:\\t\\img", "C:\\t\\mpl", "C:\\t\\home");
    expect(w).toContain("_OS_SEALED_NAMES");
    expect(w).toContain("_OS_SEALED_PREFIXES");
    expect(w).toContain('"system", "popen", "fork"');
    expect(w).toContain('("spawn", "exec")');
    expect(w).toContain("setattr(mod, attr, _blocked_callable(");
    expect(w).toContain("PermissionError");
  });

  it("patch builtins.__import__ 与 importlib.import_module", () => {
    const w = buildWrapper("C:\\t\\s.py", "C:\\t\\img", "C:\\t\\mpl", "C:\\t\\home");
    expect(w).toContain("builtins.__import__ = _guarded_import");
    expect(w).toContain("importlib.import_module = _guarded_import_module");
  });

  it("用户代码在独立命名空间执行，不共享 wrapper 全局", () => {
    const w = buildWrapper("C:\\t\\s.py", "C:\\t\\img", "C:\\t\\mpl", "C:\\t\\home");
    expect(w).toContain('_user_globals = {"__name__": "__main__"');
    expect(w).toContain("exec(compile(_source");
    expect(w).not.toContain("exec(open(");
  });

  it("env 白名单清洗段（第二道防线）", () => {
    const w = buildWrapper("C:\\t\\s.py", "C:\\t\\img", "C:\\t\\mpl", "C:\\t\\home");
    expect(w).toContain("_ENV_KEEP");
    expect(w).toContain('"PATH", "SYSTEMROOT", "HOME", "LANG", "TZ", "MPLBACKEND", "MPLCONFIGDIR", "PYTHONNOUSERSITE", "TEMP", "TMP"');
    expect(w).toContain("if _key.upper() not in _ENV_KEEP");
    expect(w).toContain("del _os.environ[_key]");
    expect(w).toContain('_os.environ["MPLBACKEND"] = "Agg"');
    // MPLCONFIGDIR / HOME 注入实际路径（Windows 反斜杠转义）
    expect(w).toContain('_os.environ["MPLCONFIGDIR"] = r"C:\\\\t\\\\mpl"');
    expect(w).toContain('_os.environ["HOME"] = r"C:\\\\t\\\\home"');
  });
});

describe("buildSandboxEnv", () => {
  it("白名单环境，不继承 process.env", () => {
    process.env.OWC_TEST_SECRET = "should-not-leak";
    try {
      const env = buildSandboxEnv("/home/x", "/home/x/tmp/mpl");
      const allowed = new Set(["PATH", "HOME", "LANG", "TZ", "MPLBACKEND", "MPLCONFIGDIR", "PYTHONNOUSERSITE"]);
      for (const key of Object.keys(env)) expect(allowed.has(key)).toBe(true);
      expect(env.OWC_TEST_SECRET).toBeUndefined();
      expect(env.HOME).toBe("/home/x");
      expect(env.MPLBACKEND).toBe("Agg");
      expect(env.MPLCONFIGDIR).toBe("/home/x/tmp/mpl");
      expect(env.PYTHONNOUSERSITE).toBe("1");
      expect(env.PATH).toBeTruthy();
    } finally {
      delete process.env.OWC_TEST_SECRET;
    }
  });
});

describe("buildBwrapArgs", () => {
  const base = {
    venvDir: "/data/chat-python-env",
    sessionDir: "/data/chat-sessions/s1",
    cwd: "/data/chat-sessions/s1",
    python: "/data/chat-python-env/bin/python",
    wrapperPath: "/data/chat-sessions/s1/tmp/wrapper.py",
    env: { PATH: "/usr/bin:/bin", MPLBACKEND: "Agg" },
  };

  it("namespace 隔离 + 绑定 + cwd + setenv + 入口", () => {
    const args = buildBwrapArgs({ ...base, exists: () => true });
    expect(args.slice(0, 3)).toEqual(["--unshare-all", "--die-with-parent", "--new-session"]);
    for (const dir of ["/usr", "/lib", "/lib64"]) {
      const i = args.indexOf(dir);
      expect(args[i - 1]).toBe("--ro-bind");
      expect(args[i + 1]).toBe(dir);
    }
    expect(args).toContain("--tmpfs");
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp");
    expect(args[args.indexOf("--chdir") + 1]).toBe(base.sessionDir);
    expect(args).toContain("--clearenv");
    expect(args[args.indexOf("--setenv") + 1]).toBe("PATH");
    expect(args.slice(-2)).toEqual([base.python, base.wrapperPath]);
    // venv 只读、sessionDir 可写
    expect(args[args.indexOf(base.venvDir) - 1]).toBe("--ro-bind");
    expect(args[args.indexOf(base.sessionDir) - 1]).toBe("--bind");
  });

  it("不存在的系统目录不绑定", () => {
    const args = buildBwrapArgs({ ...base, exists: (p) => p !== "/lib64" });
    expect(args).not.toContain("/lib64");
    expect(args).toContain("/usr");
  });

  it("meta.cwd 在会话目录之外时额外 --bind", () => {
    const args = buildBwrapArgs({ ...base, cwd: "/other/work", exists: () => false });
    const i = args.indexOf("/other/work");
    expect(args[i - 1]).toBe("--bind");
    expect(args[i + 1]).toBe("/other/work");
  });
});

describe("executePython", () => {
  it("spawn 使用白名单 env 与显式 cwd，不泄露 process.env", async () => {
    process.env.OWC_TEST_PROVIDER_KEY = "sk-secret";
    try {
      const root = await makeRoot();
      const env = await makeUsableEnv(root);
      const sessionDir = path.join(root, "session");
      await mkdir(sessionDir, { recursive: true });
      const result = await executePython(env, sessionDir, "print(1)", new AbortController().signal);
      expect(runCalls()).toHaveLength(1);
      const run = runCalls()[0]!;
      expect(run.options.cwd).toBe(sessionDir);
      expect(run.options.env?.MPLBACKEND).toBe("Agg");
      expect(run.options.env?.PYTHONNOUSERSITE).toBe("1");
      expect(run.options.env?.HOME).toBe(sessionDir);
      expect(run.options.env?.OWC_TEST_PROVIDER_KEY).toBeUndefined();
      expect(Object.keys(run.options.env ?? {}).length).toBeLessThanOrEqual(7);
      expect(typeof result.isolated).toBe("boolean");
    } finally {
      delete process.env.OWC_TEST_PROVIDER_KEY;
    }
  });

  it("collectImages 批次隔离：只收集本次执行产生的图片", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    const sessionDir = path.join(root, "session");
    const imgDir = path.join(sessionDir, "tmp", "img");
    await mkdir(imgDir, { recursive: true });
    await writeFile(path.join(imgDir, "old.png"), Buffer.from("OLD"));

    h.handler = (cmd, args, child) => {
      const isRun = args.some((a) => String(a).endsWith("wrapper.py"));
      if (isRun) {
        void (async () => {
          await writeFile(path.join(imgDir, "new.png"), Buffer.from("NEWDATA"));
          child.emit("close", 0);
        })();
      } else {
        child.emit("close", 0);
      }
    };
    const result = await executePython(env, sessionDir, "pass", new AbortController().signal);
    expect(result.images).toHaveLength(1);
    expect(result.images![0]).toEqual({ data: Buffer.from("NEWDATA").toString("base64"), mediaType: "image/png" });
  });

  it("meta.cwd 为存在目录时作为子进程 cwd，否则回落 sessionDir", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    const sessionDir = path.join(root, "session");
    const other = path.join(root, "other");
    await mkdir(other, { recursive: true });

    await executePython(env, sessionDir, "pass", new AbortController().signal, { cwd: other });
    expect(runCalls().at(-1)!.options.cwd).toBe(other);

    await executePython(env, sessionDir, "pass", new AbortController().signal, { cwd: path.join(root, "missing") });
    expect(runCalls().at(-1)!.options.cwd).toBe(sessionDir);
  });

  it("POSIX 且 bwrap 可用时经 bwrap 启动并上报 isolated:true", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "linux" });
    try {
      const root = await makeRoot();
      const env = await makeUsableEnv(root);
      const sessionDir = path.join(root, "session");
      const result = await executePython(env, sessionDir, "pass", new AbortController().signal);
      const run = runCalls()[0]!;
      expect(run.cmd).toBe("bwrap");
      expect(run.args).toContain("--unshare-all");
      expect(run.args).toContain("--die-with-parent");
      expect(run.args).toContain("--new-session");
      expect(run.args.at(-2)).toBe(env.pythonPath());
      expect(run.args.at(-1)).toContain("wrapper.py");
      expect(result.isolated).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("bwrap 探测失败时回落无隔离并如实上报 isolated:false", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "linux" });
    h.handler = (cmd, args, child) => {
      if (cmd === "bwrap" && args[0] === "--version") {
        child.emit("error", new Error("ENOENT"));
        return;
      }
      child.emit("close", 0);
    };
    try {
      const root = await makeRoot();
      const env = await makeUsableEnv(root);
      const sessionDir = path.join(root, "session");
      const result = await executePython(env, sessionDir, "pass", new AbortController().signal);
      const run = runCalls()[0]!;
      expect(run.cmd).toBe(env.pythonPath());
      expect(run.args).toHaveLength(1);
      expect(result.isolated).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });
});

describe("ChatPythonEnv", () => {
  it("解释器存在且可运行时复用 venv，不重跑 uv", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    await env.ensure();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]!.cmd).toBe(env.pythonPath());
    expect(h.spawnCalls[0]!.args).toEqual(["--version"]);
  });

  it("解释器损坏时重建（uv venv + pip install）", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    h.handler = (cmd, args, child) => {
      child.emit("close", cmd === env.pythonPath() && args[0] === "--version" ? 1 : 0);
    };
    await env.ensure();
    const uvVenv = h.spawnCalls.find((c) => c.cmd === "uv" && c.args[0] === "venv");
    const uvPip = h.spawnCalls.find((c) => c.cmd === "uv" && c.args[0] === "pip");
    expect(uvVenv).toBeDefined();
    expect(uvPip?.args).toContain("numpy");
    expect(uvPip?.args).toContain(env.pythonPath());
  });

  it("默认目录名对齐 chat-python-env", () => {
    const env = ChatPythonEnv.forDataDir("/data", []);
    expect(env.dir).toBe(path.join("/data", "chat-python-env"));
  });
});

describe("python 工具 handler（onPythonStatus）", () => {
  function makeCtx(env: ChatPythonEnv, sessionDir: string, statuses: { status: string; detail?: string }[]): ChatToolContext {
    return {
      searchProvider: undefined,
      webFetchProvider: undefined,
      getImageGenProvider: async () => undefined,
      getVisionProvider: async () => undefined,
      pythonEnv: env,
      sessionDir,
      signal: new AbortController().signal,
      onPythonStatus: (status, detail) => statuses.push(detail === undefined ? { status } : { status, detail }),
    };
  }

  it("成功路径：preparing -> ready，输出含 isolated 标记", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    const sessionDir = path.join(root, "session");
    const statuses: { status: string; detail?: string }[] = [];
    const tool = chatTools().find((t) => t.name === "python")!;
    const out = await tool.handler({ code: "print(1)" }, makeCtx(env, sessionDir, statuses));
    expect(statuses.map((s) => s.status)).toEqual(["preparing", "ready"]);
    const text = out.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("[isolated]");
  });

  it("env 准备失败：preparing -> error（detail 截断）并抛错", async () => {
    const root = await makeRoot();
    // 无 python 二进制 + uv 失败 -> ensure 拒绝
    const env = new ChatPythonEnv(path.join(root, "venv"), ["numpy"]);
    h.handler = (_cmd, _args, child) => {
      child.emit("close", 1);
    };
    const sessionDir = path.join(root, "session");
    const statuses: { status: string; detail?: string }[] = [];
    const tool = chatTools().find((t) => t.name === "python")!;
    await expect(tool.handler({ code: "pass" }, makeCtx(env, sessionDir, statuses))).rejects.toThrow();
    expect(statuses.map((s) => s.status)).toEqual(["preparing", "error"]);
    expect(statuses[1]!.detail!.length).toBeLessThanOrEqual(200);
  });
});

/** 脚本化 fake core 桥：jobOutput/jobStatus 按队列依次返回（队列耗尽后 jobOutput 返回空、jobStatus 保持最后一个状态）。 */
interface FakeCore {
  bridge: ChatPythonCoreBridge;
  configureRequests: { sessionId: string; cwd: string; sandbox: SandboxPolicy }[];
  startRequests: JobStartRequest[];
  cancelRequests: { sessionId: string; jobId: string }[];
}

function makeFakeCore(script: {
  outputs?: JobOutputResult[];
  statuses?: JobStatus[];
  capability?: string;
  reason?: string;
  configureError?: Error;
  startError?: Error;
}): FakeCore {
  const outputs = [...(script.outputs ?? [])];
  const statuses = [...(script.statuses ?? [])];
  let lastStatus: JobStatus = { jobId: "?", state: "running" };
  const fake: FakeCore = {
    configureRequests: [],
    startRequests: [],
    cancelRequests: [],
    bridge: {
      async configureSession(request) {
        fake.configureRequests.push(request);
        if (script.configureError) throw script.configureError;
        return {
          sandboxCapability: script.capability ?? "partial",
          ...(script.reason !== undefined ? { sandboxReason: script.reason } : {}),
        };
      },
      async startJob(request) {
        fake.startRequests.push(request);
        if (script.startError) throw script.startError;
        return { jobId: request.jobId, state: "running" };
      },
      async jobStatus(request) {
        const next = statuses.shift();
        if (next) lastStatus = { ...next, jobId: request.jobId };
        return lastStatus;
      },
      async jobOutput(request) {
        const next = outputs.shift();
        if (next) return next;
        return { chunks: [], nextSeq: request.afterSeq, truncated: false };
      },
      async cancelJob(request) {
        fake.cancelRequests.push(request);
        return { jobId: request.jobId, accepted: true as const };
      },
    },
  };
  return fake;
}

describe("executePython 经 core（Windows Job Object）", () => {
  async function setup() {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    const sessionDir = path.join(root, "session");
    return { root, env, sessionDir };
  }

  it("configureSession 沙盒形状 + startJob 双引号 cmd + 轮询拼接 + capability 透传", async () => {
    const { env, sessionDir } = await setup();
    const fake = makeFakeCore({
      capability: "partial",
      reason: "Job Object: process-tree limits only",
      outputs: [
        { chunks: [{ seq: 0, stream: "stdout", data: "hello " }], nextSeq: 1, truncated: false },
        { chunks: [{ seq: 1, stream: "stdout", data: "world" }, { seq: 2, stream: "stderr", data: "warn" }], nextSeq: 3, truncated: false },
      ],
      statuses: [
        { jobId: "", state: "running" },
        { jobId: "", state: "completed", exitCode: 0 },
      ],
    });
    const result = await executePython(env, sessionDir, "print(1)", new AbortController().signal, {
      platform: "win32",
      core: fake.bridge,
      sessionId: "s1",
    });
    // 不 spawn 本机 python 进程（仅 ensure 的 --version 探测）
    expect(runCalls()).toHaveLength(0);

    expect(fake.configureRequests).toHaveLength(1);
    const cfg = fake.configureRequests[0]!;
    expect(cfg.sessionId).toBe("chat-python-s1");
    expect(cfg.cwd).toBe(sessionDir);
    expect(cfg.sandbox.enabled).toBe(true);
    expect(cfg.sandbox.readRoots).toEqual([sessionDir, env.dir]);
    expect(cfg.sandbox.writeRoots).toEqual([sessionDir]);
    expect(cfg.sandbox.denyPaths).toEqual([]);
    expect(cfg.sandbox.network).toBe("allow");
    expect(cfg.sandbox.jobMemoryMB).toBe(512);
    expect(cfg.sandbox.jobMaxProcesses).toBe(64);

    expect(fake.startRequests).toHaveLength(1);
    const start = fake.startRequests[0]!;
    expect(start.sessionId).toBe("chat-python-s1");
    expect(start.kind).toBe("exec");
    const wrapperPath = path.join(sessionDir, "tmp", "wrapper.py");
    expect(start.cmd).toBe(`"${env.pythonPath()}" "${wrapperPath}"`);
    expect(start.cwd).toBe(sessionDir);
    expect(start.timeoutMs).toBe(30_000);
    expect(start.network).toBe("allow");

    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn");
    expect(result.exitCode).toBe(0);
    expect(result.isolated).toBe(false);
    expect(result.containment).toBe("jobobject");
    expect(result.sandboxCapability).toBe("partial");
    expect(result.sandboxReason).toBe("Job Object: process-tree limits only");
  });

  it("输出超过 256KB 按流截断并附截断标记", async () => {
    const { env, sessionDir } = await setup();
    const big = "x".repeat(300 * 1024);
    const fake = makeFakeCore({
      outputs: [{ chunks: [{ seq: 0, stream: "stdout", data: big }], nextSeq: 1, truncated: true }],
      statuses: [{ jobId: "", state: "completed", exitCode: 0 }],
    });
    const result = await executePython(env, sessionDir, "pass", new AbortController().signal, {
      platform: "win32",
      core: fake.bridge,
      sessionId: "s1",
    });
    expect(result.stdout).toContain("... (output truncated)");
    expect(result.stdout.length).toBeLessThan(big.length);
  });

  it("timed_out 收尾：stderr 附超时说明，exitCode 缺省 1", async () => {
    const { env, sessionDir } = await setup();
    const fake = makeFakeCore({
      statuses: [{ jobId: "", state: "timed_out" }],
    });
    const result = await executePython(env, sessionDir, "pass", new AbortController().signal, {
      platform: "win32",
      core: fake.bridge,
      sessionId: "s1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("(timed out after 30s)");
    expect(result.containment).toBe("jobobject");
  });

  it("abort 触发 cancelJob 并按取消收尾", async () => {
    const { env, sessionDir } = await setup();
    const fake = makeFakeCore({
      statuses: [{ jobId: "", state: "running" }],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await executePython(env, sessionDir, "pass", controller.signal, {
      platform: "win32",
      core: fake.bridge,
      sessionId: "s1",
    });
    expect(fake.cancelRequests).toHaveLength(1);
    expect(fake.cancelRequests[0]!.sessionId).toBe("chat-python-s1");
    expect(fake.cancelRequests[0]!.jobId).toBe(fake.startRequests[0]!.jobId);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("(aborted)");
  });

  it("configureSession 抛错如实上抛，不静默回落直启", async () => {
    const { env, sessionDir } = await setup();
    const fake = makeFakeCore({ configureError: new Error("Core is not running") });
    await expect(executePython(env, sessionDir, "pass", new AbortController().signal, {
      platform: "win32",
      core: fake.bridge,
      sessionId: "s1",
    })).rejects.toThrow("Core is not running");
    expect(runCalls()).toHaveLength(0);
  });
});

describe("executePython 平台分流", () => {
  it("win32 无 core 时回落直启（containment:none）", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    const sessionDir = path.join(root, "session");
    const result = await executePython(env, sessionDir, "pass", new AbortController().signal, { platform: "win32" });
    expect(runCalls()).toHaveLength(1);
    expect(runCalls()[0]!.cmd).toBe(env.pythonPath());
    expect(result.isolated).toBe(false);
    expect(result.containment).toBe("none");
  });

  it("win32 有 core 但缺 sessionId 时回落直启", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    const sessionDir = path.join(root, "session");
    const fake = makeFakeCore({ statuses: [{ jobId: "", state: "completed", exitCode: 0 }] });
    const result = await executePython(env, sessionDir, "pass", new AbortController().signal, {
      platform: "win32",
      core: fake.bridge,
    });
    expect(runCalls()).toHaveLength(1);
    expect(fake.startRequests).toHaveLength(0);
    expect(result.containment).toBe("none");
  });

  it("linux 即使注入 core 也不走 core（bwrap 路径）", async () => {
    const root = await makeRoot();
    const env = await makeUsableEnv(root);
    const sessionDir = path.join(root, "session");
    const fake = makeFakeCore({ statuses: [{ jobId: "", state: "completed", exitCode: 0 }] });
    const result = await executePython(env, sessionDir, "pass", new AbortController().signal, {
      platform: "linux",
      core: fake.bridge,
      sessionId: "s1",
    });
    expect(fake.startRequests).toHaveLength(0);
    const run = runCalls()[0]!;
    expect(run.cmd).toBe("bwrap");
    expect(result.isolated).toBe(true);
    expect(result.containment).toBe("bwrap");
  });
});

describe("ChatPythonEnv libraries provider", () => {
  it("惰性求值：ensure 建环境时才调用 provider", async () => {
    const root = await makeRoot();
    let calls = 0;
    const env = new ChatPythonEnv(path.join(root, "venv"), () => {
      calls++;
      return Promise.resolve(["numpy", "pandas"]);
    });
    expect(calls).toBe(0);
    await env.ensure();
    expect(calls).toBe(1);
    const uvPip = h.spawnCalls.find((c) => c.cmd === "uv" && c.args[0] === "pip");
    expect(uvPip?.args).toContain("numpy");
    expect(uvPip?.args).toContain("pandas");
  });

  it("venv 已可用时不调用 provider", async () => {
    const root = await makeRoot();
    const venvPath = path.join(root, "venv");
    const py = path.join(venvPath, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    await mkdir(path.dirname(py), { recursive: true });
    await writeFile(py, "fake-python");
    let calls = 0;
    const env = new ChatPythonEnv(venvPath, () => {
      calls++;
      return Promise.resolve(["numpy"]);
    });
    await env.ensure();
    expect(calls).toBe(0);
    expect(h.spawnCalls.find((c) => c.cmd === "uv")).toBeUndefined();
  });
});

describe("python 工具 handler（containment 标注）", () => {
  it("win32 + core 时走 core 路由并标注 jobobject containment", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      const root = await makeRoot();
      const env = await makeUsableEnv(root);
      const sessionDir = path.join(root, "session");
      const fake = makeFakeCore({ statuses: [{ jobId: "", state: "completed", exitCode: 0 }] });
      const tool = chatTools().find((t) => t.name === "python")!;
      const ctx: ChatToolContext = {
        searchProvider: undefined,
        webFetchProvider: undefined,
        getImageGenProvider: async () => undefined,
        getVisionProvider: async () => undefined,
        pythonEnv: env,
        sessionDir,
        signal: new AbortController().signal,
        core: fake.bridge,
        sessionId: "s1",
      };
      const out = await tool.handler({ code: "pass" }, ctx);
      const text = (out.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? "";
      expect(fake.startRequests).toHaveLength(1);
      expect(fake.startRequests[0]!.sessionId).toBe("chat-python-s1");
      expect(text).toContain("[isolated] false");
      expect(text).toContain("[containment] jobobject (process-tree limits only; no network/FS isolation)");
      expect(text).toContain("[sandbox] partial");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("无 core 直启时标注 no OS isolation", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      const root = await makeRoot();
      const env = await makeUsableEnv(root);
      const sessionDir = path.join(root, "session");
      const tool = chatTools().find((t) => t.name === "python")!;
      const ctx: ChatToolContext = {
        searchProvider: undefined,
        webFetchProvider: undefined,
        getImageGenProvider: async () => undefined,
        getVisionProvider: async () => undefined,
        pythonEnv: env,
        sessionDir,
        signal: new AbortController().signal,
      };
      const out = await tool.handler({ code: "pass" }, ctx);
      const text = (out.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? "";
      expect(text).toContain("[isolated] false");
      expect(text).toContain("[containment] none (no OS isolation)");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });
});
