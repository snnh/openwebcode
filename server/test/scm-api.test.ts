import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ScmService } from "../src/scm/service.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { initGitRepo, realGit, unusedCore } from "./helpers/git.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { withScm?: boolean } = {}) {
  const { withScm = true } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-scm-api-"));
  roots.push(root);
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
  apps.push(app);
  return { app, session, repo, published };
}

describe("SCM REST 契约（0.4.0 Phase 4a）", () => {
  it("GET git/status 返回分支与分组；GET git/diff 支持 staged/base query", async () => {
    const { app, session, repo } = await setup();
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
    const { app, session, repo, published } = await setup();
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
    const { app, session, repo, published } = await setup();
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
    const { app, session } = await setup();
    const log = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/log` });
    expect(log.statusCode).toBe(200);
    const body = log.json() as { commits: Array<{ hash: string; shortHash: string; author: string; relTime: string; subject: string }> };
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]).toMatchObject({ author: "Test", subject: "initial" });
    expect(body.commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(body.commits[0]!.shortHash).toMatch(/^[0-9a-f]{7,}$/);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/log?limit=0` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/log?limit=abc` })).statusCode).toBe(400);
    const noService = await setup({ withScm: false });
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/git/log` })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "POST", url: `/api/sessions/${noService.session.id}/git/stage`, payload: { files: ["a.txt"] } })).statusCode).toBe(501);
  });

  it("未知会话 404；未注入 scm 501", async () => {
    const { app } = await setup();
    const missing = "/api/sessions/00000000-0000-4000-8000-000000000000/git/status";
    expect((await app.inject({ method: "GET", url: missing })).statusCode).toBe(404);
    const noService = await setup({ withScm: false });
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/git/status` })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "GET", url: `/api/sessions/${noService.session.id}/git/worktrees` })).statusCode).toBe(501);
    expect((await noService.app.inject({ method: "POST", url: `/api/sessions/${noService.session.id}/git/worktrees`, payload: {} })).statusCode).toBe(501);
  });
});
