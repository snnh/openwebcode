import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManager, selectCacheBreakpoints } from "../src/context/context-manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ContextManager cost ledger", () => {
  it("upgrades a version-one token-only ledger", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-ledger-"));
    roots.push(root);
    await writeFile(path.join(root, "ledger.json"), JSON.stringify({
      version: 1,
      round: 2,
      policy: { enabled: true, strategy: "lag", lag: 1, interval: 5, pinExemptRounds: 5, restoreBudget: 20_000 },
      entries: [],
      usage: { inputTokens: 7, outputTokens: 2, cacheRead: 5, cacheWrite: 3 },
    }));

    const ledger = await new ContextManager(root).load();
    expect(ledger.usage.inputTokens).toBe(7);
    expect(ledger.cost).toEqual({
      usdMicroUnits: "0",
      cnyMicroUnits: "0",
      unpricedTokens: 0,
      unavailableUsdTokens: 0,
      unavailableCnyTokens: 0,
    });
  });

  it("pauses a hard currency budget when prior usage cannot be priced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-budget-"));
    roots.push(root);
    const manager = new ContextManager(root);
    await manager.recordUsage({ inputTokens: 10, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, { priced: false });
    await manager.setBudget(undefined, { currency: "USD", microUnits: "1000000" });

    const status = await manager.budgetStatus();
    expect(status.paused).toBe(true);
    expect(status.cost.reason).toBe("cost_unavailable");
  });

  it("merges concurrent partial budget updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-concurrent-budget-"));
    roots.push(root);
    const left = new ContextManager(root);
    const right = new ContextManager(root);
    await Promise.all([
      left.updateBudget({ maxSessionTokens: 100 }),
      right.updateBudget({ maxSessionCost: { currency: "CNY", microUnits: "2000000" } }),
    ]);
    const ledger = await left.load();
    expect(ledger.policy.maxSessionTokens).toBe(100);
    expect(ledger.policy.maxSessionCost).toEqual({ currency: "CNY", microUnits: "2000000" });
  });

  it("serializes round and usage writes for one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-round-usage-"));
    roots.push(root);
    const manager = new ContextManager(root);
    await Promise.all([
      manager.advanceRound(),
      manager.recordUsage(
        { inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
        { priced: true, usdMicroUnits: "5", cnyMicroUnits: "35" },
      ),
    ]);
    const ledger = await manager.load();
    expect(ledger.round).toBe(1);
    expect(ledger.usage.inputTokens).toBe(1);
  });

  it("serializes concurrent usage updates for one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-concurrent-cost-"));
    roots.push(root);
    const left = new ContextManager(root);
    const right = new ContextManager(root);
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? left : right).recordUsage(
        { inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
        { priced: true, usdMicroUnits: "5", cnyMicroUnits: "35" },
      )));
    const ledger = await left.load();
    expect(ledger.usage.inputTokens).toBe(20);
    // 精确整数累计（35 对浮点不友好，足以暴露 drift）
    expect(ledger.cost.usdMicroUnits).toBe("100");
    expect(ledger.cost.cnyMicroUnits).toBe("700");
  });

  it("selects and persists stable cache breakpoints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-cache-breakpoints-"));
    roots.push(root);
    const manager = new ContextManager(root);
    const messages = [
      { id: "user-1", role: "user" as const, content: [{ type: "text" as const, text: "one" }], createdAt: "2026-01-01T00:00:00Z" },
      { id: "tool-1", role: "tool" as const, content: [{ type: "tool_result" as const, toolCallId: "x", content: "result", isError: false }], createdAt: "2026-01-01T00:00:01Z" },
      { id: "user-2", role: "user" as const, content: [{ type: "text" as const, text: "two" }], createdAt: "2026-01-01T00:00:02Z" },
    ];
    const ledger = await manager.load();
    ledger.entries.push({ messageId: "tool-1", kind: "tool_result", artifactId: "artifact-00000000-0000-0000-0000-000000000000", state: "evicted", createdRound: 0, pinnedUntilRound: 0 });
    const selected = selectCacheBreakpoints(messages, ledger);
    expect(selected).toEqual(["tool-1", "user-1"]);
    expect((await manager.recordCacheBreakpoints(selected)).cacheBreakpoints).toEqual(selected);
    expect((await manager.load()).cacheBreakpoints).toEqual(selected);
  });
});
