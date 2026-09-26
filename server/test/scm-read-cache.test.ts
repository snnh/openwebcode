import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreClientLike } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { ScmService } from "../src/scm/service.js";
import type { GitExec } from "../src/scm/types.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** SCM 读缓存：同会话短时间内的重复/并发取数合一次 git，scm.updated 写事件立即失效缓存。 */
type Outcome = { stdout?: string; stderr?: string; exitCode?: number };
const STATUS_OK: Outcome = { stdout: "## main...origin/main [ahead 1]\u0000 M a.ts\u0000?? b.ts\u0000", stderr: "", exitCode: 0 };
const STATUS_ARGS = ["status", "--porcelain=v1", "--branch", "-z"];
function makeExec(outcomes: Outcome[] = []) {
  const calls: string[][] = [];
  const exec: GitExec = async (args) => {
    calls.push(args);
    const next = outcomes.shift();
    if (next) return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", exitCode: next.exitCode ?? 0 };
    return args[0] === "rev-parse" ? { stdout: "true\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}
async function fixture(outcomes: Outcome[] = []) {
  const root = await tempRoot("owc-scm-cache-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const events = new EventBus();
  const { exec, calls } = makeExec(outcomes);
  const scm = new ScmService({} as CoreClientLike, sessions, events, { worktreeRoot: path.join(root, "worktrees"), exec });
  return { scm, events, calls };
}

describe("ScmService 读缓存", () => {
  it("TTL 内重复与并发 status 合并为一次 git，且不再有 rev-parse 探针", async () => {
    const { scm, calls } = await fixture();
    await scm.status("s1", "/repo");
    await Promise.all([scm.status("s1", "/repo"), scm.status("s1", "/repo")]);
    expect(calls).toEqual([STATUS_ARGS]);
  });
  it("scm.updated 只失效该会话缓存，invalidateReadCache 清空全部", async () => {
    const { scm, events, calls } = await fixture();
    await scm.status("s1", "/repo");
    await scm.status("s2", "/repo");
    expect(calls).toHaveLength(2); // 两会话各取一次
    events.publish({ source: "agent", type: "scm.updated", sessionId: "s1", payload: { reason: "file.write" } });
    await scm.status("s1", "/repo"); // s1 重取
    await scm.status("s2", "/repo"); // s2 仍命中
    expect(calls).toHaveLength(3);
    events.publish({ source: "server", type: "server.started", payload: {} });
    await scm.status("s2", "/repo"); // 无 sessionId 的事件不动缓存
    expect(calls).toHaveLength(3);
    scm.invalidateReadCache();
    await scm.status("s1", "/repo");
    await scm.status("s2", "/repo");
    expect(calls).toHaveLength(5);
  });
  it("status 解析 porcelain 分支信息；非仓库按 stderr 判定 isRepo=false（不预先探测）", async () => {
    const ok = await fixture([STATUS_OK]);
    const status = await ok.scm.status("s1", "/repo");
    expect(status).toMatchObject({ isRepo: true, branch: "main", ahead: 1 });
    expect(status.unstaged.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(status.untracked.map((entry) => entry.path)).toEqual(["b.ts"]);
    // 非仓库：git status 的 stderr 判定 isRepo=false（不再预先探针）
    const bad = await fixture([{ stderr: "fatal: not a git repository (or any of the parent directories): .git", exitCode: 128 }]);
    expect((await bad.scm.status("s1", "/not-repo")).isRepo).toBe(false);
    expect(bad.calls).toEqual([STATUS_ARGS]);
  });
  it("diff 按 file 分别缓存，仓库探针同样命中缓存", async () => {
    const { scm, calls } = await fixture();
    await scm.diff("s1", "/repo", { file: "a.ts" });
    await scm.diff("s1", "/repo", { file: "a.ts" });
    expect(calls).toEqual([["rev-parse", "--is-inside-work-tree"], ["diff", "--stat", "--", "a.ts"], ["diff", "--", "a.ts"]]);
    await scm.diff("s1", "/repo", { file: "b.ts" });
    expect(calls.filter((args) => args[0] === "diff")).toHaveLength(4);
    expect(calls.filter((args) => args[0] === "rev-parse")).toHaveLength(1);
  });
  it("带取消信号的调用不共享缓存：不写入也不命中", async () => {
    const { scm, calls } = await fixture();
    const { signal } = new AbortController();
    await scm.status("s1", "/repo", { signal });
    await scm.status("s1", "/repo", { signal });
    expect(calls).toHaveLength(2);
    await scm.status("s1", "/repo"); // 信号路径不写缓存，REST 调用仍真实取数
    expect(calls).toHaveLength(3);
    await scm.status("s1", "/repo");
    expect(calls).toHaveLength(3);
  });
});
