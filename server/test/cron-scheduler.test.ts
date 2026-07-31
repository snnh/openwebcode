import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_MAX_JOBS_PER_SESSION, CronScheduler, nextCronFire, parseCronExpression } from "../src/cron-scheduler.js";
import { MessageQueue } from "../src/agent/message-queue.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 本地时区固定基准：2026-07-30 10:00:00（周四）。 */
const T0 = new Date(2026, 6, 30, 10, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface FireRecord {
  sessionId: string;
  prompt: string;
  stale: boolean;
}

/** autoSchedule=false + 注入时钟的测试调度器；fires 记录每次触发。 */
function makeScheduler(file: string, now: () => number, fires: FireRecord[]): CronScheduler {
  return new CronScheduler({
    file,
    now,
    autoSchedule: false,
    fire: (sessionId, prompt, meta) => {
      fires.push({ sessionId, prompt, stale: meta.stale });
    },
    onError: (error) => {
      throw error;
    },
  });
}

describe("parseCronExpression", () => {
  it("接受合法各形态：star / star-n / 范围 / 列表 / 单值 / 带步长范围", () => {
    const every = parseCronExpression("* * * * *");
    expect(every.minute).toHaveLength(60);
    expect(every.domAny).toBe(true);
    expect(every.dowAny).toBe(true);

    expect(parseCronExpression("*/5 * * * *").minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(parseCronExpression("0 9 * * 1-5").dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCronExpression("0 9 1,15 * *").dayOfMonth).toEqual([1, 15]);
    expect(parseCronExpression("30 14 1 6 0").month).toEqual([6]);
    expect(parseCronExpression("0 9-17/2 * * *").hour).toEqual([9, 11, 13, 15, 17]);
    // `a/n` 等价 `a-max/n`（标准语义）
    expect(parseCronExpression("10/20 * * * *").minute).toEqual([10, 30, 50]);
  });

  it("day-of-week 的 7 归一为 0（周日）", () => {
    expect(parseCronExpression("0 9 * * 7").dayOfWeek).toEqual([0]);
    expect(parseCronExpression("0 9 * * 0,7").dayOfWeek).toEqual([0]);
  });

  it("拒绝非法表达式并给出可读错误", () => {
    expect(() => parseCronExpression("* * * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCronExpression("* * * * * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCronExpression("61 * * * *")).toThrow(/out of range 0-59/);
    expect(() => parseCronExpression("* 25 * * *")).toThrow(/out of range 0-23/);
    expect(() => parseCronExpression("* * 0 * *")).toThrow(/out of range 1-31/);
    expect(() => parseCronExpression("* * * 13 *")).toThrow(/out of range 1-12/);
    expect(() => parseCronExpression("a * * * *")).toThrow(/Invalid cron minute value/);
    expect(() => parseCronExpression("*/0 * * * *")).toThrow(/Invalid cron minute step/);
    expect(() => parseCronExpression("5-1 * * * *")).toThrow(/start > end/);
    expect(() => parseCronExpression("1/2/3 * * * *")).toThrow(/too many "\/"/);
    expect(() => parseCronExpression("1,,2 * * * *")).toThrow(/empty list item/);
  });
});

describe("nextCronFire（本地时区）", () => {
  it("每天 09:00：当天未到取当天，已过取次日", () => {
    const fields = parseCronExpression("0 9 * * *");
    expect(nextCronFire(fields, new Date(2026, 6, 30, 8, 30).getTime())).toBe(new Date(2026, 6, 30, 9, 0).getTime());
    expect(nextCronFire(fields, new Date(2026, 6, 30, 9, 0).getTime())).toBe(new Date(2026, 6, 31, 9, 0).getTime());
  });

  it("每 15 分钟：取下一刻钟点", () => {
    const fields = parseCronExpression("*/15 * * * *");
    expect(nextCronFire(fields, new Date(2026, 6, 30, 10, 7).getTime())).toBe(new Date(2026, 6, 30, 10, 15).getTime());
    expect(nextCronFire(fields, new Date(2026, 6, 30, 10, 15).getTime())).toBe(new Date(2026, 6, 30, 10, 30).getTime());
  });

  it("日/周都受限时取或（标准 cron 语义）", () => {
    // 每月 13 号 或 每周五 的 00:00；2026-07-30 是周四 → 下一天周五 07-31
    const fields = parseCronExpression("0 0 13 * 5");
    expect(nextCronFire(fields, new Date(2026, 6, 30, 10, 0).getTime())).toBe(new Date(2026, 6, 31, 0, 0).getTime());
  });

  it("跨月/跨年与不可达表达式", () => {
    expect(nextCronFire(parseCronExpression("0 0 1 1 *"), new Date(2026, 6, 30).getTime())).toBe(new Date(2027, 0, 1, 0, 0).getTime());
    // 2 月 31 日永不触发
    expect(nextCronFire(parseCronExpression("0 0 31 2 *"), T0)).toBeNull();
  });
});

describe("CronScheduler", () => {
  it("fire 经回调注入 follow-up 队列并标记 source:cron（随 queue.json 持久化）", async () => {
    const dir = await tempRoot("owc-cron-");
    const queue = new MessageQueue(() => dir);
    let nowMs = T0;
    const scheduler = new CronScheduler({
      file: path.join(dir, "cron.json"),
      now: () => nowMs,
      autoSchedule: false,
      fire: (sessionId, prompt) => queue.enqueue(sessionId, "follow_up", `[cron] ${prompt}`, undefined, "cron"),
    });

    await scheduler.create("s1", { cron: "*/30 * * * *", prompt: "检查构建状态" });
    nowMs = T0 + 31 * MINUTE;
    await scheduler.check();

    const items = await queue.list("s1", "follow_up");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ content: "[cron] 检查构建状态", status: "queued", source: "cron" });
    // 新实例读取旧文件：source 字段随持久化保留
    expect((await new MessageQueue(() => dir).list("s1", "follow_up"))[0]).toMatchObject({ source: "cron" });
  });

  it("coalesce：错过多个理想触发点只补一次", async () => {
    const dir = await tempRoot("owc-cron-");
    const fires: FireRecord[] = [];
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, fires);

    await scheduler.create("s1", { cron: "*/30 * * * *", prompt: "心跳" });
    nowMs = T0 + 5 * HOUR; // 错过 10 个触发点
    await scheduler.check();
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ stale: false });
    // 再次 check 不重复触发（lastFiredAt 已推进）
    await scheduler.check();
    expect(fires).toHaveLength(1);
  });

  it("one-shot 触发一次后自动删除", async () => {
    const dir = await tempRoot("owc-cron-");
    const fires: FireRecord[] = [];
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, fires);

    await scheduler.create("s1", { cron: "45 10 * * *", prompt: "一次性提醒", recurring: false });
    nowMs = T0 + 50 * MINUTE;
    await scheduler.check();
    expect(fires).toHaveLength(1);
    expect(await scheduler.list("s1")).toHaveLength(0);

    nowMs = T0 + DAY;
    await scheduler.check();
    expect(fires).toHaveLength(1);
  });

  it("recurring 7 天到期：stale 触发最后一次并自动删除", async () => {
    const dir = await tempRoot("owc-cron-");
    const fires: FireRecord[] = [];
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, fires);

    await scheduler.create("s1", { cron: "0 9 * * *", prompt: "日报" });
    // 保留期内正常触发（次日 09:00）
    nowMs = T0 + DAY;
    await scheduler.check();
    expect(fires).toEqual([{ sessionId: "s1", prompt: "日报", stale: false }]);
    // 跳到 7 天保留期之后
    nowMs = T0 + 8 * DAY;
    await scheduler.check();
    expect(fires).toHaveLength(2);
    expect(fires[1]).toMatchObject({ stale: true });
    expect(await scheduler.list("s1")).toHaveLength(0);
  });

  it("list 视图：nextFireAt 与 stale 标记", async () => {
    const dir = await tempRoot("owc-cron-");
    let nowMs = T0;
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => nowMs, []);

    const created = await scheduler.create("s1", { cron: "0 9 * * *", prompt: "日报" });
    expect(created.nextFireAt).toBe(new Date(2026, 6, 31, 9, 0).toISOString());
    expect(created.stale).toBe(false);

    // 到期前最后一次触发点被钳到保留期到期点
    nowMs = T0 + 6 * DAY + 12 * HOUR;
    const [nearExpiry] = await scheduler.list("s1");
    expect(nearExpiry?.stale).toBe(false);
    expect(Date.parse(nearExpiry!.nextFireAt!)).toBeLessThanOrEqual(T0 + 7 * DAY);

    nowMs = T0 + 7 * DAY + MINUTE;
    const [expired] = await scheduler.list("s1");
    expect(expired?.stale).toBe(true);
    expect(expired?.nextFireAt).toBeNull();
  });

  it("每会话上限 50 条", async () => {
    const dir = await tempRoot("owc-cron-");
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => T0, []);
    for (let index = 0; index < CRON_MAX_JOBS_PER_SESSION; index += 1) {
      await scheduler.create("s1", { cron: "0 9 * * *", prompt: `任务 ${index}` });
    }
    await expect(scheduler.create("s1", { cron: "0 9 * * *", prompt: "溢出" })).rejects.toThrow(/limit reached/);
    // 其他会话不受牵连
    await scheduler.create("s2", { cron: "0 9 * * *", prompt: "别的会话" });
    expect(await scheduler.list("s2")).toHaveLength(1);
  });

  it("创建时拒绝非法表达式与空提示词", async () => {
    const dir = await tempRoot("owc-cron-");
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => T0, []);
    await expect(scheduler.create("s1", { cron: "61 * * * *", prompt: "x" })).rejects.toThrow(/out of range/);
    await expect(scheduler.create("s1", { cron: "0 9 * * *", prompt: "  " })).rejects.toThrow(/non-empty prompt/);
    await expect(scheduler.create("s1", { cron: "0 0 31 2 *", prompt: "x" })).rejects.toThrow(/no fire time/);
  });

  it("delete 与 deleteForSession 级联", async () => {
    const dir = await tempRoot("owc-cron-");
    const scheduler = makeScheduler(path.join(dir, "cron.json"), () => T0, []);
    const a = await scheduler.create("s1", { cron: "0 9 * * *", prompt: "a" });
    await scheduler.create("s1", { cron: "0 10 * * *", prompt: "b" });
    await scheduler.create("s2", { cron: "0 9 * * *", prompt: "c" });

    expect(await scheduler.delete("s1", a.id)).toBe(true);
    expect(await scheduler.delete("s1", a.id)).toBe(false);
    expect(await scheduler.list("s1")).toHaveLength(1);

    await scheduler.deleteForSession("s1");
    expect(await scheduler.list("s1")).toHaveLength(0);
    expect(await scheduler.list("s2")).toHaveLength(1);
  });

  it("重启恢复：重建调度器读 cron.json，停机期间错过的触发 coalesce 补一次", async () => {
    const dir = await tempRoot("owc-cron-");
    const file = path.join(dir, "cron.json");
    let nowMs = T0;
    const first = makeScheduler(file, () => nowMs, []);
    await first.create("s1", { cron: "*/30 * * * *", prompt: "周期任务" });
    await first.create("s1", { cron: "45 10 * * *", prompt: "一次性", recurring: false });
    first.stop();

    // “重启”：时钟前进 5 小时，新实例 load 立即 check
    nowMs = T0 + 5 * HOUR;
    const fires: FireRecord[] = [];
    const restored = makeScheduler(file, () => nowMs, fires);
    await restored.load();

    // 周期任务错过 10 个点只补一次；一次性任务补发后删除
    expect(fires).toHaveLength(2);
    const remaining = await restored.list("s1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ prompt: "周期任务", recurring: true });
  });
});
