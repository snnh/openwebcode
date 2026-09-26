import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreClientLike } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { ScmService } from "../src/scm/service.js";
import type { GitExec } from "../src/scm/types.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * SCM 读路径缓存：同一会话短时间内的重复/并发取数只跑一次 git，写事件（scm.updated）
 * 立即失效缓存；带取消信号的调用不与 REST 侧共享缓存与在途。
 */

const STATUS_OK = { stdout: "## main...origin/main [ahead 1]\u0000 M a.ts\u0000?? b.ts\u0000", stderr: "", exitCode: 0 };

function makeExec(outcomes: Array<{ stdout?: string; stderr?: string; exitCode?: number }> = []) {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push(args);
    const next = outcomes.shift();
    if (next) return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", exitCode: next.exitCode ?? 0 };
    if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

async function fixture(outcomes: Array<{ stdout?: string; stderr?: string; exitCode?: number }> = []) {
  const root = await tempRoot("owc-scm-cache-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const events = new EventBus();
  const { exec, calls } = makeExec(outcomes);
  const scm = new ScmService({} as CoreClientLike, sessions, events, { worktreeRoot: path.join(root, "worktrees"), exec });
  return { scm, events, calls };
}

describe("ScmService 读缓存", () => {
  it("TTL 内重复 status 只跑一次 git，且不再有 rev-parse 探针", async () => {
    const { scm, calls } = await fixture();
    await scm.status("s1", "/repo");
    await scm.status("s1", "/repo");
    expect(calls).toEqual([["status", "--porcelain=v1", "--branch", "-z"]]);
  });

  it("并发 status 合并为一次 git 调用", async () => {
    const { scm, calls } = await fixture();
    await Promise.all([scm.status("s1", "/repo"), scm.status("s1", "/repo"), scm.status("s1", "/repo")]);
    expect(calls).toHaveLength(1);
  });

  it("scm.updated 事件立即失效该会话缓存（仅该会话）", async () => {
    const { scm, events, calls } = await fixture();
    await scm.status("s1", "/repo");
    await scm.status("s2", "/repo");
    expect(calls).toHaveLength(2);
    // s1 写事件：s1 重取，s2 仍命中缓存
    events.publish({ source: "agent", type: "scm.updated", sessionId: "s1", payload: { reason: "file.write" } });
    await scm.status("s1", "/repo");
    await scm.status("s2", "/repo");
    expect(calls).toHaveLength(3);
    // 无 sessionId 的事件不影响其它会话
    events.publish({ source: "server", type: "server.started", payload: {} });
    await scm.status("s2", "/repo");
    expect(calls).toHaveLength(3);
  });

  it("非仓库：git status 的 stderr 判定 isRepo=false（不再预先探测）", async () => {
    const { scm, calls } = await fixture([
      { stderr: "fatal: not a git repository (or any of the parent directories): .git", exitCode: 128 },
    ]);
    const status = await scm.status("s1", "/not-repo");
    expect(status.isRepo).toBe(false);
    expect(calls).toEqual([["status", "--porcelain=v1", "--branch", "-z"]]);
  });

  it("diff 按 file 分别缓存，重复取同一文件只跑一次 stat+diff", async () => {
    const { scm, calls } = await fixture();
    await scm.diff("s1", "/repo", { file: "a.ts" });
    await scm.diff("s1", "/repo", { file: "a.ts" });
    expect(calls).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["diff", "--stat", "--", "a.ts"],
      ["diff", "--", "a.ts"],
    ]);
    await scm.diff("s1", "/repo", { file: "b.ts" });
    expect(calls.filter((args) => args[0] === "diff")).toHaveLength(4);
    // 仓库探针同样命中缓存（总探针次数仍为 1）
    expect(calls.filter((args) => args[0] === "rev-parse")).toHaveLength(1);
  });

  it("带取消信号的调用不共享缓存：不写入也不命中", async () => {
    const { scm, calls } = await fixture();
    const controller = new AbortController();
    await scm.status("s1", "/repo", { signal: controller.signal });
    await scm.status("s1", "/repo", { signal: controller.signal });
    expect(calls).toHaveLength(2);
    // 信号路径不写缓存，随后的 REST 调用仍要真实取数
    await scm.status("s1", "/repo");
    expect(calls).toHaveLength(3);
    await scm.status("s1", "/repo");
    expect(calls).toHaveLength(3);
  });

  it("invalidateReadCache 清空缓存（不带 sessionId 时清全部）", async () => {
    const { scm, calls } = await fixture();
    await scm.status("s1", "/repo");
    await scm.status("s2", "/repo");
    expect(calls).toHaveLength(2);
    scm.invalidateReadCache();
    await scm.status("s1", "/repo");
    await scm.status("s2", "/repo");
    expect(calls).toHaveLength(4);
  });

  it("status 成功结果仍解析 porcelain 分支信息", async () => {
    const { scm } = await fixture([STATUS_OK]);
    const status = await scm.status("s1", "/repo");
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.ahead).toBe(1);
    expect(status.unstaged.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(status.untracked.map((entry) => entry.path)).toEqual(["b.ts"]);
  });
});
