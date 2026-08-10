import { describe, expect, it } from "vitest";
import { decodeChildProcessOutput, decodeProcessOutputChunks } from "../src/agent/output-decoder.js";
import { detectHostShells, resolveShellFrom, type HostShellProbe, type ResolvedShell } from "../src/agent/shell-detect.js";
import { bashTool } from "../src/agent/tool-schemas.js";

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

describe("child-process output decoding", () => {
  it("keeps valid UTF-8 intact before considering a Windows fallback", () => {
    expect(decodeChildProcessOutput(Buffer.from("中文 UTF-8", "utf8"), "win32")).toBe("中文 UTF-8");
  });

  it("decodes Chinese Windows CP936/GBK output without replacement characters", () => {
    // "中文" encoded by the default simplified-Chinese Windows code page.
    const cp936 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeChildProcessOutput(cp936, "win32")).toBe("中文");
  });

  it("joins adjacent pipe reads before GBK decoding, while retaining stdout/stderr order", () => {
    const decoded = decodeProcessOutputChunks([
      { stream: "stdout", data: Buffer.from([0xd6, 0xd0]).toString("base64"), seq: 2 },
      { stream: "stdout", data: Buffer.from([0xce, 0xc4]).toString("base64"), seq: 3 },
      { stream: "stderr", data: Buffer.from("失败", "utf8").toString("base64"), seq: 4 },
      { stream: "stdout", data: Buffer.from("\n", "utf8").toString("base64"), seq: 5 },
    ], "win32");

    expect(decoded).toEqual([
      { stream: "stdout", data: "中文" },
      { stream: "stderr", data: "失败" },
      { stream: "stdout", data: "\n" },
    ]);
  });

  it("does not reinterpret malformed output as GBK off Windows", () => {
    expect(decodeChildProcessOutput(Buffer.from([0xd6, 0xd0]), "linux")).toContain("\uFFFD");
  });
});

/** bash 工具描述：按实际平台 + 实际 shell 声明终端类型（修复 Linux default 误写 Windows/cmd 文案的 bug）。 */

function shell(kind: ResolvedShell["kind"], executable = kind): ResolvedShell {
  return {
    kind,
    flavor: kind === "pwsh" ? "pwsh" : kind === "cmd" ? "cmd" : "sh",
    executable,
    coreBackend: kind === "pwsh" ? "pwsh" : kind === "git-bash" || kind === "bash" ? "bash" : "default",
  };
}

describe("bashTool 描述按平台与 shell 生成", () => {
  it("Windows + Git Bash：声明 MSYS/Unix find/正斜杠路径，不再警告 findstr", () => {
    const description = bashTool(false, shell("git-bash"), "global", "win32").description;
    expect(description).toContain("Git Bash (MSYS) on Windows");
    expect(description).toContain("find is Unix find");
    expect(description).toContain("forward slashes");
    expect(description).not.toContain("findstr");
    expect(description).not.toContain("cmd.exe");
  });

  it("Windows + cmd：cmd 语法 + findstr/MSYS 警告", () => {
    const description = bashTool(false, shell("cmd", "cmd.exe"), "global", "win32").description;
    expect(description).toContain("cmd.exe");
    expect(description).toContain("findstr");
  });

  it("Windows + pwsh / Linux + pwsh：PowerShell 语法并声明所在 OS", () => {
    expect(bashTool(false, shell("pwsh"), "global", "win32").description).toContain("PowerShell 7 (pwsh) on Windows");
    expect(bashTool(false, shell("pwsh"), "global", "linux").description).toContain("PowerShell 7 (pwsh) on Linux");
  });

  it("Linux + bash：POSIX 声明，不得出现 Windows/cmd 文案（原 default 分支 bug）", () => {
    const description = bashTool(false, shell("bash", "/usr/bin/bash"), "global", "linux").description;
    expect(description).toContain("bash on Linux");
    expect(description).not.toContain("Windows");
    expect(description).not.toContain("cmd");
    expect(description).not.toContain("findstr");
  });

  it("Linux + $SHELL/sh 兜底：声明具体解释器路径", () => {
    const description = bashTool(false, shell("sh", "/bin/zsh"), "global", "linux").description;
    expect(description).toContain("/bin/zsh on Linux");
    expect(description).toContain("POSIX sh syntax");
  });
});
