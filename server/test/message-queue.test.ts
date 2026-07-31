import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MessageQueue } from "../src/agent/message-queue.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("MessageQueue", () => {
  it("persists queue state across instances and records the applied chat message", async () => {
    const root = await tempRoot("owc-message-queue-");
    const sessionRoot = path.join(root, "session-a");
    await mkdir(sessionRoot, { recursive: true });
    const first = new MessageQueue(() => sessionRoot);

    const queued = await first.enqueue("session-a", "steer", "use a streaming parser");
    const restored = new MessageQueue(() => sessionRoot);
    expect(await restored.list("session-a", "steer")).toMatchObject([{ id: queued.item.id, status: "queued" }]);

    const consuming = await restored.take("session-a", "steer");
    expect(consuming).toMatchObject({ id: queued.item.id, status: "consuming" });
    await restored.apply("session-a", queued.item.id, "message-42");
    expect(await first.list("session-a", "steer")).toMatchObject([{ id: queued.item.id, status: "applied", appliedMessageId: "message-42" }]);
  });

  it("serializes concurrent writes and can return a failed claim to queued", async () => {
    const root = await tempRoot("owc-message-queue-");
    const sessionRoot = path.join(root, "session-b");
    await mkdir(sessionRoot, { recursive: true });
    const queue = new MessageQueue(() => sessionRoot);

    const [first, second] = await Promise.all([
      queue.enqueue("session-b", "steer", "first"),
      queue.enqueue("session-b", "follow_up", "second"),
    ]);
    expect((await queue.list("session-b")).map((item) => item.content)).toEqual(["first", "second"]);
    const claim = await queue.take("session-b", "steer");
    await queue.requeue("session-b", claim!.id);
    expect(await queue.list("session-b", "steer")).toMatchObject([{ id: first.item.id, status: "queued" }]);
    expect(await queue.list("session-b", "follow_up")).toMatchObject([{ id: second.item.id, status: "queued" }]);
  });
});
