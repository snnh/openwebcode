import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { UsageLog, type UsageEventRecord } from "../src/usage-log.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-usage-"));
  roots.push(root);
  return root;
}

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
    const log = new UsageLog(await tempDir());
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
    const log = new UsageLog(await tempDir());
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
    const root = await tempDir();
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
    const root = await tempDir();
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
    const root = await tempDir();
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
