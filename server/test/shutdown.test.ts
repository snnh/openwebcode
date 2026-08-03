import { afterEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "../src/shutdown.js";

interface Harness {
  handlers: Map<string, () => void>;
  exitCodes: number[];
  fire: (signal: string) => void;
}

function install(options: { shutdown: () => Promise<void>; platform?: NodeJS.Platform; forceExitTimeoutMs?: number }): Harness {
  const handlers = new Map<string, () => void>();
  const exitCodes: number[] = [];
  installGracefulShutdown({
    shutdown: options.shutdown,
    ...(options.forceExitTimeoutMs !== undefined ? { forceExitTimeoutMs: options.forceExitTimeoutMs } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    exit: (code) => { exitCodes.push(code); },
    register: (signal, listener) => { handlers.set(signal, listener); },
  });
  return {
    handlers,
    exitCodes,
    fire: (signal) => {
      const handler = handlers.get(signal);
      if (!handler) throw new Error(`no handler for ${signal}`);
      handler();
    },
  };
}

describe("installGracefulShutdown", () => {
  afterEach(() => vi.useRealTimers());

  it("注册 SIGINT/SIGTERM；POSIX 额外注册 SIGHUP，Windows 不注册", () => {
    const linux = install({ shutdown: async () => undefined, platform: "linux" });
    expect([...linux.handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    const win = install({ shutdown: async () => undefined, platform: "win32" });
    expect([...win.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("首次信号启动优雅 shutdown，完成后不强制 exit", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const harness = install({ shutdown: async () => { calls += 1; }, platform: "linux" });
    harness.fire("SIGINT");
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.exitCodes).toEqual([]);
  });

  it("shutdown 超过 5s 未完成则强制 exit(1)", async () => {
    vi.useFakeTimers();
    const harness = install({ shutdown: () => new Promise(() => undefined), platform: "linux" });
    harness.fire("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.exitCodes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.exitCodes).toEqual([1]);
  });

  it("shutdown 失败立即 exit(1)，不等超时", async () => {
    vi.useFakeTimers();
    const harness = install({ shutdown: async () => { throw new Error("boom"); }, platform: "linux" });
    harness.fire("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.exitCodes).toEqual([1]);
  });

  it("同一信号第二次到达立即按 128+signum 退出", () => {
    vi.useFakeTimers();
    const harness = install({ shutdown: () => new Promise(() => undefined), platform: "linux" });
    harness.fire("SIGINT");
    harness.fire("SIGINT");
    expect(harness.exitCodes).toEqual([130]);
    const term = install({ shutdown: () => new Promise(() => undefined), platform: "linux" });
    term.fire("SIGTERM");
    term.fire("SIGTERM");
    expect(term.exitCodes).toEqual([143]);
  });

  it("SIGHUP（POSIX）走同一优雅 shutdown，第二次 exit(129)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const harness = install({ shutdown: async () => { calls += 1; }, platform: "linux" });
    harness.fire("SIGHUP");
    expect(calls).toBe(1);
    harness.fire("SIGHUP");
    expect(harness.exitCodes).toEqual([129]);
  });
});
