import { describe, expect, it } from "vitest";
import { InteractionCoordinator } from "../src/agent/interaction-coordinator.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("InteractionCoordinator", () => {
  it("creates, answers and lists interactions", async () => {
    const root = await tempRoot("owc-interactions-");
    const coordinator = new InteractionCoordinator(() => root);
    const created = await coordinator.create("s1", { runId: "r1", kind: "confirm", title: "t", prompt: "p" });
    expect(created.status).toBe("pending");
    const answered = await coordinator.answer("s1", created.id, { ok: true });
    expect(answered?.status).toBe("answered");
    expect((await coordinator.list("s1"))[0]).toMatchObject({ id: created.id, status: "answered" });
  });

  it("prunes the oldest resolved interactions beyond the retention cap, keeping pending", async () => {
    const root = await tempRoot("owc-interactions-cap-");
    const coordinator = new InteractionCoordinator(() => root);
    for (let index = 0; index < 505; index += 1) {
      const item = await coordinator.create("s1", { runId: "r1", kind: "confirm", title: `t${index}`, prompt: "p" });
      await coordinator.answer("s1", item.id, index);
    }
    const pending = await coordinator.create("s1", { runId: "r1", kind: "confirm", title: "pending", prompt: "p" });
    const items = await coordinator.list("s1");
    // 500 条已完结保留上限 + 1 条 pending（永不裁剪）
    expect(items).toHaveLength(501);
    expect(items.filter((item) => item.status === "pending").map((item) => item.id)).toEqual([pending.id]);
    // 最旧的 5 条 answered 被裁掉，剩余按原顺序从 t5 开始
    expect(items[0]).toMatchObject({ title: "t5" });
  });
});
