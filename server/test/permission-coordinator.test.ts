import { describe, expect, it } from "vitest";
import { PermissionCoordinator, permissionRule } from "../src/agent/permission-coordinator.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";

describe("PermissionCoordinator", () => {
  it("bypasses only allowed read, edit, yolo, and persisted rules", () => {
    const coordinator = new PermissionCoordinator(new EventBus());
    expect(coordinator.needsApproval("ask", [], "read_file", { path: "a" })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "todo_write", { items: [] })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "bash", { cmd: "npm test" })).toBe(true);
    expect(coordinator.needsApproval("acceptEdits", [], "edit_file", { path: "a" })).toBe(false);
    expect(coordinator.needsApproval("yolo", [], "bash", { cmd: "rm x" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test -- --run" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test && curl bad" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm testx" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test -- --watch" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test | grep ok" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test > out.txt" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test" })).toBe(false);
  });

  it("scopes persistent web fetch permission to the exact origin", () => {
    const coordinator = new PermissionCoordinator(new EventBus());
    const rule = permissionRule("web_fetch", { url: "https://example.com/docs/a" });
    expect(rule).toEqual({ tool: "web_fetch", argumentPrefix: "https://example.com" });
    expect(coordinator.needsApproval("ask", [rule], "web_fetch", { url: "https://example.com/other" })).toBe(false);
    expect(coordinator.needsApproval("ask", [rule], "web_fetch", { url: "https://example.com.evil/" })).toBe(true);
    expect(coordinator.needsApproval("ask", [rule], "web_fetch", { url: "http://example.com/" })).toBe(true);
    expect(coordinator.needsApproval("acceptEdits", [], "web_search", { query: "test" })).toBe(true);
    expect(coordinator.needsApproval("ask", [{ tool: "web_search" }], "web_search", { query: "other" })).toBe(false);
  });

  it("resolves allow_always and aborts pending requests", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const controller = new AbortController();
    const pending = coordinator.request("session", "bash", { cmd: "npm test" }, controller.signal);
    const requestId = (observed[0]?.payload as { requestId: string }).requestId;
    const response = coordinator.respond("session", requestId, "allow_always");
    expect(response).toMatchObject({ persist: true, tool: "bash" });
    response?.complete();
    expect(await pending).toEqual({ allowed: true, persist: true });

    const aborted = coordinator.request("session", "bash", { cmd: "npm test" }, controller.signal);
    controller.abort();
    expect(await aborted).toMatchObject({ allowed: false, persist: false });
  });

  it("does not grant a claimed one-time permission if the run aborts before completion", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const controller = new AbortController();
    const pending = coordinator.request("session", "bash", { cmd: "dir" }, controller.signal);
    const requestId = (observed[0]?.payload as { requestId: string }).requestId;
    const response = coordinator.respond("session", requestId, "allow");

    controller.abort();
    response?.complete();
    expect(await pending).toEqual({ allowed: false, reason: "Permission request aborted", persist: false });
  });
});
