import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import type { CoreClientLike } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import {
  MAX_STATUS_ENTRIES_PER_GROUP,
  MAX_WORKTREES,
  MAX_INLINE_DIFF_BYTES,
  NotARepoError,
  ScmService,
  parseStatusPorcelain,
} from "../src/scm/service.js";
import { SessionStore } from "../src/sessions/session-store.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 真实 git 执行器（注入 ScmService.exec；生产默认走 Core job）。 */
async function realGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
  }
}

/** 假 core：仅用于未注入 exec 时的构造路径，这里所有用例都注入真实 git。 */
function unusedCore(): CoreClientLike {
  const core = { on() { return core; } } as unknown as CoreClientLike;
  return core;
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-scm-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  await realGit(["init", "-b", "main", repo], root);
  await realGit(["config", "user.email", "test@example.com"], repo);
  await realGit(["config", "user.name", "Test"], repo);
  await realGit(["config", "commit.gpgsign", "false"], repo);
  await realGit(["config", "core.autocrlf", "false"], repo);
  await writeFile(path.join(repo, "a.txt"), "hello\n");
  await realGit(["add", "a.txt"], repo);
  await realGit(["commit", "-m", "initial"], repo);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: repo, provider: "fake", model: "fake-model" });
  const events = new EventBus();
  const published: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event: { type: string; payload: unknown }) => published.push(event));
  const scm = new ScmService(unusedCore(), sessions, events, { worktreeRoot: path.join(root, "worktrees"), exec: realGit });
  return { root, repo, sessions, session, published, scm };
}

