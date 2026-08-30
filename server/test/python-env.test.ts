import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveNodeEnv, NodeEnvManagers, nodeBinDir, nodeEnvActivationCommand, nodeToolchainReadOnlyPaths, nodeToolchainWritePaths, wrapCommandWithNodeEnv } from "../src/node-env.js";
import { effectivePythonEnv, pythonEnvWritePaths, UvPythonEnvironments, uvVenvDir, wrapCommandWithNote, wrapCommandWithVenv } from "../src/python-env.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("python-env helpers", () => {
  it("resolves the effective python env with session > global default > host", () => {
    expect(effectivePythonEnv("uv-workspace", "uv-config")).toBe("uv-workspace");
    expect(effectivePythonEnv(undefined, "uv-config")).toBe("uv-config");
    expect(effectivePythonEnv(undefined, undefined)).toBe("global");
  });

  it("locates uv venvs per mode", () => {
    const cwd = path.join("repo");
    const dataDir = path.join("data");
    expect(uvVenvDir("global", cwd, dataDir)).toBeUndefined();
    expect(uvVenvDir("uv-workspace", cwd, dataDir)).toBe(path.join(cwd, ".owc", "venv"));
    const first = uvVenvDir("uv-config", cwd, dataDir);
    const second = uvVenvDir("uv-config", path.join("other"), dataDir);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(path.dirname(first!)).toBe(path.join(dataDir, "venvs"));
    expect(path.basename(first!)).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
    // 无 dataDir 时 uv-config 退化为本机环境
    expect(uvVenvDir("uv-config", cwd, undefined)).toBeUndefined();
  });

  it("wraps commands for cmd on Windows by prepending the venv Scripts dir", () => {
    expect(wrapCommandWithVenv("pytest", "C:\\repo\\.owc\\venv", "cmd", "win32"))
      .toBe('set "PATH=C:\\repo\\.owc\\venv\\Scripts;%PATH%" && pytest');
  });

  it("wraps commands for Git Bash on Windows (Scripts dir, forward slashes)", () => {
    expect(wrapCommandWithVenv("pytest", "C:\\repo\\.owc\\venv", "sh", "win32"))
      .toBe("export PATH='C:/repo/.owc/venv/Scripts':$PATH; pytest");
  });

  it("wraps commands for pwsh on Windows", () => {
    expect(wrapCommandWithVenv("pytest", "C:\\repo\\.owc\\venv", "pwsh", "win32"))
      .toBe("$env:Path = 'C:\\repo\\.owc\\venv\\Scripts;' + $env:Path; pytest");
  });

  it("wraps commands for POSIX shells", () => {
    expect(wrapCommandWithVenv("pytest", "/repo/.owc/venv", "sh", "linux"))
      .toBe("export PATH='/repo/.owc/venv/bin':$PATH; pytest");
  });

  it("prefixes the fallback note", () => {
    expect(wrapCommandWithNote("pytest", "uv is not available on PATH, using the host python environment"))
      .toBe("echo [openwebcode] uv is not available on PATH, using the host python environment && pytest");
  });

  it("strips shell metacharacters from the note (uv stderr is not server-generated)", () => {
    // `;` `&&` `$()` 反引号 引号 换行 等都必须被剥离，否则 note 会拼接成额外命令
    expect(wrapCommandWithNote("pytest", 'uv venv failed (boom); $(curl evil) && `id` "quoted"\nnext'))
      .toBe("echo [openwebcode] uv venv failed (boom) (curl evil) id quoted next && pytest");
    // 全部剥离后兜底为安全占位文本
    expect(wrapCommandWithNote("pytest", "&&;|`$"))
      .toBe("echo [openwebcode] uv environment unavailable, using the host python environment && pytest");
  });
});

