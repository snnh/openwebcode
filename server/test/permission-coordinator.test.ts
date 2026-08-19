import { describe, expect, it } from "vitest";
import { PermissionCoordinator, permissionRule } from "../src/agent/permission-coordinator.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";

describe("PermissionCoordinator", () => {
  it("bypasses only allowed read, edit, yolo, and persisted rules", () => {
    const coordinator = new PermissionCoordinator(new EventBus());
    expect(coordinator.needsApproval("ask", [], "read_file", { path: "a" })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "todo_write", { items: [] })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "bash", { cmd: "npm test" })).toBe(true);
    expect(coordinator.needsApproval("ask", [], "bash", { cmd: "cd x && echo hi && ls" })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "bash", { cmd: "ls 2>/dev/null | head; find . -name '*.ts' | head" })).toBe(false);
    expect(coordinator.needsApproval("acceptEdits", [], "bash", { cmd: "head x && rm -rf /" })).toBe(true);
    expect(coordinator.needsApproval("review", [], "bash", { cmd: "git status" })).toBe(false);
    expect(coordinator.needsApproval("acceptEdits", [], "edit_file", { path: "a" })).toBe(false);
    expect(coordinator.needsApproval("yolo", [], "bash", { cmd: "rm x" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test -- --run" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test && curl bad" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm testx" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test -- --watch" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test | grep ok" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test > out.txt" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test" })).toBe(false);
    // 孤立 \r 是 cmd.exe 的行终止符：前缀规则不得放行隐藏的第二条命令
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test \rwhoami" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test\r\nwhoami" })).toBe(true);
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

  it("generates path-scoped rules for read_file/glob/grep (本机会话 HOME 外路径门)", () => {
    // 旧行为 read_file 落整工具放行（{ tool }）；现在按归一化路径落目录前缀规则
    // （read/write/edit 落 dirname，「总是允许 /etc/hosts」放行同目录 /etc/hostname）
    const readRule = permissionRule("read_file", { path: "/etc/hosts" });
    expect(readRule).toEqual({ tool: "read_file", argumentPrefix: "/etc" });
    const globRule = permissionRule("glob", { path: "/usr/share", pattern: "**/*.md" });
    expect(globRule).toEqual({ tool: "glob", argumentPrefix: "/usr/share" });
    const grepRule = permissionRule("grep", { path: "/var/log" });
    expect(grepRule).toEqual({ tool: "grep", argumentPrefix: "/var/log" });
    // 缺省/空 path（会话根）不落路径规则，回落整工具
    expect(permissionRule("read_file", {})).toEqual({ tool: "read_file" });
    expect(permissionRule("glob", { path: "" })).toEqual({ tool: "glob" });
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

  it("publishes permission.resolved on respond, abort and cancelSession", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const resolvedIds = (): string[] =>
      observed.filter((e) => e.type === "permission.resolved").map((e) => (e.payload as { requestId: string }).requestId);
    const lastRequestId = (): string =>
      (observed.filter((e) => e.type === "permission.request").pop()?.payload as { requestId: string }).requestId;

    // respond 路径：HTTP 响应完成、挂起单消失时广播
    const controller = new AbortController();
    const first = coordinator.request("session", "bash", { cmd: "a" }, controller.signal);
    const firstId = lastRequestId();
    coordinator.respond("session", firstId, "allow")?.complete();
    await first;
    expect(resolvedIds()).toContain(firstId);

    // abort 路径：中断挂起中的请求同样广播（其他客户端才能撤卡）
    const second = coordinator.request("session", "bash", { cmd: "b" }, controller.signal);
    const secondId = lastRequestId();
    controller.abort();
    await second;
    expect(resolvedIds()).toContain(secondId);

    // cancelSession 路径：会话停止清掉全部挂起并逐一广播
    const controller2 = new AbortController();
    const third = coordinator.request("session", "bash", { cmd: "c" }, controller2.signal);
    const thirdId = lastRequestId();
    coordinator.cancelSession("session");
    await third;
    expect(resolvedIds()).toContain(thirdId);
  });

  it("reconcile 按新权限档结算挂起单：新档免批的自动放行，其余继续挂起", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const controller = new AbortController();
    const resolvedIds = (): string[] =>
      observed.filter((e) => e.type === "permission.resolved").map((e) => (e.payload as { requestId: string }).requestId);

    const bashWrite = coordinator.request("s", "bash", { cmd: "rm x" }, controller.signal);
    const editFile = coordinator.request("s", "edit_file", { path: "a.ts" }, controller.signal);
    const commit = coordinator.request("s", "git_commit", { message: "m" }, controller.signal);
    const gated = coordinator.request("s", "read_file", { path: "/etc/hosts" }, controller.signal, { alwaysManual: true });

    // acceptEdits：edit_file 自动放行并广播 resolved；bash 写命令与 git_commit 仍挂起
    coordinator.reconcile("s", "acceptEdits", []);
    expect(await editFile).toEqual({ allowed: true, persist: false });
    expect(coordinator.listPending("s").map((p) => p.tool).sort()).toEqual(["bash", "git_commit", "read_file"]);

    // yolo：bash 写命令放行；git_commit 无 allow_always 规则仍须人工；alwaysManual
    // （本机会话 HOME 外路径门）与权限档无关，yolo 也不自动放行
    coordinator.reconcile("s", "yolo", []);
    expect(await bashWrite).toEqual({ allowed: true, persist: false });
    expect(coordinator.listPending("s").map((p) => p.tool).sort()).toEqual(["git_commit", "read_file"]);
    expect(resolvedIds()).toHaveLength(2);

    // 其余会话的挂起单不受结算影响
    const other = coordinator.request("other", "write_file", { path: "b.ts" }, controller.signal);
    coordinator.reconcile("s", "yolo", []);
    expect(coordinator.listPending("other")).toHaveLength(1);
    coordinator.cancelSession("other");
    await other;
    coordinator.cancelSession("s");
    await commit;
    await gated;
  });
});
