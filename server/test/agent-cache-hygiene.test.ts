import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { MemorySectionBuilder } from "../src/agent/memory-section.js";
import { ContextManager } from "../src/context/context-manager.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 一轮内 yield N 条 usage chunk 后正常收尾（模拟 stream_options.include_usage 端点）。 */
async function runWithUsageChunks(chunks: number, prefix: string) {
  const root = await tempRoot(prefix);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "usage", model: "test-model" });
  await sessions.updateConfig(session.id, { provider: "usage", model: "test-model", snapshotMode: "manual" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const provider: Provider = {
    name: "usage",
    async *streamChat() {
      yield { type: "text_delta", text: "answer" };
      for (let index = 0; index < chunks; index += 1) {
        yield { type: "usage", inputTokens: 10 + index, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      }
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const events = new EventBus();
  const observed: Array<{ type: string; payload: unknown }> = [];
  events.on("event", (event) => observed.push({ type: event.type, payload: event.payload }));
  const runner = new AgentRunner(sessions, providers, makeFakeCore(), events, pricing);
  await runner.run(session.id, "记账");
  return {
    sessions,
    sessionId: session.id,
    usageEvents: observed.filter((event) => event.type === "context.usage").map((event) => event.payload as { sessionCost?: { usdMicroUnits?: string } }),
  };
}

describe("usage 中间帧记账", () => {
  it("逐 chunk 转发不逐 chunk load ledger（sessionCost 快照复用）", async () => {
    const loadSpy = vi.spyOn(ContextManager.prototype, "load");
    try {
      loadSpy.mockClear();
      const single = await runWithUsageChunks(1, "owc-usage-single-");
      const singleLoads = loadSpy.mock.calls.length;
      loadSpy.mockClear();
      const many = await runWithUsageChunks(6, "owc-usage-many-");
      const manyLoads = loadSpy.mock.calls.length;

      // 6 条 chunk = 5 条中间帧（persist=false）：修复前每条都 load 一次
      expect(manyLoads).toBeLessThanOrEqual(singleLoads + 1);
      expect(manyLoads).toBeLessThan(5);

      // 载荷仍然正确：每条事件都带会话累计成本，最后一条（落账）与 ledger 一致
      expect(many.usageEvents).toHaveLength(6);
      expect(single.usageEvents).toHaveLength(1);
      for (const payload of [...single.usageEvents, ...many.usageEvents]) {
        expect(typeof payload.sessionCost?.usdMicroUnits).toBe("string");
      }
      const ledger = await new ContextManager(many.sessions.contextRoot(many.sessionId)).load();
      expect(many.usageEvents.at(-1)!.sessionCost).toEqual(ledger.cost);
    } finally {
      loadSpy.mockRestore();
    }
  }, 30_000);
});

describe("记忆文件指纹缓存", () => {
  it("有界（LRU 上限 64）且 discard 可按 cwd 清理", async () => {
    const root = await tempRoot("owc-memory-cache-");
    const builder = new MemorySectionBuilder();
    const cache = (builder as unknown as { memoryFileCache: Map<string, unknown> }).memoryFileCache;

    for (let index = 0; index < 70; index += 1) {
      const cwd = path.join(root, `ws-${index}`);
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, "CLAUDE.md"), `memory of ws-${index}\n`, "utf8");
      expect(await builder.build(cwd)).toContain(`memory of ws-${index}`);
    }
    // 无界缓存会随访问过的 cwd 无限增长（长期运行内存泄漏）
    expect(cache.size).toBeLessThanOrEqual(64);
    expect(cache.size).toBeGreaterThan(0);

    expect([...cache.keys()].some((key) => key.includes("ws-69"))).toBe(true);
    builder.discard(path.join(root, "ws-69"));
    expect([...cache.keys()].some((key) => key.includes("ws-69"))).toBe(false);
    expect(cache.size).toBeGreaterThan(0);

    builder.discard();
    expect(cache.size).toBe(0);
  }, 30_000);
});
