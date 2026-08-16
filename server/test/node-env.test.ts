import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveNodeEnv, NodeEnvManagers, nodeBinDir, nodeEnvActivationCommand, nodeToolchainReadOnlyPaths, nodeToolchainWritePaths, wrapCommandWithNodeEnv } from "../src/node-env.js";
import { wrapCommandWithNote } from "../src/python-env.js";
import { tempRoot } from "./helpers/temp-roots.js";

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

  it("project 与 win32 不挂载", () => {
    expect(nodeToolchainReadOnlyPaths("project", { platform: "linux", exists: () => true })).toEqual([]);
    expect(nodeToolchainReadOnlyPaths("nvm", { platform: "win32", exists: () => true })).toEqual([]);
    expect(nodeToolchainReadOnlyPaths("global", { platform: "win32", pathEnv: "C:\\nvm", exists: () => true })).toEqual([]);
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

  it("global/project 不追加；win32 一律不追加", () => {
    expect(nodeToolchainWritePaths("global", { platform: "linux", exists: () => true })).toEqual([]);
    expect(nodeToolchainWritePaths("project", { platform: "linux", exists: () => true })).toEqual([]);
    expect(nodeToolchainWritePaths("nvm", { platform: "win32", nvmDir: "C:\\nvm", exists: () => true })).toEqual([]);
    expect(nodeToolchainWritePaths("fnm", { platform: "win32", home: "C:\\Users\\u", fnmDir: "C:\\fnm", exists: () => true })).toEqual([]);
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