describe("pythonEnvWritePaths（非本机 python 环境的读写挂载）", () => {
  it("uv-config + cwd + dataDir（POSIX）→ 数据目录下的 venv 目录", () => {
    expect(pythonEnvWritePaths("uv-config", "/work", "/data", "linux")).toEqual([uvVenvDir("uv-config", "/work", "/data")]);
    expect(pythonEnvWritePaths("uv-config", "/work", "/data", "darwin")).toEqual([uvVenvDir("uv-config", "/work", "/data")]);
  });

  it("uv-config 无 dataDir / uv-workspace / global → 空", () => {
    expect(pythonEnvWritePaths("uv-config", "/work", undefined, "linux")).toEqual([]);
    expect(pythonEnvWritePaths("uv-workspace", "/work", "/data", "linux")).toEqual([]);
    expect(pythonEnvWritePaths("global", "/work", "/data", "linux")).toEqual([]);
  });

  it("win32 同样返回 venv 路径（是否挂载由调用方按生效沙盒模式门禁）", () => {
    expect(pythonEnvWritePaths("uv-config", "C:\\work", "D:\\data", "win32")).toEqual([uvVenvDir("uv-config", "C:\\work", "D:\\data")]);
    expect(pythonEnvWritePaths("global", "C:\\work", "D:\\data", "win32")).toEqual([]);
  });
});

// uv 可用性按宿主探测双分支：doEnsure 先跑 `uv --version`，uv 缺失时直接失败（不看目录），
// 故"无 uv"分支两次 ensure 均失败；"有 uv"分支才能测缓存命中 + 重建路径。
const uvAvailable = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

function fakeVenvLayout(venvDir: string): { binDir: string; pythonExe: string } {
  const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
  return { binDir, pythonExe: path.join(binDir, process.platform === "win32" ? "python.exe" : "python") };
}

describe("UvPythonEnvironments.ensure 缓存复查", () => {
  it.runIf(uvAvailable)("缓存命中时复查 python 可执行文件仍在，缺失则真实重建", async () => {
    const root = await tempRoot("owc-uv-venv-");
    const venvDir = path.join(root, "venv");
    const { binDir, pythonExe } = fakeVenvLayout(venvDir);
    await mkdir(binDir, { recursive: true });
    await writeFile(pythonExe, "");
    const envs = new UvPythonEnvironments();
    // 假 venv（python 存在）：doEnsure 探测到已就绪，直接 ok 并缓存
    expect(await envs.ensure(venvDir)).toEqual({ ok: true });
    // 用户手动删掉 python 可执行文件：缓存命中路径 existsSync 复查失败 → 走 uv venv 真实重建
    await rm(pythonExe);
    const rebuilt = await envs.ensure(venvDir);
    expect(rebuilt.ok).toBe(true);
    expect(existsSync(pythonExe)).toBe(true);
  }, 180_000);

  it.runIf(!uvAvailable)("uv 不可用：ensure 直接失败并带回退 note（不看 venv 目录）", async () => {
    const root = await tempRoot("owc-uv-venv-");
    const venvDir = path.join(root, "venv");
    const { binDir, pythonExe } = fakeVenvLayout(venvDir);
    await mkdir(binDir, { recursive: true });
    await writeFile(pythonExe, "");
    const envs = new UvPythonEnvironments();
    const first = await envs.ensure(venvDir);
    expect(first.ok).toBe(false);
    expect(first.note).toContain("uv is not available");
    // 失败不缓存：第二次重试仍失败
    const second = await envs.ensure(venvDir);
    expect(second.ok).toBe(false);
    expect(second.note).toContain("uv is not available");
  });
});

