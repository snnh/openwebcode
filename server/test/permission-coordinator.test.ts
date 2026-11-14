import { describe, expect, it } from "vitest";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";

function coordinator() {
  const published: string[] = [];
  const events = { publish: (event: { type: string }) => { published.push(event.type); } };
  return { published, permissions: new PermissionCoordinator(events as never) };
}

describe("PermissionCoordinator 决策持久化标记", () => {
  it("allow 不持久化；allow_always 与 allow_always_global 持久化且放行", async () => {
    for (const [decision, persist] of [["allow", false], ["allow_always", true], ["allow_always_global", true]] as const) {
      const { permissions } = coordinator();
      const controller = new AbortController();
      const pending = permissions.request("s1", "bash", { cmd: "npm test" }, controller.signal);
      const requestId = permissions.listPending("s1")[0]!.requestId;
      const response = permissions.respond("s1", requestId, decision);
      expect(response).toBeDefined();
      expect(response!.persist).toBe(persist);
      response!.complete();
      await expect(pending).resolves.toMatchObject({ allowed: true, persist });
      expect(permissions.listPending("s1")).toEqual([]);
    }
  });

  it("deny 拒绝且不持久化", async () => {
    const { permissions } = coordinator();
    const controller = new AbortController();
    const pending = permissions.request("s1", "bash", { cmd: "rm -rf /" }, controller.signal);
    const requestId = permissions.listPending("s1")[0]!.requestId;
    const response = permissions.respond("s1", requestId, "deny", "no");
    response!.complete();
    await expect(pending).resolves.toMatchObject({ allowed: false, persist: false, reason: "no" });
  });
});