describe("ScmService（0.4.0 Phase 4a，真实 git 集成）", () => {
  it("git_status：分支 + staged/unstaged/untracked 分组与总数", async () => {
    const { repo, session, scm } = await setup();
    await writeFile(path.join(repo, "a.txt"), "hello\nmodified\n");
    await writeFile(path.join(repo, "staged.txt"), "staged\n");
    await realGit(["add", "staged.txt"], repo);
    await writeFile(path.join(repo, "new.txt"), "untracked\n");
    const status = await scm.status(session.id, repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.staged.map((entry) => entry.path)).toEqual(["staged.txt"]);
    expect(status.unstaged.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(status.untracked.map((entry) => entry.path)).toEqual(["new.txt"]);
    expect(status.totals).toEqual({ staged: 1, unstaged: 1, untracked: 1 });
    expect(status.truncated).toBe(false);
  });

  it("非 git 仓库：status/diff 如实降级（isRepo=false），commit 报错", async () => {
    const { root, session, scm } = await setup();
    const plain = path.join(root, "plain");
    await mkdir(plain, { recursive: true });
    const status = await scm.status(session.id, plain);
    expect(status.isRepo).toBe(false);
    const diff = await scm.diff(session.id, plain);
    expect(diff.isRepo).toBe(false);
    await expect(scm.commit(session.id, plain, { message: "x" })).rejects.toThrow(NotARepoError);
  });

  it("git_diff：unstaged / staged / commit 区间 / 单文件", async () => {
    const { repo, session, scm } = await setup();
    await writeFile(path.join(repo, "a.txt"), "hello\nv2\n");
    const unstaged = await scm.diff(session.id, repo);
    expect(unstaged.isRepo).toBe(true);
    expect(unstaged.truncated).toBe(false);
    expect(unstaged.diff).toContain("+v2");
    await realGit(["add", "a.txt"], repo);
    const staged = await scm.diff(session.id, repo, { staged: true });
    expect(staged.diff).toContain("+v2");
    expect((await scm.diff(session.id, repo)).diff).not.toContain("+v2");
    await realGit(["commit", "-m", "second"], repo);
    const ranged = await scm.diff(session.id, repo, { base: "HEAD~1..HEAD" });
    expect(ranged.diff).toContain("+v2");
    // 单文件限定
    await writeFile(path.join(repo, "b.txt"), "b\n");
    await realGit(["add", "b.txt"], repo);
    const single = await scm.diff(session.id, repo, { staged: true, file: "a.txt" });
    expect(single.diff).toBe("");
  });

  it("大 diff 超阈值：只给 stat + 摘要，完整 diff 落 artifact", async () => {
    const { repo, session, sessions, scm } = await setup();
    const big = Array.from({ length: 5_000 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n");
    await writeFile(path.join(repo, "big.txt"), big);
    await realGit(["add", "big.txt"], repo);
    const diff = await scm.diff(session.id, repo, { staged: true });
    expect(diff.truncated).toBe(true);
    expect(diff.diff).toBeUndefined();
    expect(diff.totalBytes).toBeGreaterThan(MAX_INLINE_DIFF_BYTES);
    expect(diff.stat).toContain("big.txt");
    expect(diff.artifactId).toMatch(/^artifact-/);
    const artifact = await readFile(path.join(sessions.contextRoot(session.id), "artifacts", `${diff.artifactId}.txt`), "utf8");
    expect(artifact).toContain("line 4999");
  });

  it("git_commit：stageAll 提交成功并附带 status 摘要，广播 scm.updated", async () => {
    const { repo, session, published, scm } = await setup();
    await writeFile(path.join(repo, "c.txt"), "c\n");
    const result = await scm.commit(session.id, repo, { message: "add c", stageAll: true });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.subject).toBe("add c");
    expect(result.status.isRepo).toBe(true);
    expect(result.status.totals).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
    const event = published.find((item) => item.type === "scm.updated");
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({ sessionId: session.id, reason: "commit" });
    const log = await realGit(["log", "--oneline", "-1"], repo);
    expect(log.stdout).toContain("add c");
  });

  it("git_commit 参数白名单：危险 flag / 绝对路径 / .. 一律拒绝", async () => {
    const { repo, session, scm } = await setup();
    await writeFile(path.join(repo, "d.txt"), "d\n");
    await expect(scm.commit(session.id, repo, { message: "x", files: ["--no-verify"] })).rejects.toThrow("Invalid relative path");
    await expect(scm.commit(session.id, repo, { message: "x", files: ["../escape.txt"] })).rejects.toThrow("Invalid relative path");
    await expect(scm.commit(session.id, repo, { message: "x", files: ["C:/Windows/x"] })).rejects.toThrow("Invalid relative path");
    await expect(scm.commit(session.id, repo, { message: "x", files: ["d.txt; rm -rf /"] })).rejects.toThrow("Invalid relative path");
    await expect(scm.commit(session.id, repo, { message: "  " })).rejects.toThrow("non-empty message");
    await expect(scm.commit(session.id, repo, { message: "x", stageAll: true, files: ["d.txt"] })).rejects.toThrow("mutually exclusive");
    // 白名单内的 files 正常暂存
    const ok = await scm.commit(session.id, repo, { message: "add d", files: ["d.txt"] });
    expect(ok.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("worktree 生命周期：create/list（上限 4）/remove，会话结束不自动删除", async () => {
    const { repo, session, published, scm } = await setup();
    const first = await scm.createWorktree(session.id, repo, { name: "task-a" });
    expect(first.branch).toBe("owc/task-a");
    expect(first.exists).toBe(true);
    const list = await scm.listWorktrees(session.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "task-a", branch: "owc/task-a", exists: true });
    expect(published.find((event) => event.type === "scm.updated" && (event.payload as { reason?: string }).reason === "worktree.create")).toBeDefined();
    // 上限 MAX_WORKTREES
    await scm.createWorktree(session.id, repo, { name: "task-b" });
    await scm.createWorktree(session.id, repo, { name: "task-c" });
    await scm.createWorktree(session.id, repo, { name: "task-d" });
    await expect(scm.createWorktree(session.id, repo, { name: "task-e" })).rejects.toThrow(`Worktree limit reached (${MAX_WORKTREES})`);
    // 非法名称
    await expect(scm.createWorktree(session.id, repo, { name: "bad name" })).rejects.toThrow("Invalid worktree name");
    // 有未提交改动时 remove 拒绝，force 可删
    await writeFile(path.join(first.path, "dirty.txt"), "dirty\n");
    await expect(scm.removeWorktree(session.id, repo, "task-a")).rejects.toThrow("worktree remove failed");
    const removed = await scm.removeWorktree(session.id, repo, "task-a", { force: true });
    expect(removed.removed).toBe(true);
    expect((await scm.listWorktrees(session.id)).map((entry) => entry.name)).toEqual(["task-b", "task-c", "task-d"]);
  });

  it("worktree 合回：干净 merge 成功；冲突如实报告文件列表并中止（不自动解决）", async () => {
    const { repo, session, scm } = await setup();
    // 干净合回
    const clean = await scm.createWorktree(session.id, repo, { name: "clean" });
    await writeFile(path.join(clean.path, "feature.txt"), "feature\n");
    await realGit(["add", "feature.txt"], clean.path);
    await realGit(["commit", "-m", "feature"], clean.path);
    const merged = await scm.mergeWorktree(session.id, repo, "clean");
    expect(merged.merged).toBe(true);
    expect(merged.conflicts).toEqual([]);
    expect(await readFile(path.join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    // 冲突合回：同一文件同一行双向修改
    const conflict = await scm.createWorktree(session.id, repo, { name: "conflict" });
    await writeFile(path.join(conflict.path, "a.txt"), "worktree version\n");
    await realGit(["commit", "-am", "worktree edit"], conflict.path);
    await writeFile(path.join(repo, "a.txt"), "main version\n");
    await realGit(["commit", "-am", "main edit"], repo);
    const result = await scm.mergeWorktree(session.id, repo, "conflict");
    expect(result.merged).toBe(false);
    expect(result.conflicts).toEqual(["a.txt"]);
    // 已中止：主工作区无 merge 进行中，内容保持 main 版本
    const status = await realGit(["status", "--porcelain"], repo);
    expect(status.stdout.trim()).toBe("");
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("main version\n");
    // cherry-pick 策略同样如实报告冲突
    const cherry = await scm.mergeWorktree(session.id, repo, "conflict", { strategy: "cherry-pick" });
    expect(cherry.merged).toBe(false);
    expect(cherry.conflicts).toEqual(["a.txt"]);
  });

  it("worktree 注册表损坏/不存在时 list 返回空", async () => {
    const { session, scm } = await setup();
    expect(await scm.listWorktrees(session.id)).toEqual([]);
  });

  it("parseStatusPorcelain：分组截断有界，总数保留", () => {
    const lines = ["## main"];
    for (let index = 0; index < MAX_STATUS_ENTRIES_PER_GROUP + 50; index += 1) lines.push(`?? file-${index}.txt`);
    lines.push(" M mod.txt", "M  staged.txt");
    const parsed = parseStatusPorcelain(lines.join("\n"));
    expect(parsed.branch).toBe("main");
    expect(parsed.untracked).toHaveLength(MAX_STATUS_ENTRIES_PER_GROUP);
    expect(parsed.totals.untracked).toBe(MAX_STATUS_ENTRIES_PER_GROUP + 50);
    expect(parsed.truncated).toBe(true);
    expect(parsed.staged.map((entry) => entry.path)).toEqual(["staged.txt"]);
    expect(parsed.unstaged.map((entry) => entry.path)).toEqual(["mod.txt"]);
  });

  it("parseStatusPorcelain：ahead/behind 与 rename", () => {
    const parsed = parseStatusPorcelain("## main...origin/main [ahead 2, behind 1]\nR  old.txt -> new.txt");
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.staged[0]).toMatchObject({ path: "new.txt", originalPath: "old.txt" });
  });
});

describe("git_commit 权限链（0.4.0 Phase 4a）", () => {
  const coordinator = new PermissionCoordinator(new EventBus());
  it("ask 模式默认需确认；yolo 不隐含提交授权；allow_always 规则按会话授权", () => {
    const input = { message: "x" };
    expect(coordinator.needsApproval("ask", [], "git_commit", input)).toBe(true);
    expect(coordinator.needsApproval("acceptEdits", [], "git_commit", input)).toBe(true);
    expect(coordinator.needsApproval("yolo", [], "git_commit", input)).toBe(true);
    expect(coordinator.needsApproval("yolo", [{ tool: "git_commit" }], "git_commit", input)).toBe(false);
    // 其他工具规则不误授权 git_commit
    expect(coordinator.needsApproval("ask", [{ tool: "bash", argumentPrefix: "git commit" }], "git_commit", input)).toBe(true);
  });
  it("只读 git 工具自动放行；worktree 写操作走常规模式链", () => {
    expect(coordinator.needsApproval("ask", [], "git_status", {})).toBe(false);
    expect(coordinator.needsApproval("ask", [], "git_diff", {})).toBe(false);
    expect(coordinator.needsApproval("ask", [], "git_worktree_create", {})).toBe(true);
    expect(coordinator.needsApproval("yolo", [], "git_worktree_create", {})).toBe(false);
  });
});
