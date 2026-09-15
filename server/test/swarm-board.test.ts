import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSwarmBoard,
  digestSwarmBoard,
  readSwarmBoard,
  swarmBoardPath,
  waitSwarmBoard,
  writeSwarmLifecycle,
  writeSwarmRoster,
  type SwarmRosterMember,
} from "../src/agent/swarm-board.js";
import { tempRoot } from "./helpers/temp-roots.js";

const ROSTER: SwarmRosterMember[] = [
  { index: 1, member: "alice", agent: "general", role: "balanced", model: "m-a", taskExcerpt: "审查 auth 模块" },
  { index: 2, member: "bob", agent: "explore", role: "cheap", model: "m-b", taskExcerpt: "审查 api 模块" },
  { index: 3, member: "carol", role: "premium", model: "m-c", taskExcerpt: "汇总风险" },
];

async function boardIn(root: string): Promise<string> {
  return swarmBoardPath(root, "test-swarm");
}

describe("swarm-board 行格式与兼容", () => {
  it("append+read 回传 id/kind/to/priority/replyTo", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await appendSwarmBoard(boardPath, "alice", "发现鉴权绕过", { kind: "finding", priority: "high" });
    await appendSwarmBoard(boardPath, "alice", "bob 看一下这个", { kind: "request", to: "bob", replyTo: "p_abc123" });
    const read = await readSwarmBoard(boardPath);
    expect(read.entries).toHaveLength(2);
    expect(read.entries[0]).toMatchObject({ from: "alice", kind: "finding", priority: "high" });
    expect(read.entries[0]?.id).toMatch(/^p_[0-9a-f]{6}$/);
    expect(read.entries[1]).toMatchObject({ kind: "request", to: "bob", replyTo: "p_abc123" });
    expect(read.offset).toBe(2);
    expect(read.total).toBe(2);
  });

  it("旧行（无 id/kind，仅 {ts,from,text}）向后兼容：读侧补临时序号，缺省 finding 语义", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await mkdir(path.dirname(boardPath), { recursive: true });
    await appendFile(boardPath, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", from: "old", text: "legacy" })}\n`, "utf8");
    const read = await readSwarmBoard(boardPath);
    expect(read.entries[0]).toMatchObject({ id: "l1", from: "old", text: "legacy" });
    expect(read.entries[0]?.kind).toBeUndefined();
    // kind 过滤按 finding 缺省语义命中旧行
    const filtered = await readSwarmBoard(boardPath, { kind: "finding" });
    expect(filtered.entries).toHaveLength(1);
  });
});

describe("roster 与 lifecycle", () => {
  it("roster 系统贴解析进 members，不进内容流；taskExcerpt 保留", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await writeSwarmRoster(boardPath, ROSTER);
    await appendSwarmBoard(boardPath, "alice", "hello");
    const read = await readSwarmBoard(boardPath);
    expect(read.members).toHaveLength(3);
    expect(read.members[0]).toMatchObject({ member: "alice", role: "balanced", taskExcerpt: "审查 auth 模块" });
    // roster 帖不出现在内容 entries 里
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.from).toBe("alice");
  });

  it("lifecycle 帖解析为 memberStatus（每成员取最新态）", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await writeSwarmLifecycle(boardPath, "alice", "started");
    await writeSwarmLifecycle(boardPath, "bob", "started");
    await writeSwarmLifecycle(boardPath, "alice", "finished");
    await writeSwarmLifecycle(boardPath, "bob", "failed", "boom");
    const read = await readSwarmBoard(boardPath);
    expect(read.memberStatus.alice?.event).toBe("finished");
    expect(read.memberStatus.bob).toMatchObject({ event: "failed", reason: "boom" });
  });
});

