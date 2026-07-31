import { describe, expect, it } from "vitest";
import { detectHostShells, resolveShellFrom, type HostShellProbe } from "../src/agent/shell-detect.js";

/**
 * shell 探测与解析（纯单测，注入 env/exists/probe，不触真实文件系统）：
 * Windows default 顺序 pwsh > Git Bash > cmd（cmd 仅兜底），Git Bash 排除 WSL；
 * Linux default 顺序 bash > pwsh > $SHELL（/bin/sh 兜底）。
 */

type ExistsFn = (path: string) => boolean;
const none: ExistsFn = () => false;
const only = (...paths: string[]): ExistsFn => {
  const set = new Set(paths.map((p) => p.replace(/\//g, "\\").toLowerCase()));
  return (p) => set.has(p.replace(/\//g, "\\").toLowerCase());
};

describe("detectHostShells（Windows）", () => {
  it("PATH 查找 pwsh.exe", () => {
    const probe = detectHostShells("win32", { PATH: "C:\\tools;C:\\other" }, only("C:\\tools\\pwsh.exe"));
    expect(probe.pwsh).toBe("C:\\tools\\pwsh.exe");
    expect(probe.gitBash).toBeUndefined();
  });

  it("PATH 中的 bash.exe：排除 System32 的 WSL 启动器，继续向后找", () => {
    const env = { PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\bin", SystemRoot: "C:\\Windows" };
    const probe = detectHostShells("win32", env, only("C:\\Windows\\System32\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"));
    expect(probe.gitBash).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("PATH 只有 WSL bash 时回退常见安装路径（Program Files / LOCALAPPDATA）", () => {
    const env = { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" };
    expect(detectHostShells("win32", env, only("C:\\Windows\\System32\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe")).gitBash)
      .toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(detectHostShells("win32", env, only("C:\\Windows\\System32\\bash.exe", "C:\\Users\\x\\AppData\\Local\\Programs\\Git\\bin\\bash.exe")).gitBash)
      .toBe("C:\\Users\\x\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
    expect(detectHostShells("win32", env, only("C:\\Windows\\System32\\bash.exe")).gitBash).toBeUndefined();
  });

  it("PATH 变量名大小写不定（Path）也能解析", () => {
    const probe = detectHostShells("win32", { Path: "C:\\tools" }, only("C:\\tools\\pwsh.exe"));
    expect(probe.pwsh).toBe("C:\\tools\\pwsh.exe");
  });
});

describe("detectHostShells（POSIX）", () => {
  it("bash 先查 PATH 再查 /bin/bash", () => {
    expect(detectHostShells("linux", { PATH: "/usr/bin" }, only("/usr/bin/bash")).posixBash).toBe("/usr/bin/bash");
    expect(detectHostShells("linux", { PATH: "/nope" }, only("/bin/bash")).posixBash).toBe("/bin/bash");
    expect(detectHostShells("linux", { PATH: "" }, none).posixBash).toBeUndefined();
  });
});

describe("resolveShellFrom（Windows）", () => {
  const both: HostShellProbe = { pwsh: "C:\\tools\\pwsh.exe", gitBash: "C:\\Program Files\\Git\\bin\\bash.exe" };

  it("default：pwsh > Git Bash > cmd", () => {
    expect(resolveShellFrom("default", both, "win32", {}).kind).toBe("pwsh");
    expect(resolveShellFrom("default", { gitBash: both.gitBash! }, "win32", {})).toMatchObject({
      kind: "git-bash", flavor: "sh", coreBackend: "bash", executable: both.gitBash, shellPath: both.gitBash,
    });
    expect(resolveShellFrom("default", {}, "win32", {})).toMatchObject({ kind: "cmd", flavor: "cmd", coreBackend: "default" });
  });

  it("显式 bash：Git Bash 绝对路径随 shellPath 下发；未安装时裸名回落（core 报 shell_unavailable）", () => {
    expect(resolveShellFrom("bash", both, "win32", {})).toMatchObject({ kind: "git-bash", shellPath: both.gitBash });
    const missing = resolveShellFrom("bash", {}, "win32", {});
    expect(missing).toMatchObject({ kind: "git-bash", executable: "bash" });
    expect(missing.shellPath).toBeUndefined();
  });

  it("显式 cmd/pwsh", () => {
    expect(resolveShellFrom("cmd", both, "win32", {})).toMatchObject({ kind: "cmd", executable: "cmd.exe", coreBackend: "default" });
    expect(resolveShellFrom("pwsh", {}, "win32", {})).toMatchObject({ kind: "pwsh", executable: "pwsh", coreBackend: "pwsh" });
  });
});

describe("resolveShellFrom（POSIX）", () => {
  const both: HostShellProbe = { posixBash: "/usr/bin/bash", pwsh: "/usr/bin/pwsh" };

  it("default：bash > pwsh > $SHELL（/bin/sh 兜底）", () => {
    expect(resolveShellFrom("default", both, "linux", {})).toMatchObject({ kind: "bash", flavor: "sh", coreBackend: "bash", executable: "/usr/bin/bash" });
    expect(resolveShellFrom("default", { pwsh: both.pwsh! }, "linux", {})).toMatchObject({ kind: "pwsh", coreBackend: "pwsh" });
    expect(resolveShellFrom("default", {}, "linux", { SHELL: "/bin/zsh" })).toMatchObject({ kind: "sh", executable: "/bin/zsh", coreBackend: "default" });
    expect(resolveShellFrom("default", {}, "linux", {})).toMatchObject({ kind: "sh", executable: "/bin/sh" });
  });

  it("显式 bash/pwsh/cmd（cmd 在 POSIX 上按平台兜底 sh 处理）", () => {
    expect(resolveShellFrom("bash", both, "linux", {})).toMatchObject({ kind: "bash", coreBackend: "bash" });
    expect(resolveShellFrom("pwsh", both, "linux", {})).toMatchObject({ kind: "pwsh", coreBackend: "pwsh" });
    expect(resolveShellFrom("cmd", both, "linux", { SHELL: "/bin/zsh" })).toMatchObject({ kind: "sh", executable: "/bin/zsh", coreBackend: "default" });
  });
});