// ---- node-env 组（合并） ----
describe("nodeToolchainReadOnlyPaths（与 nodeEnv 绑定的工具链挂载）", () => {
  const exists = (...paths: string[]) => (target: string) => paths.includes(target);
  const identity = (target: string) => target;

  it("global：解析 PATH 上生效的 node/npm 工具链根，系统树排除、去重", () => {
    const deps = {
      platform: "linux" as const,
      pathEnv: "/home/u/.nvm/versions/node/v22.11.0/bin:/usr/bin:/opt/custom/bin",
      exists: exists("/home/u/.nvm/versions/node/v22.11.0/bin/node", "/usr/bin/node", "/opt/custom/bin/npm"),
      realpath: identity,
    };
    expect(nodeToolchainReadOnlyPaths("global", deps)).toEqual(["/home/u/.nvm/versions/node/v22.11.0", "/opt/custom"]);
  });

  it("global：仅系统 node 或空 PATH 时不挂载", () => {
    expect(nodeToolchainReadOnlyPaths("global", { platform: "linux", pathEnv: "/usr/bin:/bin", exists: exists("/usr/bin/node", "/bin/node"), realpath: identity })).toEqual([]);
    expect(nodeToolchainReadOnlyPaths("global", { platform: "linux", pathEnv: "", exists: () => false })).toEqual([]);
  });

  it("global：bin 目录为软链时按 realpath 后的真实根挂载", () => {
    const deps = {
      platform: "linux" as const,
      pathEnv: "/home/u/bin",
      exists: exists("/home/u/bin/node"),
      realpath: (target: string) => (target === "/home/u/bin" ? "/home/u/.volta/bin" : target),
    };
    expect(nodeToolchainReadOnlyPaths("global", deps)).toEqual(["/home/u/.volta"]);
  });

  it("nvm/fnm 走读写层（nodeToolchainWritePaths），只读层不追加", () => {
    expect(nodeToolchainReadOnlyPaths("nvm", { platform: "linux", nvmDir: "/home/u/.nvm", exists: exists("/home/u/.nvm/nvm.sh") })).toEqual([]);
    expect(nodeToolchainReadOnlyPaths("nvm", { platform: "linux", nvmDir: "/home/u/.nvm", exists: () => false })).toEqual([]);
    const deps = { platform: "linux" as const, home: "/home/u", fnmDir: "/opt/fnm", exists: exists("/opt/fnm", "/home/u/.local/share/fnm") };
    expect(nodeToolchainReadOnlyPaths("fnm", deps)).toEqual([]);
  });

  it("project 不挂载；win32 仅 global 且命中用户 profile 才挂载（只读层）", () => {
    expect(nodeToolchainReadOnlyPaths("project", { platform: "linux", exists: () => true })).toEqual([]);
    expect(nodeToolchainReadOnlyPaths("nvm", { platform: "win32", exists: () => true })).toEqual([]);
    // profile 之外（非用户目录）不挂载
    expect(nodeToolchainReadOnlyPaths("global", { platform: "win32", pathEnv: "C:\\nvm", exists: () => true, realpath: (target) => target })).toEqual([]);
    // 用户 profile 下的工具链根挂载
    expect(nodeToolchainReadOnlyPaths("global", { platform: "win32", home: "C:\\Users\\u", pathEnv: "C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v20\\installation", exists: () => true, realpath: (target) => target })).toEqual(["C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v20\\installation"]);
  });
});

describe("nodeToolchainWritePaths（显式非本机 node 环境的工具链读写挂载）", () => {
  const exists = (...paths: string[]) => (target: string) => paths.includes(target);

  it("nvm：nvm.sh 存在才挂载 $NVM_DIR", () => {
    expect(nodeToolchainWritePaths("nvm", { platform: "linux", nvmDir: "/home/u/.nvm", exists: exists("/home/u/.nvm/nvm.sh") })).toEqual(["/home/u/.nvm"]);
    expect(nodeToolchainWritePaths("nvm", { platform: "linux", nvmDir: "/home/u/.nvm", exists: () => false })).toEqual([]);
  });

  it("fnm：$FNM_DIR 与内置候选按存在性过滤并去重", () => {
    const deps = { platform: "linux" as const, home: "/home/u", fnmDir: "/opt/fnm", exists: exists("/opt/fnm", "/home/u/.local/share/fnm") };
    expect(nodeToolchainWritePaths("fnm", deps)).toEqual(["/opt/fnm", "/home/u/.local/share/fnm"]);
    // fnmDir 与内置候选重复（~/.fnm）时只出现一次
    const dup = { platform: "linux" as const, home: "/home/u", fnmDir: "/home/u/.fnm", exists: exists("/home/u/.fnm") };
    expect(nodeToolchainWritePaths("fnm", dup)).toEqual(["/home/u/.fnm"]);
    // 全部不存在 → 空
    expect(nodeToolchainWritePaths("fnm", { platform: "linux", home: "/home/u", fnmDir: "/opt/fnm", exists: () => false })).toEqual([]);
  });

  it("global/project 不追加；win32 按存在性挂载 fnm/nvm", () => {
    expect(nodeToolchainWritePaths("global", { platform: "linux", exists: () => true })).toEqual([]);
    expect(nodeToolchainWritePaths("project", { platform: "linux", exists: () => true })).toEqual([]);
    // win32：nvm.exe 存在才挂载 NVM_HOME（缺省 %APPDATA%\nvm）；fnm 目录存在才挂载
    expect(nodeToolchainWritePaths("nvm", { platform: "win32", nvmDir: "C:\\nvm", exists: (target) => target === "C:\\nvm\\nvm.exe" })).toEqual(["C:\\nvm"]);
    expect(nodeToolchainWritePaths("nvm", { platform: "win32", nvmDir: "C:\\nvm", exists: () => false })).toEqual([]);
    expect(nodeToolchainWritePaths("fnm", { platform: "win32", home: "C:\\Users\\u", fnmDir: "C:\\fnm", exists: (target) => target === "C:\\fnm" })).toEqual(["C:\\fnm"]);
  });
});