describe("可见性过滤（私聊不出第三人视野）", () => {
  it("私聊仅收发双方可见；广播全员可见；无 viewer 不过滤", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await appendSwarmBoard(boardPath, "alice", "广播");
    await appendSwarmBoard(boardPath, "alice", "只给 bob", { to: "bob" });
    await appendSwarmBoard(boardPath, "bob", "回 alice", { to: "alice" });

    const carol = await readSwarmBoard(boardPath, { viewer: "carol" });
    expect(carol.entries.map((entry) => entry.text)).toEqual(["广播"]);

    // bob 视角：广播 + 发给我的 + 我发的（自己发出的私聊自己可见）
    const bob = await readSwarmBoard(boardPath, { viewer: "bob" });
    expect(bob.entries.map((entry) => entry.text)).toEqual(["广播", "只给 bob", "回 alice"]);

    const alice = await readSwarmBoard(boardPath, { viewer: "alice" });
    expect(alice.entries.map((entry) => entry.text)).toEqual(["广播", "只给 bob", "回 alice"]);

    const all = await readSwarmBoard(boardPath);
    expect(all.entries).toHaveLength(3);
  });

  it("kind/from/to/mine 过滤", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await appendSwarmBoard(boardPath, "alice", "f1", { kind: "finding" });
    await appendSwarmBoard(boardPath, "bob", "q1", { kind: "question" });
    await appendSwarmBoard(boardPath, "bob", "私聊 q2", { kind: "question", to: "alice" });
    expect((await readSwarmBoard(boardPath, { viewer: "alice", kind: "question" })).entries.map((entry) => entry.text)).toEqual(["q1", "私聊 q2"]);
    expect((await readSwarmBoard(boardPath, { viewer: "alice", from: "bob" })).entries).toHaveLength(2);
    expect((await readSwarmBoard(boardPath, { viewer: "alice", to: "alice" })).entries.map((entry) => entry.text)).toEqual(["私聊 q2"]);
    expect((await readSwarmBoard(boardPath, { viewer: "alice", mine: true })).entries.map((entry) => entry.text)).toEqual(["f1", "私聊 q2"]);
  });
});

describe("滚动聚合", () => {
  it(">80 条时旧段广播聚合，私聊与 @提及帖保留原文进优先段", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    // 私聊与 @提及先发（落入旧段），再 45 条 alice finding + 45 条 bob progress 广播
    await appendSwarmBoard(boardPath, "bob", "机密：只给 carol", { to: "carol" });
    await appendSwarmBoard(boardPath, "bob", "@carol 看一下聚合边界", { kind: "request" });
    for (let index = 0; index < 45; index++) await appendSwarmBoard(boardPath, "alice", `finding ${index}`, { kind: "finding" });
    for (let index = 0; index < 45; index++) await appendSwarmBoard(boardPath, "bob", `progress ${index}`, { kind: "progress" });

    const read = await readSwarmBoard(boardPath, { viewer: "carol" });
    expect(read.total).toBe(92);
    // 新段原文封顶 50 条（92 - 50 = 42 条进旧段）
    expect(read.entries).toHaveLength(50);
    // 聚合段：旧段 42 条 = 私聊 + 提及 + alice finding×40；广播按成员+kind 聚合，不含私聊内容
    expect(read.aggregated.length).toBeGreaterThan(0);
    expect(read.aggregated.join("\n")).toContain("alice · finding ×40");
    expect(read.aggregated.join("\n")).not.toContain("机密");
    expect(read.aggregated.join("\n")).not.toContain("@carol");
    // 私聊 + @提及原文进优先段（不被聚合吞掉）
    expect(read.priority.map((entry) => entry.text)).toEqual(["机密：只给 carol", "@carol 看一下聚合边界"]);
  });

  it("不超过阈值时不聚合（全部原文）", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    for (let index = 0; index < 10; index++) await appendSwarmBoard(boardPath, "alice", `post ${index}`);
    const read = await readSwarmBoard(boardPath, { viewer: "bob" });
    expect(read.aggregated).toEqual([]);
    expect(read.priority).toEqual([]);
    expect(read.entries).toHaveLength(10);
  });
});

