import { describe, expect, it, vi } from "vitest";
import { CORE_PROTOCOL_VERSION, CoreGateway, CoreProtocolError, negotiate } from "../src/core-gateway.js";
import type { CoreInfo } from "../src/core-client.js";

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
});
