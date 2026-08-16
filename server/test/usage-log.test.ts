import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { applyCacheSavings, MAX_CACHED_REPORTS, UsageLog, type UsageEventRecord } from "../src/usage-log.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 用本地时间构造，保证报表的本地日期分桶与测试环境时区无关。 */
function eventAt(local: Date, overrides: Partial<UsageEventRecord> = {}): UsageEventRecord {
  return {
    at: local.toISOString(),
    sessionId: "s1",
    provider: "openai",
    model: "gpt-x",
    inputTokens: 100,
    outputTokens: 50,
    cacheRead: 10,
    cacheWrite: 5,
    priced: true,
    usdMicroUnits: "1000",
    cnyMicroUnits: "7200",
    ...overrides,
  };
}

describe("usage log cost report", () => {
  it("aggregates per-day, per-session and per-provider breakdowns", async () => {
    const log = new UsageLog(await tempRoot("owc-usage-"));
    const day1 = new Date(2026, 6, 10, 9, 0, 0);
    const day2 = new Date(2026, 6, 11, 9, 0, 0);
    await log.record(eventAt(day1));
    await log.record(eventAt(day1, { sessionId: "s2", inputTokens: 200, usdMicroUnits: "2000", cnyMicroUnits: "14400" }));
    await log.record(eventAt(day2, { provider: "anthropic", model: "claude-y" }));
    await log.record(eventAt(day2, { priced: false, usdMicroUnits: undefined, cnyMicroUnits: undefined }));

    const report = await log.report();
    expect(report.totals.runs).toBe(4);
    expect(report.totals.inputTokens).toBe(500);
    expect(report.totals.usdMicroUnits).toBe("4000");
    expect(report.totals.cnyMicroUnits).toBe("28800");
    expect(report.totals.unpricedTokens).toBe(165);

    const pad = (value: number) => String(value).padStart(2, "0");
    const day1Key = `${day1.getFullYear()}-${pad(day1.getMonth() + 1)}-${pad(day1.getDate())}`;
    const day2Key = `${day2.getFullYear()}-${pad(day2.getMonth() + 1)}-${pad(day2.getDate())}`;
    expect(report.days.map((row) => row.date)).toEqual([day2Key, day1Key]);
    const day2Row = report.days[0]!;
    expect(day2Row.runs).toBe(2);
    expect(day2Row.cacheRead).toBe(20);
    expect(day2Row.cacheWrite).toBe(10);
    expect(day2Row.providers.map((row) => `${row.provider}/${row.model}`).sort())
      .toEqual(["anthropic/claude-y", "openai/gpt-x"]);

    const s1 = report.sessions.find((row) => row.sessionId === "s1")!;
    expect(s1.runs).toBe(3);
    expect(s1.providers.map((row) => row.provider).sort()).toEqual(["anthropic", "openai"]);
    expect(report.sessions.find((row) => row.sessionId === "s2")?.usdMicroUnits).toBe("2000");
  });

  it("filters by inclusive local date range", async () => {
    const log = new UsageLog(await tempRoot("owc-usage-"));
    const inside = new Date(2026, 6, 10, 12, 0, 0);
    const outside = new Date(2026, 6, 20, 12, 0, 0);
    await log.record(eventAt(inside));
    await log.record(eventAt(outside));
    const pad = (value: number) => String(value).padStart(2, "0");
    const key = `${inside.getFullYear()}-${pad(inside.getMonth() + 1)}-${pad(inside.getDate())}`;

    const report = await log.report({ from: key, to: key });
    expect(report.totals.runs).toBe(1);
    expect(report.days.map((row) => row.date)).toEqual([key]);
    expect(report.from).toBe(key);
    expect(report.to).toBe(key);
  });

  it("skips corrupt lines and returns an empty report without a file", async () => {
    const root = await tempRoot("owc-usage-");
    const missing = new UsageLog(path.join(root, "nothing"));
    const empty = await missing.report();
    expect(empty.totals.runs).toBe(0);
    expect(empty.days).toEqual([]);

    const log = new UsageLog(root);
    await log.record(eventAt(new Date(2026, 6, 10, 9, 0, 0)));
    await appendFile(path.join(root, "usage-events.jsonl"), "{\"broken\":true}\nnot-json\n", "utf8");
    const report = await log.report();
    expect(report.totals.runs).toBe(1);
  });

  it("keeps recording after a transient write failure", async () => {
    const root = await tempRoot("owc-usage-");
    const blocker = path.join(root, "blocked");
    // 用文件占据数据目录路径，使第一次 appendFile 必失败（ENOTDIR）
    await writeFile(blocker, "x", "utf8");
    const log = new UsageLog(blocker);
    await expect(log.record(eventAt(new Date(2026, 6, 9, 9, 0, 0)))).rejects.toThrow();

    await rm(blocker);
    await log.record(eventAt(new Date(2026, 6, 10, 9, 0, 0)));
    expect(await log.readAll()).toHaveLength(1);
  });

  it("serves the report over HTTP with session titles and currency preference", async () => {
    const root = await tempRoot("owc-usage-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "model-pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const core = new CoreClient(path.join(root, "unused-core"));
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const usageLog = new UsageLog(root);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, usageLog, defaultCurrency: "USD" });
    try {
      const created = await sessions.create({ cwd: os.tmpdir(), title: "报表样例" });
      await usageLog.record(eventAt(new Date(2026, 6, 10, 9, 0, 0), { sessionId: created.id }));
      await usageLog.record(eventAt(new Date(2026, 6, 10, 10, 0, 0), { sessionId: "deleted-session" }));

      const ok = await app.inject({ method: "GET", url: "/api/reports/cost" });
      expect(ok.statusCode).toBe(200);
      const body = ok.json<{ sessions: Array<{ sessionId: string; title?: string }>; preferences: { currency: string } }>();
      expect(body.preferences.currency).toBe("USD");
      expect(body.sessions.find((row) => row.sessionId === created.id)?.title).toBe("报表样例");
      expect(body.sessions.find((row) => row.sessionId === "deleted-session")?.title).toBeUndefined();

      const bad = await app.inject({ method: "GET", url: "/api/reports/cost?from=2026-7-1" });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("applyCacheSavings 缓存节省后处理", () => {
  // 定价目录单位为「micro/百万 tokens」：input $2/1M、cacheRead $0.2/1M
  const usdPricing = { currency: "USD" as const, input: 2_000_000n, output: 8_000_000n, cacheRead: 200_000n, cacheWrite: 1_000_000n };

  async function makeReport(events: UsageEventRecord[]) {
    const log = new UsageLog(await tempRoot("owc-usage-"));
    for (const event of events) await log.record(event);
    return log.report();
  }

  it("有定价的行与 totals 产出双币种节省；无定价标记 incomplete 且不计入", async () => {
    const report = await makeReport([
      eventAt(new Date(2026, 6, 10, 9)),                                    // openai/gpt-x cacheRead 10
      eventAt(new Date(2026, 6, 10, 10), { provider: "ghost", model: "no-price" }),
    ]);
    const lookup = (provider: string, model: string) =>
      provider === "openai" && model === "gpt-x" ? usdPricing : undefined;
    const enriched = applyCacheSavings(report, lookup);

    const row = enriched.days[0]!.providers.find((item) => item.provider === "openai")!;
    // 10 tokens × (2 − 0.2) $/1M = 18 micro USD；无汇率 → 仅 USD 可得
    expect(row.cacheSavings).toEqual({ usdMicroUnits: "18" });
    expect(row.cacheSavingsIncomplete).toBeUndefined();
    const ghost = enriched.days[0]!.providers.find((item) => item.provider === "ghost")!;
    expect(ghost.cacheSavings).toBeUndefined();
    expect(ghost.cacheSavingsIncomplete).toBe(true);
    // totals 汇总（双币种键都在，CNY 为 0——无汇率时 CNY 不可得，差值按可得币种填）
    expect(enriched.totals.cacheSavings?.usdMicroUnits).toBe("18");
    expect(enriched.totals.cacheSavingsIncomplete).toBe(true);
    // 会话分桶同样带行级节省
    const sessionRow = enriched.sessions[0]!.providers.find((item) => item.provider === "openai")!;
    expect(sessionRow.cacheSavings).toEqual({ usdMicroUnits: "18" });
  });

  it("边界：cacheRead 为 0 不产出也不标记 incomplete；缓存价高于输入价的错配定价按 0 clamp", async () => {
    const zero = applyCacheSavings(await makeReport([eventAt(new Date(2026, 6, 10, 9), { cacheRead: 0 })]), () => undefined);
    expect(zero.days[0]!.providers[0]!.cacheSavings).toBeUndefined();
    expect(zero.days[0]!.providers[0]!.cacheSavingsIncomplete).toBeUndefined();
    expect(zero.totals.cacheSavingsIncomplete).toBeUndefined();

    const weird = { currency: "USD" as const, input: 1_000_000n, output: 8_000_000n, cacheRead: 5_000_000n, cacheWrite: 5_000_000n };
    const clamped = applyCacheSavings(await makeReport([eventAt(new Date(2026, 6, 10, 9))]), () => weird);
    expect(clamped.days[0]!.providers[0]!.cacheSavings).toEqual({ usdMicroUnits: "0" });
  });

  it("CNY 定价无汇率服务时产出 CNY 节省", async () => {
    const report = await makeReport([eventAt(new Date(2026, 6, 10, 9))]);
    const cnyPricing = { currency: "CNY" as const, input: 14_000_000n, output: 56_000_000n, cacheRead: 7_000_000n, cacheWrite: 35_000_000n };
    const enriched = applyCacheSavings(report, () => cnyPricing);
    // 10 × (14 − 7) = 70 micro CNY
    expect(enriched.days[0]!.providers[0]!.cacheSavings).toEqual({ cnyMicroUnits: "70" });
  });
});

describe("报表聚合缓存 LRU 上限", () => {
  type CacheHolder = { reportCache: Map<string, unknown> };
  const cacheOf = (log: UsageLog): Map<string, unknown> => (log as unknown as CacheHolder).reportCache;

  it("相异区间超过上限淘汰最旧；命中刷新热度", async () => {
    const log = new UsageLog(await tempRoot("owc-usage-"));
    await log.record(eventAt(new Date(2026, 6, 10, 9)));
    // 9 个相异区间（上限 8）：最早的 "2026-07-012026-07-01" 被淘汰
    for (let day = 1; day <= 9; day += 1) {
      const key = `2026-07-${String(day).padStart(2, "0")}`;
      await log.report({ from: key, to: key });
    }
    expect(cacheOf(log).size).toBe(MAX_CACHED_REPORTS);
    expect(cacheOf(log).has("2026-07-012026-07-01")).toBe(false);
    // 命中刷新热度：再访问现存最旧的 "02"，再新增一个区间，"02" 不被淘汰、"03" 淘汰
    await log.report({ from: "2026-07-02", to: "2026-07-02" });
    await log.report({ from: "2026-07-10", to: "2026-07-10" });
    expect(cacheOf(log).size).toBe(MAX_CACHED_REPORTS);
    expect(cacheOf(log).has("2026-07-022026-07-02")).toBe(true);
    expect(cacheOf(log).has("2026-07-032026-07-03")).toBe(false);
  });
});

describe("usage log cleanup (prune)", () => {
  /** 造一批事件：两会话 × 新旧两天；live 会话目录真实存在，deleted 会话目录不存在。 */
  async function fixture() {
    const root = await tempRoot("owc-usage-prune-");
    const log = new UsageLog(root);
    // 会话目录：s1 存在（未删除），s2 不存在（已删除）
    await mkdir(path.join(root, "sessions", "s1"), { recursive: true });
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await log.record(eventAt(new Date(), { sessionId: "s1" }));
    await log.record(eventAt(new Date(daysAgo(30)), { sessionId: "s1" }));
    await log.record(eventAt(new Date(), { sessionId: "s2" }));
    await log.record(eventAt(new Date(daysAgo(30)), { sessionId: "s2" }));
    return { root, log };
  }

  it("off 模式不清理任何事件", async () => {
    const { log } = await fixture();
    const removed = await log.prune({ mode: "off", retentionDays: 7 });
    expect(removed).toBe(0);
    expect(await log.readAll()).toHaveLength(4);
  });

  it("deleted-after-days：仅清理已删除会话超过保留天数的旧事件", async () => {
    const { log } = await fixture();
    const removed = await log.prune({ mode: "deleted-after-days", retentionDays: 7 });
    expect(removed).toBe(1); // s2 的 30 天前事件
    const kept = await log.readAll();
    // 保留：s1 今天、s1 30 天前（未删除会话不按时间清）、s2 今天（已删除但未超时）
    expect(kept.map((event) => event.sessionId).sort()).toEqual(["s1", "s1", "s2"]);
    expect(kept.find((event) => event.sessionId === "s2")!.at.slice(0, 10))
      .toBe(new Date().toISOString().slice(0, 10));
  });

  it("all-after-days：所有会话超过保留天数的事件都清理", async () => {
    const { log } = await fixture();
    const removed = await log.prune({ mode: "all-after-days", retentionDays: 7 });
    expect(removed).toBe(2); // s1、s2 各一条 30 天前
    const kept = await log.readAll();
    expect(kept).toHaveLength(2);
    for (const event of kept) expect(event.sessionId).toBeDefined();
  });

  it("deleted-immediate-live-timeout：已删除会话立即清理，未删除超时清理", async () => {
    const { log } = await fixture();
    const removed = await log.prune({ mode: "deleted-immediate-live-timeout", retentionDays: 7 });
    expect(removed).toBe(3); // s2 两条立即全清 + s1 的 30 天前超时清理
    // 精确断言：只保留 s1 今天
    const kept = await log.readAll();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.sessionId).toBe("s1");
  });

  it("deleted-immediate-only：已删除会话立即清理，未删除全部保留", async () => {
    const { log } = await fixture();
    const removed = await log.prune({ mode: "deleted-immediate-only", retentionDays: 7 });
    expect(removed).toBe(2); // s2 两条全部清理
    const kept = await log.readAll();
    expect(kept.map((event) => event.sessionId)).toEqual(["s1", "s1"]);
  });

  it("自定义 sessionExists 判定可注入（默认按 <dataDir>/sessions/<id> 目录）", async () => {
    const { log, root } = await fixture();
    // 删除 s1 目录后默认判定变为"已删除"
    await rm(path.join(root, "sessions", "s1"), { recursive: true, force: true });
    const removed = await log.prune({ mode: "deleted-immediate-only", retentionDays: 7 });
    expect(removed).toBe(4); // 两会话现在都视为已删除
  });
});