describe("node-env helpers", () => {
  it("resolves the effective node env with session > global default > host", () => {
    expect(effectiveNodeEnv("fnm", "nvm")).toBe("fnm");
    expect(effectiveNodeEnv(undefined, "project")).toBe("project");
    expect(effectiveNodeEnv(undefined, undefined)).toBe("global");
  });

  it("locates the project bin dir only for project mode", () => {
    const cwd = path.join("repo");
    expect(nodeBinDir("global", cwd)).toBeUndefined();
    expect(nodeBinDir("fnm", cwd)).toBeUndefined();
    expect(nodeBinDir("nvm", cwd)).toBeUndefined();
    expect(nodeBinDir("project", cwd)).toBe(path.join(cwd, "node_modules", ".bin"));
  });

  it("global mode returns the command unchanged", () => {
    expect(wrapCommandWithNodeEnv("npm test", "global", "/repo", "sh", "linux")).toBe("npm test");
  });

  it("wraps project mode for cmd on Windows by prepending node_modules/.bin", () => {
    expect(wrapCommandWithNodeEnv("npm test", "project", "C:\\repo", "cmd", "win32"))
      .toBe('set "PATH=C:\\repo\\node_modules\\.bin;%PATH%" && npm test');
  });

  it("wraps project mode for Git Bash on Windows (forward slashes)", () => {
    expect(wrapCommandWithNodeEnv("npm test", "project", "C:\\repo", "sh", "win32"))
      .toBe("export PATH='C:/repo/node_modules/.bin':$PATH; npm test");
  });

  it("wraps project mode for pwsh on Windows", () => {
    expect(wrapCommandWithNodeEnv("npm test", "project", "C:\\repo", "pwsh", "win32"))
      .toBe("$env:Path = 'C:\\repo\\node_modules\\.bin;' + $env:Path; npm test");
  });

  it("wraps project mode for POSIX shells", () => {
    expect(wrapCommandWithNodeEnv("npm test", "project", "/repo", "sh", "linux"))
      .toBe("export PATH='/repo/node_modules/.bin':$PATH; npm test");
  });

  it("wraps fnm mode for sh and pwsh; cmd is unsupported (null -> caller falls back to note)", () => {
    expect(wrapCommandWithNodeEnv("npm test", "fnm", "/repo", "sh", "linux"))
      .toBe('eval "$(fnm env --shell bash)"; fnm use >/dev/null 2>&1; npm test');
    expect(wrapCommandWithNodeEnv("npm test", "fnm", "C:\\repo", "sh", "win32"))
      .toBe('eval "$(fnm env --shell bash)"; fnm use >/dev/null 2>&1; npm test');
    expect(wrapCommandWithNodeEnv("npm test", "fnm", "C:\\repo", "pwsh", "win32"))
      .toBe("fnm env --shell powershell | Out-String | Invoke-Expression; fnm use 2>$null | Out-Null; npm test");
    expect(wrapCommandWithNodeEnv("npm test", "fnm", "C:\\repo", "cmd", "win32")).toBeNull();
  });

  it("wraps nvm mode only for POSIX bash/sh; pwsh/cmd/win32 are unsupported", () => {
    expect(wrapCommandWithNodeEnv("npm test", "nvm", "/repo", "sh", "linux"))
      .toBe('export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use >/dev/null 2>&1; npm test');
    expect(wrapCommandWithNodeEnv("npm test", "nvm", "/repo", "pwsh", "linux")).toBeNull();
    expect(wrapCommandWithNodeEnv("npm test", "nvm", "C:\\repo", "sh", "win32")).toBeNull();
    expect(wrapCommandWithNodeEnv("npm test", "nvm", "C:\\repo", "cmd", "win32")).toBeNull();
  });

  it("nodeEnvActivationCommand mirrors the one-shot wrap (persistent shell activation)", () => {
    expect(nodeEnvActivationCommand("cmd", "project", "C:\\repo", "win32")).toBe('set "PATH=C:\\repo\\node_modules\\.bin;%PATH%"');
    expect(nodeEnvActivationCommand("sh", "project", "/repo", "linux")).toBe("export PATH='/repo/node_modules/.bin':$PATH");
    expect(nodeEnvActivationCommand("sh", "project", "C:\\repo", "win32")).toBe("export PATH='C:/repo/node_modules/.bin':$PATH");
    expect(nodeEnvActivationCommand("pwsh", "project", "C:\\repo", "win32")).toBe("$env:Path = 'C:\\repo\\node_modules\\.bin;' + $env:Path");
    expect(nodeEnvActivationCommand("sh", "fnm", "/repo", "linux")).toBe('eval "$(fnm env --shell bash)"; fnm use >/dev/null 2>&1');
    expect(nodeEnvActivationCommand("cmd", "fnm", "C:\\repo", "win32")).toBeNull();
    expect(nodeEnvActivationCommand("sh", "nvm", "/repo", "linux")).toContain('export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"');
    expect(nodeEnvActivationCommand("pwsh", "nvm", "/repo", "linux")).toBeNull();
    expect(nodeEnvActivationCommand("sh", "global", "/repo", "linux")).toBeNull();
  });

  it("merges a second fallback note into the same echo instead of chaining two echoes", () => {
    const once = wrapCommandWithNote("npm test", "fnm is not available on PATH, using the host node environment");
    expect(once).toBe("echo [openwebcode] fnm is not available on PATH, using the host node environment && npm test");
    const twice = wrapCommandWithNote(once, "uv is not available on PATH, using the host python environment");
    expect(twice).toBe("echo [openwebcode] uv is not available on PATH, using the host python environment; fnm is not available on PATH, using the host node environment && npm test");
  });
});

