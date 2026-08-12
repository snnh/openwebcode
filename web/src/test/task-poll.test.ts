import { describe, expect, it } from "vitest";
import { TASKS_POLL_ACTIVE_MS, TASKS_POLL_IDLE_MS, tasksPollInterval } from "../lib/task-poll";

describe("tasksPollInterval", () => {
  it("有运行中任务或弹层打开：5s；空闲：30s 兜底", () => {
    expect(tasksPollInterval(true, false)).toBe(TASKS_POLL_ACTIVE_MS);
    expect(tasksPollInterval(false, true)).toBe(TASKS_POLL_ACTIVE_MS);
    expect(tasksPollInterval(true, true)).toBe(TASKS_POLL_ACTIVE_MS);
    expect(tasksPollInterval(false, false)).toBe(TASKS_POLL_IDLE_MS);
  });
});
