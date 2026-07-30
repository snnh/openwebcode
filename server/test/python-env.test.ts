import path from "node:path";
import { describe, expect, it } from "vitest";
import { effectivePythonEnv, uvVenvDir, wrapCommandWithNote, wrapCommandWithVenv } from "../src/python-env.js";

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
    expect(wrapCommandWithVenv("pytest", "C:\\repo\\.owc\\venv", "default", "win32"))
      .toBe('set "PATH=C:\\repo\\.owc\\venv\\Scripts;%PATH%" && pytest');
  });

  it("wraps commands for pwsh on Windows", () => {
    expect(wrapCommandWithVenv("pytest", "C:\\repo\\.owc\\venv", "pwsh", "win32"))
      .toBe("$env:Path = 'C:\\repo\\.owc\\venv\\Scripts;' + $env:Path; pytest");
  });

  it("wraps commands for POSIX shells", () => {
    expect(wrapCommandWithVenv("pytest", "/repo/.owc/venv", "default", "linux"))
      .toBe("export PATH='/repo/.owc/venv/bin':$PATH; pytest");
  });

  it("prefixes the fallback note", () => {
    expect(wrapCommandWithNote("pytest", "uv is not available on PATH; using the host python environment"))
      .toBe("echo [openwebcode] uv is not available on PATH; using the host python environment && pytest");
  });
});