describe("NodeEnvManagers", () => {
  it("global/project 无需检测直接通过", async () => {
    const managers = new NodeEnvManagers();
    expect(await managers.ensure("global", "sh")).toEqual({ ok: true });
    expect(await managers.ensure("project", "cmd")).toEqual({ ok: true });
  });

  it("fnm: cmd 不支持直接回退 note，不做可用性检测", async () => {
    let calls = 0;
    const managers = new NodeEnvManagers(async () => {
      calls += 1;
      return { code: 0, stderr: "" };
    });
    const result = await managers.ensure("fnm", "cmd");
    expect(result.ok).toBe(false);
    expect(result.note).toContain("not supported for cmd");
    expect(calls).toBe(0);
  });

  it("fnm: fnm --version 成功缓存，失败返回 note 且下次重试", async () => {
    let calls = 0;
    const managers = new NodeEnvManagers(async () => {
      calls += 1;
      return { code: 0, stderr: "" };
    });
    expect(await managers.ensure("fnm", "sh")).toEqual({ ok: true });
    expect(await managers.ensure("fnm", "pwsh")).toEqual({ ok: true });
    expect(calls).toBe(1);

    let failCalls = 0;
    const failing = new NodeEnvManagers(async () => {
      failCalls += 1;
      return { code: null, stderr: "spawn failed" };
    });
    const missed = await failing.ensure("fnm", "sh");
    expect(missed.ok).toBe(false);
    expect(missed.note).toBe("fnm is not available on PATH, using the host node environment");
    // 失败不缓存：下次重新检测
    await failing.ensure("fnm", "sh");
    expect(failCalls).toBe(2);
  });

  it("nvm: 仅 POSIX sh 支持；nvm.sh 缺失时回退 note", async () => {
    const missing = new NodeEnvManagers(undefined, path.join(os.tmpdir(), "owc-test-no-such-nvm", "nvm.sh"));
    expect(await missing.ensure("nvm", "pwsh", "linux")).toMatchObject({ ok: false });
    expect(await missing.ensure("nvm", "sh", "win32")).toMatchObject({ ok: false });
    const notInstalled = await missing.ensure("nvm", "sh", "linux");
    expect(notInstalled.ok).toBe(false);
    expect(notInstalled.note).toContain("nvm is not installed");

    const dir = await tempRoot("owc-nvm-");
    const script = path.join(dir, "nvm.sh");
    writeFileSync(script, "# nvm shim\n");
    const installed = new NodeEnvManagers(undefined, script);
    expect(await installed.ensure("nvm", "sh", "linux")).toEqual({ ok: true });
  });
});
