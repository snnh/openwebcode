import { describe, expect, it } from "vitest";
import type { CoreClientLike, CoreInfo } from "../src/core-client.js";
import { validateSandboxRuntime } from "../src/sandbox/preflight.js";

function coreWith(features?: CoreInfo["features"]): Pick<CoreClientLike, "ping"> {
  return { ping: async () => ({ ...FAKE, ...(features ? { features } : {}) }) } as Pick<CoreClientLike, "ping">;
}

const FAKE: CoreInfo = {
  version: "test",
  platform: "linux",
  sandboxCapability: "advisory",
  features: {
    fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true,
    fsScanPagination: true, fsWatch: true,
  },
};

describe("validateSandboxRuntime 预检", () => {
  it("bubblewrap：明确不可用才拒绝；缺省（旧 core）放行", async () => {
    await expect(validateSandboxRuntime("bubblewrap", coreWith())).resolves.toBeUndefined();
    await expect(validateSandboxRuntime("bubblewrap", coreWith({ ...FAKE.features!, bwrap: { available: true } }))).resolves.toBeUndefined();
    await expect(validateSandboxRuntime("bubblewrap", coreWith({ ...FAKE.features!, bwrap: { available: false, reason: "not installed" } })))
      .resolves.toContain("not installed");
  });

  it("landlock：明确不可用才拒绝；缺省（旧 core）放行", async () => {
    await expect(validateSandboxRuntime("landlock", coreWith())).resolves.toBeUndefined();
    await expect(validateSandboxRuntime("landlock", coreWith({ ...FAKE.features!, landlock: { available: true } }))).resolves.toBeUndefined();
    await expect(validateSandboxRuntime("landlock", coreWith({ ...FAKE.features!, landlock: { available: false, reason: "kernel too old" } })))
      .resolves.toContain("kernel too old");
  });

  it("off/appcontainer/jobobject 不探测；ping 失败时拒绝需要探测的后端", async () => {
    const noPing = { ping: async () => { throw new Error("core down"); } } as unknown as Pick<CoreClientLike, "ping">;
    for (const mode of ["off", "appcontainer", "jobobject"] as const) {
      await expect(validateSandboxRuntime(mode, noPing)).resolves.toBeUndefined();
    }
    await expect(validateSandboxRuntime("bubblewrap", noPing)).resolves.toContain("无法连接执行器");
  });
});
