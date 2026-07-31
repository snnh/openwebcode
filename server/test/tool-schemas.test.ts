import { describe, expect, it } from "vitest";
import { bashTool } from "../src/agent/tool-schemas.js";
import type { ResolvedShell } from "../src/agent/shell-detect.js";

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
