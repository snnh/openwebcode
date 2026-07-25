import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ScmService } from "../src/scm/service.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function realGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
  }
}

function unusedCore(): CoreClientLike {
  const core = { on() { return core; } } as unknown as CoreClientLike;
  return core;
}

async function setup(options: { withScm?: boolean } = {}) {
  const { withScm = true } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-scm-api-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  await realGit(["init", "-b", "main", repo], root);
  await realGit(["config", "user.email", "test@example.com"], repo);
  await realGit(["config", "user.name", "Test"], repo);
  await realGit(["config", "core.autocrlf", "false"], repo);
  await writeFile(path.join(repo, "a.txt"), "hello\n");
  await realGit(["add", "a.txt"], repo);
  await realGit(["commit", "-m", "initial"], repo);
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
    // 主工作区保持中止后干净状态
    expect((await realGit(["status", "--porcelain"], repo)).stdout.trim()).toBe("");
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
