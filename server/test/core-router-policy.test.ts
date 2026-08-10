import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CoreRouter, gitCredentialReadOnlyPaths } from "../src/sandbox/core-router.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

const policy: SandboxPolicy = {
  enabled: true,
  readRoots: ["/work"],
  writeRoots: ["/work"],
  denyPaths: [],
  network: "allow",
};

function meta(sandboxMode: SessionMeta["sandboxMode"]): SessionMeta | undefined {
  if (!sandboxMode) return undefined;
  return {
    id: "00000000-0000-0000-0000-000000000000",
    cwd: "/work",
    provider: "",
    model: "",
    sandbox: policy,
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sandboxMode,
  };
}

describe("CoreRouter.policyFor 平台分支", () => {
  it("未显式选择时 Windows 缺省下发 jobobject", () => {
    expect(CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, "win32").mode).toBe("jobobject");
  });

  it("未显式选择时 POSIX 不下发 mode（core 无 jobobject 语义）", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const routed = CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, platform);
      expect(routed.mode).toBeUndefined();
      expect(routed.enabled).toBe(true);
    }
  });

  it("显式选择（含持久化的 jobobject）不受平台分支影响", () => {
    expect(CoreRouter.policyFor(meta("jobobject"), policy, undefined, undefined, "linux").mode).toBe("jobobject");
    expect(CoreRouter.policyFor(meta("appcontainer"), policy, undefined, undefined, "linux").mode).toBe("appcontainer");
  });

  it("wsb/off 决策与平台无关", () => {
    const wsb = CoreRouter.policyFor(meta("wsb"), { ...policy, bindLinks: [{ virtPath: "C:\\x", backingPath: "D:\\b" }] }, undefined, undefined, "linux");
    expect(wsb.enabled).toBe(false);
    expect(wsb.bindLinks).toBeUndefined();
    expect(CoreRouter.policyFor(meta("off"), policy, undefined, undefined, "linux").enabled).toBe(false);
  });

  it("POSIX 显式 landlock 不下发 mode（与缺省同语义）", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const routed = CoreRouter.policyFor(meta("landlock"), policy, undefined, undefined, platform);
      expect(routed.mode).toBeUndefined();
      expect(routed.enabled).toBe(true);
    }
  });

  it("POSIX 显式 bubblewrap 下发 mode: bubblewrap", () => {
    const routed = CoreRouter.policyFor(meta("bubblewrap"), policy, undefined, undefined, "linux");
    expect(routed.mode).toBe("bubblewrap");
    expect(routed.enabled).toBe(true);
  });
});

describe("gitCredentialReadOnlyPaths（沙盒内 git/gh 凭据只读放行）", () => {
  it("POSIX：并入 $HOME 下存在的凭据路径并去重，不存在的跳过", async () => {
    const home = await tempRoot("owc-gh-cred-");
    await writeFile(path.join(home, ".gitconfig"), "[user]\n");
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    const existing = ["/work/ro", path.join(home, ".gitconfig")];
    const merged = gitCredentialReadOnlyPaths(existing, "linux", home);
    expect(merged).toEqual(["/work/ro", path.join(home, ".gitconfig"), path.join(home, ".ssh")]);
  });

  it("win32 不追加（Job Object 无文件系统隔离，凭据本就可读）", async () => {
    const home = await tempRoot("owc-gh-cred-");
    await writeFile(path.join(home, ".gitconfig"), "[user]\n");
    expect(gitCredentialReadOnlyPaths(undefined, "win32", home)).toEqual([]);
  });

  it("policyFor 的 POSIX 分支经 homedir 并入凭据；wsb/off 不追加", async () => {
    const home = await tempRoot("owc-gh-cred-");
    await writeFile(path.join(home, ".git-credentials"), "https://x@github.com\n");
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    try {
      const routed = CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, "linux");
      expect(routed.readOnlyPaths).toEqual([path.join(home, ".git-credentials")]);
      expect(CoreRouter.policyFor(meta("wsb"), policy, undefined, undefined, "linux").readOnlyPaths).toBeUndefined();
      expect(CoreRouter.policyFor(meta("off"), policy, undefined, undefined, "linux").readOnlyPaths).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
