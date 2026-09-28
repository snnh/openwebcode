import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { maybeGc, resolveGc } from "../src/gc-utils.js";

/**
 * gc-utils 的关键风险不是「有 --expose-gc 时能不能调 gc」，而是「没有 --expose-gc 时
 * （Windows launcher packaging/owc.cmd 未注入 NODE_OPTIONS）兜底是否成立」——因此核心
 * 用例放在不带该 flag 的子进程里，验证 v8.setFlagsFromString + vm.runInNewContext("gc")
 * 这条运行时路径确实能拿到 gc 函数。
 */
describe("gc-utils 兜底注入", () => {
  it("不带 --expose-gc 的子进程可经运行时 flag 注入取到 gc", () => {
    const script = [
      'const v8 = require("node:v8");',
      'const vm = require("node:vm");',
      'if (typeof globalThis.gc !== "undefined") throw new Error("子进程意外带上了 --expose-gc");',
      "const before = typeof globalThis.gc;",
      'v8.setFlagsFromString("--expose-gc");',
      'const gc = vm.runInNewContext("gc");',
      'if (typeof gc !== "function") throw new Error("运行时注入 flag 后仍拿不到 gc");',
      "gc();",
      'console.log(JSON.stringify({ before, after: typeof gc }));',
    ].join("\n");
    const stdout = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      // 清掉 NODE_OPTIONS：CI 上 install.sh 会注入 --expose-gc，否则本用例的前提不成立
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(JSON.parse(stdout)).toEqual({ before: "undefined", after: "function" });
  });

  it("resolveGc 返回可调用的函数且结果被缓存（同一引用）", () => {
    const gc = resolveGc();
    expect(typeof gc).toBe("function");
    expect(() => gc?.()).not.toThrow();
    expect(resolveGc()).toBe(gc);
  });

  it("进程带 --expose-gc 时同样返回函数（原生 gc 优先）", () => {
    // 本进程通常不带该 flag（由上面的兜底路径覆盖）；带 flag 时也要保证解析成功
    const gc = resolveGc();
    expect(typeof gc).toBe("function");
    if (typeof globalThis.gc === "function") expect(gc?.()).toBeUndefined();
  });
});

describe("maybeGc 节流", () => {
  it("minIntervalMs 内跳过、超出后放行", () => {
    const base = Date.now() + 10 * 60_000; // 基准取未来时刻，避免与前一用例的真实 GC 时间戳比较
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(base);
      expect(maybeGc(60_000)).toBe(true); // 首次不受节流约束
      expect(maybeGc(60_000)).toBe(false); // 同一时刻再来 → 跳过
      vi.setSystemTime(base + 59_999);
      expect(maybeGc(60_000)).toBe(false);
      vi.setSystemTime(base + 60_000);
      expect(maybeGc(60_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("不传 minIntervalMs 时每次都执行", () => {
    const base = Date.now() + 20 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(base);
      expect(maybeGc()).toBe(true);
      expect(maybeGc()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("缺失 globalThis.gc 的兜底路径（真实模块）", () => {
  it("删掉 globalThis.gc 后新加载的模块仍能解析出 gc", async () => {
    const holder = globalThis as { gc?: unknown };
    const saved = holder.gc;
    vi.resetModules();
    delete holder.gc;
    try {
      const fresh = await import("../src/gc-utils.js");
      expect(typeof fresh.resolveGc()).toBe("function");
      expect(fresh.maybeGc()).toBe(true);
    } finally {
      if (saved !== undefined) holder.gc = saved;
    }
  });
});
