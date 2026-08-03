import { describe, expect, it } from "vitest";
import { CoreRouter } from "../src/sandbox/core-router.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";

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
});
