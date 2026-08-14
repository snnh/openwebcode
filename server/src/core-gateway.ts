import type { CoreClientLike, CoreInfo } from "./core-client.js";

export const CORE_PROTOCOL_VERSION = "1.0";

const FEATURE_NAMES = ["fsStat", "fsStatMany", "fsWriteBase64", "jobControl", "fsHash", "fsScanPagination", "fsWatch"] as const;
const LIMIT_NAMES = ["maxFrameBytes", "maxWriteBase64Bytes", "maxHashBytes", "maxStatManyPaths", "maxStatManyPathBytes", "maxScanEntries", "maxScanDepth", "maxScanNodes", "maxWatches", "maxWatchEvents", "maxConcurrentJobs", "maxJobOutputBytes"] as const;

type CoreFeature = (typeof FEATURE_NAMES)[number];
type CoreLimit = (typeof LIMIT_NAMES)[number];
type NegotiatedCoreInfo = Omit<CoreInfo, "protocolVersion" | "features" | "limits"> & {
  protocolVersion: typeof CORE_PROTOCOL_VERSION;
  features: Record<CoreFeature, boolean>;
  limits: Record<CoreLimit, number>;
};

export class CoreProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreProtocolError";
  }
}

/**
 * The only capability negotiation point for Node business code. It refuses an
 * unknown protocol or incomplete capability record rather than discovering
 * support by issuing a real job/filesystem call and interpreting its failure.
 */
export class CoreGateway {
  private negotiated: Promise<NegotiatedCoreInfo> | undefined;

  constructor(private readonly core: Pick<CoreClientLike, "ping">) {}

  info(): Promise<NegotiatedCoreInfo> {
    if (!this.negotiated) {
      // 协商失败的 Promise 不缓存：瞬时失败（core 重启中/尚未就绪）允许下次调用重试，
      // 否则一次失败后 bash 等工具永久报错直到 server 重启。
      const pending = this.core.ping().then(negotiate);
      pending.catch(() => {
        if (this.negotiated === pending) this.negotiated = undefined;
      });
      this.negotiated = pending;
    }
    return this.negotiated;
  }

  async supports(feature: CoreFeature): Promise<boolean> {
    return (await this.info()).features[feature];
  }

  invalidate(): void {
    this.negotiated = undefined;
  }
}

export function negotiate(info: CoreInfo): NegotiatedCoreInfo {
  if (info.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new CoreProtocolError(`Unsupported Core protocol ${info.protocolVersion ?? "(missing)"}; expected ${CORE_PROTOCOL_VERSION}`);
  }
  const features = {} as Record<CoreFeature, boolean>;
  for (const name of FEATURE_NAMES) {
    if (typeof info.features?.[name] !== "boolean") throw new CoreProtocolError(`Core capability features.${name} is missing or invalid`);
    features[name] = info.features[name];
  }
  const limits = {} as Record<CoreLimit, number>;
  for (const name of LIMIT_NAMES) {
    const value = info.limits?.[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new CoreProtocolError(`Core capability limits.${name} is missing or invalid`);
    limits[name] = value;
  }
  return { ...info, protocolVersion: CORE_PROTOCOL_VERSION, features, limits };
}
