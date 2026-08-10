import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import {
  MAX_STATUS_ENTRIES_PER_GROUP,
  MAX_WORKTREES,
  MAX_INLINE_DIFF_BYTES,
  NotARepoError,
  ScmService,
  parseStatusPorcelain,
  parseStatusPorcelainZ,
} from "../src/scm/service.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { initGitRepo, realGit, unusedCore } from "./helpers/git.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-scm-"));
  roots.push(root);
  const repo = await initGitRepo(root);
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

  it("git_commit 提交信息文件落在工作区 .git/ 内（沙盒挂载面内可读），不污染 git status", async () => {
    const { repo, session, scm } = await setup();
    await writeFile(path.join(repo, "m.txt"), "m\n");
    const result = await scm.commit(session.id, repo, { message: "msg file in git dir", stageAll: true });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    // 文件真实写在 <cwd>/.git/ 下（沙盒只挂载 cwd，git 能读到即证明路径在挂载面内）
    expect(await readFile(path.join(repo, ".git", `owc-commit-${session.id}.txt`), "utf8")).toBe("msg file in git dir");
    // .git 内部文件不进 status
    expect(result.status.totals).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
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
    await writeFile(path.join(repo, "中文 文件.txt"), "safe\n");
    const spaced = await scm.commit(session.id, repo, { message: "add spaced unicode path", files: ["中文 文件.txt"] });
    expect(spaced.commit).toMatch(/^[0-9a-f]{40}$/);
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

  it("worktree cherry-pick 合回包含分支上的全部提交", async () => {
    const { repo, session, scm } = await setup();
    const worktree = await scm.createWorktree(session.id, repo, { name: "multi" });
    await writeFile(path.join(worktree.path, "first.txt"), "first\n");
    await realGit(["add", "first.txt"], worktree.path);
    await realGit(["commit", "-m", "first change"], worktree.path);
    await writeFile(path.join(worktree.path, "second.txt"), "second\n");
    await realGit(["add", "second.txt"], worktree.path);
    await realGit(["commit", "-m", "second change"], worktree.path);
    const result = await scm.mergeWorktree(session.id, repo, "multi", { strategy: "cherry-pick" });
    expect(result.merged).toBe(true);
    expect(await readFile(path.join(repo, "first.txt"), "utf8")).toBe("first\n");
    expect(await readFile(path.join(repo, "second.txt"), "utf8")).toBe("second\n");
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

  it("parseStatusPorcelainZ：保留空格、非 ASCII 与 rename 原始路径", () => {
    const parsed = parseStatusPorcelainZ("## main...origin/main [ahead 1]\0R  新 文件.ts\0旧 文件.ts\0?? quote\\name.txt\0");
    expect(parsed).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 1, behind: 0 });
    expect(parsed.staged[0]).toMatchObject({ path: "新 文件.ts", originalPath: "旧 文件.ts" });
    expect(parsed.untracked[0]).toMatchObject({ path: "quote\\name.txt" });
  });
});

