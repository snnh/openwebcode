import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { CORE_PROTOCOL_VERSION, CoreGateway, CoreProtocolError, negotiate } from "../src/core-gateway.js";
import type { CoreEvent, CoreInfo } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { FAKE_CORE_INFO, makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

function coreInfo(overrides: Partial<CoreInfo> = {}): CoreInfo {
  return {
    version: "0.2.4",
    protocolVersion: CORE_PROTOCOL_VERSION,
    platform: "windows",
    sandboxCapability: "enforced",
    features: {
      fsStat: true,
      fsStatMany: true,
      fsWriteBase64: true,
      jobControl: true,
      fsHash: true,
      fsScanPagination: true,
      fsWatch: true,
    },
    limits: {
      maxFrameBytes: 33_554_432,
      maxWriteBase64Bytes: 20_971_520,
      maxHashBytes: 16_777_216,
      maxStatManyPaths: 128,
      maxStatManyPathBytes: 262_144,
      maxScanEntries: 256,
      maxScanDepth: 16,
      maxScanNodes: 2_048,
      maxWatches: 16,
      maxWatchEvents: 128,
      maxConcurrentJobs: 4,
      maxJobOutputBytes: 524_288,
    },
    ...overrides,
  };
}

describe("CoreGateway", () => {
  it("negotiates once and only exposes explicitly advertised features", async () => {
    const ping = vi.fn(async () => coreInfo({ features: { ...coreInfo().features!, jobControl: false } }));
    const gateway = new CoreGateway({ ping });

    await expect(gateway.supports("jobControl")).resolves.toBe(false);
    await expect(gateway.supports("fsWatch")).resolves.toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("rejects an incompatible protocol instead of falling back to probe calls", () => {
    expect(() => negotiate(coreInfo({ protocolVersion: "0.9" }))).toThrow(CoreProtocolError);
  });

  it("rejects incomplete limits and feature records", () => {
    expect(() => negotiate(coreInfo({ features: { ...coreInfo().features!, fsWatch: undefined as never } }))).toThrow("features.fsWatch");
    expect(() => negotiate(coreInfo({ limits: { ...coreInfo().limits!, maxConcurrentJobs: 0 } }))).toThrow("limits.maxConcurrentJobs");
  });

  it("协商失败的 Promise 不缓存：下次调用重新 ping 并可成功", async () => {
    let calls = 0;
    const ping = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("core not ready");
      return coreInfo();
    });
    const gateway = new CoreGateway({ ping });

    await expect(gateway.info()).rejects.toThrow("core not ready");
    // 失败后缓存已清空，第二次调用触发新一轮协商并成功
    await expect(gateway.info()).resolves.toMatchObject({ protocolVersion: CORE_PROTOCOL_VERSION });
    expect(ping).toHaveBeenCalledTimes(2);
    // 成功结果被缓存，不再重复 ping
    await gateway.info();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("invalidate 后重新协商（core 重启/ready 路径刷新能力快照）", async () => {
    const ping = vi.fn(async () => coreInfo());
    const gateway = new CoreGateway({ ping });

    await gateway.info();
    expect(ping).toHaveBeenCalledTimes(1);
    gateway.invalidate();
    await gateway.info();
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe("CoreGateway 接线（AgentRunner core.ready）", () => {
  it("core.ready 事件使协商缓存失效，下一次能力判定重新 ping", async () => {
    const root = await tempRoot("owc-gw-ready-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    let listener: ((event: CoreEvent) => void) | undefined;
    let pingCount = 0;
    const core = makeFakeCore({
      async ping() { pingCount += 1; return FAKE_CORE_INFO; },
      on(eventName: string, eventListener: (...args: unknown[]) => void) {
        if (eventName === "event") listener = eventListener as (event: CoreEvent) => void;
        return core;
      },
    });
    const agent = new AgentRunner(sessions, providers, core, events, pricing);

    // runShell -> executeBash -> coreGateway.supports("jobControl")：首次协商
    await agent.runShell(session.id, "echo one");
    await agent.runShell(session.id, "echo two");
    expect(pingCount).toBe(1); // 协商结果被缓存
    // core 重启完成重新握手：能力快照失效，下次用到时重新协商
    listener?.({ source: "core", type: "core.ready", payload: FAKE_CORE_INFO });
    await agent.runShell(session.id, "echo three");
    expect(pingCount).toBe(2);
  }, 15_000);
});
