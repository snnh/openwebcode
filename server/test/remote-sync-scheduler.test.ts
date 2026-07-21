import { describe, expect, it, vi } from "vitest";
import { MAX_SYNC_INTERVAL_MINUTES, RemoteSyncScheduler } from "../src/remote-sync-scheduler.js";

interface CapturedTimer {
  callback: () => void;
  delayMs: number;
  handle: { unref: ReturnType<typeof vi.fn> };
}

function schedulerFixture(initialMinutes: number) {
  let minutes = initialMinutes;
  const sync = vi.fn(async (): Promise<void> => undefined);
  const timers: CapturedTimer[] = [];
  const setIntervalImpl = vi.fn((callback: () => void, delayMs: number) => {
    const handle = { unref: vi.fn() };
    timers.push({ callback, delayMs, handle });
    return handle as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalImpl = vi.fn();
  const scheduler = new RemoteSyncScheduler({
    getIntervalMinutes: () => minutes,
    sync,
    setIntervalImpl,
    clearIntervalImpl,
  });
  return { scheduler, sync, timers, setIntervalImpl, clearIntervalImpl, setMinutes: (value: number) => { minutes = value; } };
}

describe("RemoteSyncScheduler", () => {
  it("does not schedule or synchronize at startup when the interval is zero", () => {
    const fixture = schedulerFixture(0);

    fixture.scheduler.start();

    expect(fixture.setIntervalImpl).not.toHaveBeenCalled();
    expect(fixture.sync).not.toHaveBeenCalled();
  });

  it("schedules a bounded periodic timer and performs the positive-interval startup refresh", () => {
    const fixture = schedulerFixture(15);

    fixture.scheduler.start();

    expect(fixture.setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(fixture.timers[0]).toMatchObject({ delayMs: 15 * 60_000 });
    expect(fixture.timers[0]?.handle.unref).toHaveBeenCalledTimes(1);
    expect(fixture.sync).toHaveBeenCalledTimes(1);
    fixture.timers[0]?.callback();
    expect(fixture.sync).toHaveBeenCalledTimes(2);
  });

  it("refreshes immediately after a settings change even when switching to manual-only mode", () => {
    const fixture = schedulerFixture(10);
    fixture.scheduler.start();
    fixture.setMinutes(0);

    fixture.scheduler.refreshAfterSettingsChange();

    expect(fixture.clearIntervalImpl).toHaveBeenCalledTimes(1);
    expect(fixture.setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(fixture.sync).toHaveBeenCalledTimes(2);
  });

  it("defensively clamps an invalid legacy interval before it reaches Node's timer", () => {
    const fixture = schedulerFixture(MAX_SYNC_INTERVAL_MINUTES + 1);

    fixture.scheduler.start();

    expect(fixture.timers[0]).toMatchObject({ delayMs: MAX_SYNC_INTERVAL_MINUTES * 60_000 });
  });
});
