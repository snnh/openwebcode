import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events/event-bus.js";

/**
 * 常驻内存防护：按 sessionId 键控的记账必须随会话生命周期释放，
 * 否则服务端内存随「历史上创建过的会话数」单调增长。
 */
describe("EventBus 会话序列记账", () => {
  it("session.deleted 释放该会话的 seq 记账", () => {
    const bus = new EventBus();
    const publish = (type: string, sessionId: string) =>
      bus.publish({ source: "session", type, sessionId, payload: {} });

    expect(publish("session.updated", "s1").sessionSeq).toBe(1);
    expect(publish("session.deleted", "s1").sessionSeq).toBe(2);
    // 记账已释放：同 id 再次发布从 1 起算（未释放时会是 3）
    expect(publish("session.updated", "s1").sessionSeq).toBe(1);
  });
});
