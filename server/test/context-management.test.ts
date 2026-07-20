import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import type { ChatMessage } from "../src/sessions/types.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("context management controls", () => {
  it("updates policy and supports manual evict, restore, pin and unpin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-context-"));
    temporary.push(root);
    const manager = new ContextManager(root);
    const policy = await manager.updatePolicy({ strategy: "interval", lag: 2, interval: 3, pinExemptRounds: 7, restoreBudget: 9000 });
    expect(policy.policy).toMatchObject({ strategy: "interval", lag: 2, interval: 3, pinExemptRounds: 7, restoreBudget: 9000 });
    const messages: ChatMessage[] = [{ id: "tool-1", role: "tool", createdAt: new Date().toISOString(), content: [{ type: "tool_result", toolCallId: "c1", content: "complete result", isError: false }] }];
    let ledger = await manager.evictMessage(messages, "tool-1");
    expect(ledger.entries[0]).toMatchObject({ messageId: "tool-1", state: "evicted" });
    expect(await manager.readArtifact(ledger.entries[0]!.artifactId, 0, 100)).toBe("complete result");
    ledger = await manager.restore("tool-1");
    expect(ledger.entries[0]?.state).toBe("restored");
    ledger = await manager.setPinned("tool-1", true);
    expect(ledger.entries[0]?.pinnedUntilRound).toBe(Number.MAX_SAFE_INTEGER);
    ledger = await manager.setPinned("tool-1", false);
    expect(ledger.entries[0]?.pinnedUntilRound).toBe(0);
  });
});