describe("stage / unstage / discard / log（阶段 2a/2f）", () => {
  /** 录制型 fake GitExec：按命令前缀回放响应，断言 args 原样（未 shell 拼接）。 */
  function fakeGit(responses: Array<{ match: (args: string[]) => boolean; stdout?: string; stderr?: string; exitCode?: number }>) {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      calls.push([...args]);
      for (const response of responses) {
        if (response.match(args)) return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    return { calls, exec };
  }
  const isRepo = { match: (args: string[]) => args[0] === "rev-parse", stdout: "true\n" };

  async function setupWithExec(exec: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-scm-fake-"));
    roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
    const events = new EventBus();
    const published: Array<{ type: string; payload: unknown }> = [];
    events.on("event", (event: { type: string; payload: unknown }) => published.push(event));
    const scm = new ScmService(unusedCore(), sessions, events, { worktreeRoot: path.join(root, "worktrees"), exec });
    return { root, session, published, scm };
  }

  it("stage：git add -- <files>，参数逐项传递并广播 scm.updated", async () => {
    const fake = fakeGit([isRepo]);
    const { session, published, scm } = await setupWithExec(fake.exec);
    const result = await scm.stage(session.id, "repo", ["a.txt", "dir/b.txt"]);
    expect(result).toEqual({ ok: true });
    expect(fake.calls).toEqual([["rev-parse", "--is-inside-work-tree"], ["add", "--", "a.txt", "dir/b.txt"]]);
    const event = published.find((item) => item.type === "scm.updated");
    expect(event?.payload).toMatchObject({ sessionId: session.id, reason: "stage" });
    // 非法路径（绝对路径/../）在 exec 前被拒绝
    await expect(scm.stage(session.id, "repo", ["../x"])).rejects.toThrow("Invalid relative path");
    expect(fake.calls).toHaveLength(2);
  });

  it("unstage：git restore --staged -- <files>", async () => {
    const fake = fakeGit([isRepo]);
    const { session, scm } = await setupWithExec(fake.exec);
    await scm.unstage(session.id, "repo", ["staged.txt"]);
    expect(fake.calls[1]).toEqual(["restore", "--staged", "--", "staged.txt"]);
  });

  it("discard：status 分拣 tracked/untracked，restore + clean -f；缺 force 拒绝 untracked", async () => {
    const fake = fakeGit([
      isRepo,
      { match: (args) => args[0] === "status", stdout: "## main\0 M tracked.txt\0?? new.txt\0?? newdir/\0" },
    ]);
    const { session, published, scm } = await setupWithExec(fake.exec);
    // untracked 缺 force -> 拒绝，且不执行任何 restore/clean
    await expect(scm.discard(session.id, "repo", ["tracked.txt", "new.txt"])).rejects.toThrow("force");
    expect(fake.calls.filter((args) => args[0] === "restore" || args[0] === "clean")).toHaveLength(0);
    // 带 force：tracked 走 restore，untracked（含未跟踪目录内文件）走 clean -f
    const result = await scm.discard(session.id, "repo", ["tracked.txt", "new.txt", "newdir/inner.txt"], { force: true });
    expect(result).toEqual({ ok: true });
    expect(fake.calls.find((args) => args[0] === "restore")).toEqual(["restore", "--", "tracked.txt"]);
    expect(fake.calls.find((args) => args[0] === "clean")).toEqual(["clean", "-f", "--", "new.txt", "newdir/inner.txt"]);
    const event = published.find((item) => item.type === "scm.updated");
    expect(event?.payload).toMatchObject({ sessionId: session.id, reason: "discard" });
  });

  it("log：\\x1f 分隔解析为结构化提交；limit 钳制 1-200", async () => {
    const fake = fakeGit([
      isRepo,
      {
        match: (args) => args[0] === "log",
        stdout: "abc123def456\x1fabc123d\x1fAlice\x1f2 hours ago\x1ffeat: subject line\nbbb222\x1fbbb222\x1fBob\x1f3 days ago\x1finitial",
      },
    ]);
    const { session, scm } = await setupWithExec(fake.exec);
    const commits = await scm.log(session.id, "repo");
    expect(commits).toEqual([
      { hash: "abc123def456", shortHash: "abc123d", author: "Alice", relTime: "2 hours ago", subject: "feat: subject line" },
      { hash: "bbb222", shortHash: "bbb222", author: "Bob", relTime: "3 days ago", subject: "initial" },
    ]);
    // 默认 -n 50
    expect(fake.calls.find((args) => args[0] === "log")).toContain("50");
    // 钳制：0 -> 1，9999 -> 200
    fake.calls.length = 0;
    await scm.log(session.id, "repo", 0);
    await scm.log(session.id, "repo", 9999);
    const logCalls = fake.calls.filter((args) => args[0] === "log");
    expect(logCalls[0]).toContain("1");
    expect(logCalls[1]).toContain("200");
  });

  it("log：空仓库（无提交）返回空数组而非报错", async () => {
    const fake = fakeGit([
      isRepo,
      { match: (args) => args[0] === "log", stderr: "fatal: your current branch 'main' does not have any commits yet", exitCode: 128 },
    ]);
    const { session, scm } = await setupWithExec(fake.exec);
    expect(await scm.log(session.id, "repo")).toEqual([]);
    // 非空仓库的真实错误仍抛出
    const failing = fakeGit([isRepo, { match: (args) => args[0] === "log", stderr: "fatal: bad object HEAD", exitCode: 128 }]);
    const other = await setupWithExec(failing.exec);
    await expect(other.scm.log(other.session.id, "repo")).rejects.toThrow("git log failed");
  });

  it("真实 git：stage/unstage/discard/log 端到端", async () => {
    const { repo, session, scm } = await setup();
    await writeFile(path.join(repo, "s.txt"), "staged\n");
    await scm.stage(session.id, repo, ["s.txt"]);
    let status = await scm.status(session.id, repo);
    expect(status.staged.map((entry) => entry.path)).toEqual(["s.txt"]);
    await scm.unstage(session.id, repo, ["s.txt"]);
    status = await scm.status(session.id, repo);
    expect(status.staged).toEqual([]);
    expect(status.untracked.map((entry) => entry.path)).toEqual(["s.txt"]);
    // tracked 修改 + untracked 新文件一起 discard
    await writeFile(path.join(repo, "a.txt"), "changed\n");
    await scm.discard(session.id, repo, ["a.txt", "s.txt"], { force: true });
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("hello\n");
    status = await scm.status(session.id, repo);
    expect(status.totals).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
    // log 含初始提交
    const commits = await scm.log(session.id, repo);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ author: "Test", subject: "initial" });
    expect(commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
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

// ---- scm-api 组（合并） ----
const apiRoots: string[] = [];
const apiApps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apiApps.splice(0).map((app) => app.close()));
  await Promise.all(apiRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupApi(options: { withScm?: boolean } = {}) {
  const { withScm = true } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-scm-api-"));
  apiRoots.push(root);
  const repo = await initGitRepo(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: repo, provider: "fake", model: "fake-model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  const core = unusedCore();
  const events = new EventBus();
  const published: Array<{ type: string; sessionId?: string; payload: unknown }> = [];
  events.on("event", (event: { type: string; sessionId?: string; payload: unknown }) => published.push(event));
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const scm = new ScmService(core, sessions, events, { worktreeRoot: path.join(root, "worktrees"), exec: realGit });
  agent.setScm(scm);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing, ...(withScm ? { scm } : {}) });
  apiApps.push(app);
  return { app, session, repo, published };
}

describe("SCM REST 契约（0.4.0 Phase 4a）", () => {
  it("GET git/status 返回分支与分组；GET git/diff 支持 staged/base query", async () => {
    const { app, session, repo } = await setupApi();
    await writeFile(path.join(repo, "a.txt"), "hello\nv2\n");
    const status = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ isRepo: true, branch: "main", totals: { staged: 0, unstaged: 1, untracked: 0 } });
    const diff = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/diff` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().diff).toContain("+v2");
    await realGit(["add", "a.txt"], repo);
    const staged = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/diff?staged=true` });
    expect(staged.json().diff).toContain("+v2");
    const conflict = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/diff?staged=true&base=HEAD~1` });
    expect(conflict.statusCode).toBe(400);
    // 非法 base / file 参数被拒绝
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/diff?base=--exec` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/diff?file=../x` })).statusCode).toBe(400);
  });

  it("worktrees REST：POST 创建（上限）/GET 列表/DELETE 删除/merge 冲突如实报告", async () => {
    const { app, session, repo, published } = await setupApi();
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/worktrees` })).json()).toEqual({ worktrees: [] });
    const created = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/worktrees`, payload: { name: "wt-1" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "wt-1", branch: "owc/wt-1", exists: true });
    const list = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/worktrees` });
    expect(list.json().worktrees).toHaveLength(1);
    // 冲突合回：worktree 与 main 双向改同一文件
    const wtPath = created.json().path;
    await writeFile(path.join(wtPath, "a.txt"), "worktree\n");
    await realGit(["commit", "-am", "wt edit"], wtPath);
    await writeFile(path.join(repo, "a.txt"), "main\n");
    await realGit(["commit", "-am", "main edit"], repo);
    const merge = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/worktrees/wt-1/merge`, payload: {} });
    expect(merge.statusCode).toBe(200);
    expect(merge.json()).toMatchObject({ merged: false, conflicts: ["a.txt"], strategy: "merge", branch: "owc/wt-1" });
    // 冲突事件广播
    const conflictEvent = published.find((event) => event.type === "scm.updated" && (event.payload as { reason?: string }).reason === "worktree.merge_conflict");
    expect(conflictEvent).toBeDefined();
    // force 删除
    const removed = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}/git/worktrees/wt-1?force=true` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true, name: "wt-1" });
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/worktrees` })).json()).toEqual({ worktrees: [] });
    // 未知 worktree 404 语义的 400 错误
    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}/git/worktrees/nope` })).statusCode).toBe(400);
    // 非法名称
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/worktrees`, payload: { name: "bad name" } })).statusCode).toBe(400);
  });

  it("stage/unstage/discard 路由：校验、force 门禁与 scm.updated 广播", async () => {
    const { app, session, repo, published } = await setupApi();
    // 参数校验：缺 files / 空数组 / 非字符串项一律 400
    for (const url of ["stage", "unstage", "discard"]) {
      expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/${url}`, payload: {} })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/${url}`, payload: { files: [] } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/${url}`, payload: { files: ["../escape"] } })).statusCode).toBe(400);
    }
    // stage -> unstage
    await writeFile(path.join(repo, "api.txt"), "api\n");
    const staged = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/stage`, payload: { files: ["api.txt"] } });
    expect(staged.statusCode).toBe(200);
    expect(staged.json()).toEqual({ ok: true });
    expect((await realGit(["status", "--porcelain"], repo)).stdout).toContain("A  api.txt");
    const unstaged = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/unstage`, payload: { files: ["api.txt"] } });
    expect(unstaged.statusCode).toBe(200);
    expect((await realGit(["status", "--porcelain"], repo)).stdout).toContain("?? api.txt");
    // discard：tracked 修改无需 force；untracked 缺 force -> 400 且不删除
    await writeFile(path.join(repo, "a.txt"), "changed\n");
    const trackedOnly = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/discard`, payload: { files: ["a.txt"] } });
    expect(trackedOnly.statusCode).toBe(200);
    expect((await realGit(["status", "--porcelain"], repo)).stdout).not.toContain("a.txt");
    const noForce = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/discard`, payload: { files: ["api.txt"] } });
    expect(noForce.statusCode).toBe(400);
    expect((await realGit(["status", "--porcelain"], repo)).stdout).toContain("?? api.txt");
    const forced = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/git/discard`, payload: { files: ["api.txt"], force: true } });
    expect(forced.statusCode).toBe(200);
    expect((await realGit(["status", "--porcelain"], repo)).stdout.trim()).toBe("");
    // scm.updated 广播（reason 对齐）
    const reasons = published.filter((event) => event.type === "scm.updated").map((event) => (event.payload as { reason?: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(["stage", "unstage", "discard"]));
  });

  it("GET git/log：结构化提交列表 + limit 校验；未注入 scm 501", async () => {
    const { app, session } = await setupApi();
    const log = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/log` });
    expect(log.statusCode).toBe(200);
    const body = log.json() as { commits: Array<{ hash: string; shortHash: string; author: string; relTime: string; subject: string }> };
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]).toMatchObject({ author: "Test", subject: "initial" });
    expect(body.commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(body.commits[0]!.shortHash).toMatch(/^[0-9a-f]{7,}$/);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/log?limit=0` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/log?limit=abc` })).statusCode).toBe(400);
    const noService = await setupApi({ withScm: false });
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/git/log` })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "POST", url: `/api/sessions/${noService.session.id}/git/stage`, payload: { files: ["a.txt"] } })).statusCode).toBe(501);
  });

  it("未知会话 404；未注入 scm 501", async () => {
    const { app } = await setupApi();
    const missing = "/api/sessions/00000000-0000-4000-8000-000000000000/git/status";
    expect((await app.inject({ method: "GET", url: missing })).statusCode).toBe(404);
    const noService = await setupApi({ withScm: false });
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/git/status` })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/git/worktrees` })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "POST", url: `/api/sessions/${noService.session.id}/git/worktrees`, payload: {} })).statusCode).toBe(501);
  });
});