describe("kind 感知 digest", () => {
  it("按 kind 分组统计，decision/blocker 置顶段列出原文", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await writeSwarmRoster(boardPath, ROSTER);
    await appendSwarmBoard(boardPath, "alice", "普通发现", { kind: "finding" });
    await appendSwarmBoard(boardPath, "bob", "决议：走方案 A", { kind: "decision" });
    await appendSwarmBoard(boardPath, "carol", "阻塞：缺凭据", { kind: "blocker" });
    const digest = await digestSwarmBoard(boardPath);
    expect(digest).toContain("by kind: finding=1, decision=1, blocker=1");
    expect(digest).toContain("member posts: alice=1, bob=1, carol=1");
    expect(digest).toContain("Decisions:\n- [bob] 决议：走方案 A");
    expect(digest).toContain("Blockers:\n- [carol] 阻塞：缺凭据");
    expect(digest).toContain("Last entries:");
    // roster 系统贴不计入成员帖
    expect(digest).not.toContain("#system");
  });

  it("空板返回 undefined", async () => {
    const root = await tempRoot("owc-swarm-board-");
    expect(await digestSwarmBoard(await boardIn(root))).toBeUndefined();
  });
});

describe("swarm_wait", () => {
  it("toMe（默认）：发到我的私聊唤醒", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    const waiting = waitSwarmBoard(boardPath, { viewer: "carol", timeoutSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await appendSwarmBoard(boardPath, "alice", "别人的广播"); // 不应唤醒 toMe
    await appendSwarmBoard(boardPath, "bob", "carol 收", { to: "carol" });
    const result = await waiting;
    expect(result.outcome).toBe("hit");
    expect(result.entries.map((entry) => entry.text)).toEqual(["carol 收"]);
  });

  it("@提及唤醒 toMe", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    const waiting = waitSwarmBoard(boardPath, { viewer: "carol", timeoutSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await appendSwarmBoard(boardPath, "alice", "@carol 麻烦确认");
    const result = await waiting;
    expect(result.outcome).toBe("hit");
    expect(result.entries[0]?.text).toContain("@carol");
  });

  it("from 模式：指定成员新帖唤醒", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    const waiting = waitSwarmBoard(boardPath, { viewer: "carol", from: "alice", timeoutSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await appendSwarmBoard(boardPath, "bob", "别人的");
    await appendSwarmBoard(boardPath, "alice", "alice 的结论");
    const result = await waiting;
    expect(result.outcome).toBe("hit");
    expect(result.entries.map((entry) => entry.from)).toEqual(["alice"]);
  });

  it("from 模式：目标成员已终态且无新帖 → 提前返回 terminal，不等满超时", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await writeSwarmLifecycle(boardPath, "alice", "failed", "crash");
    const started = Date.now();
    const result = await waitSwarmBoard(boardPath, { viewer: "carol", from: "alice", timeoutSeconds: 30 });
    expect(result.outcome).toBe("terminal");
    expect(result.note).toContain("alice failed: crash");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("超时返回 timeout 与最新 offset", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    const result = await waitSwarmBoard(boardPath, { viewer: "carol", any: true, timeoutSeconds: 1 });
    expect(result.outcome).toBe("timeout");
    expect(result.note).toContain("timeout");
  });

  it("abort 信号立即返回 aborted", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    const controller = new AbortController();
    const waiting = waitSwarmBoard(boardPath, { viewer: "carol", any: true, timeoutSeconds: 30, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await waiting;
    expect(result.outcome).toBe("aborted");
  });

  it("watch 回落：板文件所在目录不存在时按轮询切片，发帖后仍命中", async () => {
    const root = await tempRoot("owc-swarm-board-");
    // 不建 subagents 目录：watch 打开失败 → 回落轮询
    const boardPath = path.join(root, "subagents", "swarm-missing-board.jsonl");
    const waiting = waitSwarmBoard(boardPath, { viewer: "carol", any: true, timeoutSeconds: 15 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await appendSwarmBoard(boardPath, "alice", "晚到的帖子");
    const result = await waiting;
    expect(result.outcome).toBe("hit");
    expect(result.entries[0]?.text).toBe("晚到的帖子");
  });

  it("since 之前的帖不唤醒", async () => {
    const root = await tempRoot("owc-swarm-board-");
    const boardPath = await boardIn(root);
    await appendSwarmBoard(boardPath, "alice", "旧帖");
    const read = await readSwarmBoard(boardPath);
    const result = await waitSwarmBoard(boardPath, { viewer: "carol", any: true, since: read.offset, timeoutSeconds: 1 });
    expect(result.outcome).toBe("timeout");
  });
});
