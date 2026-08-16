import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("win32 不追加（无文件系统隔离）", () => {
    expect(pythonEnvWritePaths("uv-config", "C:\\work", "D:\\data", "win32")).toEqual([]);
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
