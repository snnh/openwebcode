import { describe, expect, it } from "vitest";
import { MemoryBudget, type MemoryBudgetConfig, type MemoryBudgetState } from "../src/memory-budget.js";

function harness(totalMB: number, config: Partial<MemoryBudgetConfig> = {}) {
  let now = 1_000_000;
  let total = totalMB;
  const effective: MemoryBudgetConfig = { enabled: true, budgetMB: 100, runtimeMode: "balanced", ...config };
  const calls = { sweep: 0, compress: 0, gc: 0, concurrency: [] as number[], states: [] as MemoryBudgetState[] };
  const budget = new MemoryBudget({
    config: () => effective,
    totalMB: async () => total,
    sweep: () => { calls.sweep += 1; },
    compress: () => { calls.compress += 1; },
    gc: () => { calls.gc += 1; },
    setExecConcurrency: (value) => { calls.concurrency.push(value); },
    restoreConcurrency: () => 2,
    onState: (state) => { calls.states.push(state); },
    now: () => now,
  });
  return {
    budget,
    calls,
    config: effective,
    setTotal: (value: number) => { total = value; },
    advance: (ms: number) => { now += ms; },
  };
}

describe("进阶内存上限分级压缩", () => {
  it("关闭时不采样、不压缩、不广播", async () => {
    const { budget, calls } = harness(200, { enabled: false });
    await budget.evaluate();
    expect(calls).toMatchObject({ sweep: 0, compress: 0, gc: 0, states: [] });
    expect(budget.state()).toMatchObject({ enabled: false, level: 0, compressed: false, totalMB: null });
  });

  it("一级只扫缓存 + GC；30 秒后仍超限才进入二级全量压缩并降并发", async () => {
    const { budget, calls, advance } = harness(120);
    await budget.evaluate();
    expect(calls).toMatchObject({ sweep: 1, compress: 0, gc: 1, concurrency: [] });
    expect(budget.state()).toMatchObject({ level: 1, compressed: true, totalMB: 120 });

    await budget.evaluate();
    expect(calls).toMatchObject({ sweep: 1, compress: 0, gc: 1, concurrency: [] });

    advance(30_001);
    await budget.evaluate();
    expect(calls).toMatchObject({ sweep: 1, compress: 1, gc: 2, concurrency: [1] });
    expect(budget.state()).toMatchObject({ level: 2, compressed: true });
  });

  it("低于上限 90% 时恢复模式并发并退出压缩状态", async () => {
    const { budget, calls, setTotal } = harness(120);
    await budget.evaluate();
    setTotal(85);
    await budget.evaluate();
    expect(calls.concurrency).toEqual([2]);
    expect(budget.state()).toMatchObject({ level: 0, compressed: false, totalMB: 85 });
    expect(calls.compress).toBe(0);
  });

  it("RSS 不可用（null）时只广播状态，不误触发压缩", async () => {
    let total: number | null = null;
    const states: MemoryBudgetState[] = [];
    const budget = new MemoryBudget({
      config: () => ({ enabled: true, budgetMB: 100, runtimeMode: "balanced" }),
      totalMB: async () => total,
      sweep: () => { throw new Error("must not sweep"); },
      compress: () => { throw new Error("must not compress"); },
      gc: () => { throw new Error("must not gc"); },
      setExecConcurrency: () => undefined,
      restoreConcurrency: () => 2,
      onState: (state) => { states.push(state); },
    });
    await budget.evaluate();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ totalMB: null, level: 0 });
    total = 85;
    await budget.evaluate();
    expect(states.at(-1)).toMatchObject({ totalMB: 85, level: 0 });
  });
});
