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

/** 独立临时板文件（swarmId 固定 test-swarm；目录由写入侧按需创建）。 */
async function newBoard(): Promise<string> {
  return swarmBoardPath(await tempRoot("owc-swarm-board-"), "test-swarm");
}

describe("行格式、系统贴与可见性", () => {
  it("append/read 回传 id/kind/to/priority/replyTo；旧行按 finding 缺省语义兼容", async () => {
    const board = await newBoard();
    await appendSwarmBoard(board, "alice", "发现鉴权绕过", { kind: "finding", priority: "high" });
    await appendSwarmBoard(board, "alice", "bob 看一下这个", { kind: "request", to: "bob", replyTo: "p_abc123" });
    const read = await readSwarmBoard(board);
    expect(read).toMatchObject({ offset: 2, total: 2 });
    expect(read.entries.map((entry) => entry.kind)).toEqual(["finding", "request"]);
    expect(read.entries[0]).toMatchObject({ from: "alice", priority: "high" });
    expect(read.entries[0]?.id).toMatch(/^p_[0-9a-f]{6}$/);
    expect(read.entries[1]).toMatchObject({ to: "bob", replyTo: "p_abc123" });
    // 旧行（无 id/kind，仅 {ts,from,text}）：读侧补临时序号，kind 过滤按 finding 缺省语义命中
    const legacy = await newBoard();
    await mkdir(path.dirname(legacy), { recursive: true });
    await appendFile(legacy, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", from: "old", text: "legacy" })}\n`, "utf8");
    expect((await readSwarmBoard(legacy)).entries[0]).toMatchObject({ id: "l1", from: "old", text: "legacy" });
    expect((await readSwarmBoard(legacy, { kind: "finding" })).entries).toHaveLength(1);
  });
  it("roster/lifecycle 系统贴解析进 members/memberStatus，不进内容流", async () => {
    const board = await newBoard();
    await writeSwarmRoster(board, ROSTER);
    await appendSwarmBoard(board, "alice", "hello");
    await writeSwarmLifecycle(board, "alice", "started");
    await writeSwarmLifecycle(board, "alice", "finished");
    await writeSwarmLifecycle(board, "bob", "failed", "boom");
    const read = await readSwarmBoard(board);
    expect(read.members).toHaveLength(3);
    expect(read.members[0]).toMatchObject({ member: "alice", role: "balanced", taskExcerpt: "审查 auth 模块" });
    expect(read.entries.filter((entry) => entry.kind !== "lifecycle").map((entry) => entry.from)).toEqual(["alice"]);
    expect(read.memberStatus.alice?.event).toBe("finished");
    expect(read.memberStatus.bob).toMatchObject({ event: "failed", reason: "boom" });
  });
  it("私聊仅收发双方可见、广播全员可见、无 viewer 不过滤；kind/from/to/mine 过滤", async () => {
    const board = await newBoard();
    await appendSwarmBoard(board, "alice", "广播", { kind: "finding" });
    await appendSwarmBoard(board, "alice", "只给 bob", { to: "bob" });
    await appendSwarmBoard(board, "bob", "回 alice", { to: "alice" });
    await appendSwarmBoard(board, "bob", "私聊问答", { kind: "question", to: "alice" });
    const texts = async (options: Parameters<typeof readSwarmBoard>[1] = {}): Promise<string[]> =>
      (await readSwarmBoard(board, { viewer: "alice", ...options })).entries.map((entry) => entry.text);
    // carol 只见广播；bob/alice 私有帖自己发/自己收均可见；无 viewer 不过滤
    expect((await readSwarmBoard(board, { viewer: "carol" })).entries.map((entry) => entry.text)).toEqual(["广播"]);
    expect((await readSwarmBoard(board, { viewer: "bob" })).entries.map((entry) => entry.text)).toEqual(["广播", "只给 bob", "回 alice", "私聊问答"]);
    expect(await texts()).toEqual(["广播", "只给 bob", "回 alice", "私聊问答"]);
    expect((await readSwarmBoard(board)).entries).toHaveLength(4);
    expect(await texts({ kind: "question" })).toEqual(["私聊问答"]);
    expect(await texts({ from: "bob" })).toEqual(["回 alice", "私聊问答"]);
    expect(await texts({ to: "alice" })).toEqual(["回 alice", "私聊问答"]);
    expect(await texts({ mine: true })).toEqual(["广播", "只给 bob", "回 alice", "私聊问答"]);
  });
});

describe("滚动聚合与 digest", () => {
  it("滚动聚合与 digest：旧段聚合+优先段、未超阈值全原文、分组统计与置顶段", async () => {
    const board = await newBoard();
    // 私聊与 @提及先发（落入旧段），再 45 轮 alice finding + bob progress 广播
    await appendSwarmBoard(board, "bob", "机密：只给 carol", { to: "carol" });
    await appendSwarmBoard(board, "bob", "@carol 看一下聚合边界", { kind: "request" });
    for (let index = 0; index < 45; index++) {
      await appendSwarmBoard(board, "alice", `finding ${index}`, { kind: "finding" });
      await appendSwarmBoard(board, "bob", `progress ${index}`, { kind: "progress" });
    }
    const read = await readSwarmBoard(board, { viewer: "carol" });
    // 新段原文封顶 50 条（92 - 50 = 42 条进旧段），旧段广播按成员+kind 聚合且不含私聊内容
    expect(read.total).toBe(92);
    expect(read.entries).toHaveLength(50);
    expect(read.aggregated.join("\n")).toContain("alice · finding ×20");
    expect(read.aggregated.join("\n")).not.toContain("机密");
    expect(read.priority.map((entry) => entry.text)).toEqual(["机密：只给 carol", "@carol 看一下聚合边界"]);
    const small = await newBoard();
    for (let index = 0; index < 10; index++) await appendSwarmBoard(small, "alice", `post ${index}`);
    const smallRead = await readSwarmBoard(small, { viewer: "bob" });
    expect(smallRead).toMatchObject({ aggregated: [], priority: [] });
    expect(smallRead.entries).toHaveLength(10);

    // digest：按 kind/成员分组统计，decision/blocker 置顶段列原文；空板返回 undefined
    const digestBoard = await newBoard();
    await writeSwarmRoster(digestBoard, ROSTER);
    await appendSwarmBoard(digestBoard, "alice", "普通发现", { kind: "finding" });
    await appendSwarmBoard(digestBoard, "bob", "决议：走方案 A", { kind: "decision" });
    await appendSwarmBoard(digestBoard, "carol", "阻塞：缺凭据", { kind: "blocker" });
    const digest = (await digestSwarmBoard(digestBoard)) ?? "";
    expect(digest).toContain("by kind: finding=1, decision=1, blocker=1");
    expect(digest).toContain("member posts: alice=1, bob=1, carol=1");
    expect(digest).toContain("Decisions:\n- [bob] 决议：走方案 A");
    expect(digest).toContain("Blockers:\n- [carol] 阻塞：缺凭据");
    expect(digest).toContain("Last entries:");
    expect(digest).not.toContain("#system"); // roster 系统贴不计入成员帖
    expect(await digestSwarmBoard(await newBoard())).toBeUndefined();
  });
});
describe("swarm_wait", () => {
  it("命中：@提及 / 私聊 / from 指定（目录不存在时轮询回落）；from 目标终态提前 terminal", async () => {
    // 不建 subagents 目录：watch 打开失败 → 回落轮询
    const board = path.join(await tempRoot("owc-swarm-board-"), "subagents", "swarm-missing-board.jsonl");
    const toMe = waitSwarmBoard(board, { viewer: "carol", timeoutSeconds: 10 });
    const fromAlice = waitSwarmBoard(board, { viewer: "carol", from: "alice", timeoutSeconds: 10 });
    await appendSwarmBoard(board, "dave", "别人的广播"); // 不唤醒 toMe
    await appendSwarmBoard(board, "alice", "@carol 麻烦确认");
    const [mentionHit, fromHit] = await Promise.all([toMe, fromAlice]);
    expect(mentionHit.outcome).toBe("hit");
    expect(mentionHit.entries.map((entry) => entry.text)).toEqual(["@carol 麻烦确认"]);
    expect(fromHit.outcome).toBe("hit");
    expect(fromHit.entries.map((entry) => entry.from)).toEqual(["alice"]);

    const privateHit = waitSwarmBoard(board, { viewer: "carol", timeoutSeconds: 10 });
    await appendSwarmBoard(board, "bob", "carol 收", { to: "carol" });
    const received = await privateHit;
    expect(received.outcome).toBe("hit");
    expect(received.entries.map((entry) => entry.text)).toEqual(["carol 收"]);

    // from 模式：目标成员已终态且无新帖 → 提前返回 terminal，不等满超时
    const dead = await newBoard();
    await writeSwarmLifecycle(dead, "alice", "failed", "crash");
    const started = Date.now();
    const terminal = await waitSwarmBoard(dead, { viewer: "carol", from: "alice", timeoutSeconds: 30 });
    expect(terminal.outcome).toBe("terminal");
    expect(terminal.note).toContain("alice failed: crash");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("超时返回 timeout 与最新 offset；since 之前的帖不唤醒；abort 立即返回 aborted", async () => {
    const board = await newBoard();
    await appendSwarmBoard(board, "alice", "旧帖");
    const read = await readSwarmBoard(board);
    const stale = await waitSwarmBoard(board, { viewer: "carol", any: true, since: read.offset, timeoutSeconds: 1 });
    expect(stale).toMatchObject({ outcome: "timeout", offset: read.offset });
    expect(stale.note).toContain("timeout");
    const controller = new AbortController();
    const waiting = waitSwarmBoard(board, { viewer: "carol", any: true, timeoutSeconds: 30, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect((await waiting).outcome).toBe("aborted");
  }, 20_000);
});
