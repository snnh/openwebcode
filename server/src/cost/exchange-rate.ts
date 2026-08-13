import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { isMissing } from "../fs-utils.js";
import { getUserAgent } from "../user-agent.js";

export const RATE_SCALE = 1_000_000n;

export interface ExchangeRateSnapshot {
  base: "USD";
  quote: "CNY";
  rate: bigint;
  source: string;
  effectiveDate: string;
  fetchedAt: string;
}

export interface ExchangeRateProvider {
  fetch(signal: AbortSignal): Promise<ExchangeRateSnapshot>;
}

interface StoredExchangeRateSnapshot {
  base: "USD";
  quote: "CNY";
  rate: string;
  source: string;
  effectiveDate: string;
  fetchedAt: string;
}

export class HttpExchangeRateProvider implements ExchangeRateProvider {
  constructor(private readonly url: string) {}

  async fetch(signal: AbortSignal): Promise<ExchangeRateSnapshot> {
    const response = await fetch(this.url, { signal, headers: { "User-Agent": getUserAgent() } });
    if (!response.ok) throw new Error(`Exchange rate request failed with status ${response.status}`);
    const value = await response.json() as unknown;
    const record = asRecord(value);
    const rates = asRecord(record.rates);
    const rawRate = rates.CNY ?? record.conversion_rate ?? record.rate;
    const dateValue = stringValue(record.date);
    const updatedValue = stringValue(record.time_last_update_utc);
    const effectiveDate = dateValue ?? (updatedValue ? new Date(updatedValue).toISOString().slice(0, 10) : today());
    return {
      base: "USD",
      quote: "CNY",
      rate: parseDecimalToScaled(rawRate, RATE_SCALE),
      source: this.url,
      effectiveDate,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export interface ExchangeRateServiceOptions {
  cachePath: string;
  provider?: ExchangeRateProvider;
  timeoutMs?: number;
  fixedUsdCnyRate?: string;
  /** 离线模式判定（settings offlineMode，现读热生效）：为 true 时跳过一切在线拉取，
   * 沿用既有回落链（缓存快照 → 固定汇率 → 无汇率）。 */
  isOffline?: () => boolean;
}

export class ExchangeRateService {
  private snapshot: ExchangeRateSnapshot | undefined;
  private refreshPromise: Promise<ExchangeRateSnapshot | undefined> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private lastSuccessfulRefresh = 0;

  constructor(private readonly options: ExchangeRateServiceOptions) {}

  async initialize(): Promise<void> {
    this.snapshot = await this.loadCache();
    if (!this.snapshot && this.options.fixedUsdCnyRate) {
      this.snapshot = fixedSnapshot(this.options.fixedUsdCnyRate);
    }
    if (!this.snapshot && this.options.provider) {
      await this.refresh().catch(() => undefined);
    } else {
      void this.refresh().catch(() => undefined);
    }
    if (this.options.provider) {
      this.refreshTimer = setInterval(() => void this.refresh().catch(() => undefined), 60 * 60 * 1_000);
      this.refreshTimer.unref();
    }
  }

  close(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  current(): ExchangeRateSnapshot | undefined {
    return this.snapshot ? { ...this.snapshot } : undefined;
  }

  refresh(): Promise<ExchangeRateSnapshot | undefined> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async refreshOnce(): Promise<ExchangeRateSnapshot | undefined> {
    if (!this.options.provider) return this.current();
    // 离线模式：跳过在线拉取（启动首拉与每小时定时刷新共用此闸门），保持缓存/固定汇率回落
    if (this.options.isOffline?.()) return this.current();
    const now = Date.now();
    if (this.lastSuccessfulRefresh > 0 && now - this.lastSuccessfulRefresh < 24 * 60 * 60 * 1_000) return this.current();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const snapshot = await this.options.provider.fetch(controller.signal);
      validateSnapshot(snapshot);
      this.snapshot = snapshot;
      this.lastSuccessfulRefresh = now;
      await this.saveCache(snapshot);
      return this.current();
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadCache(): Promise<ExchangeRateSnapshot | undefined> {
    try {
      const stored = JSON.parse(await readFile(this.options.cachePath, "utf8")) as StoredExchangeRateSnapshot;
      const snapshot: ExchangeRateSnapshot = { ...stored, rate: BigInt(stored.rate) };
      validateSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return undefined;
      throw error;
    }
  }

  private async saveCache(snapshot: ExchangeRateSnapshot): Promise<void> {
    await mkdir(path.dirname(this.options.cachePath), { recursive: true });
    const stored: StoredExchangeRateSnapshot = { ...snapshot, rate: snapshot.rate.toString() };
    await writeUtf8Atomically(this.options.cachePath, `${JSON.stringify(stored, null, 2)}\n`);
  }
}

export function parseDecimalToScaled(value: unknown, scale: bigint): bigint {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error("Invalid positive decimal value");
  const scaleDigits = scale.toString().length - 1;
  const fraction = (match[2] ?? "").padEnd(scaleDigits, "0");
  if (fraction.length > scaleDigits && /[1-9]/.test(fraction.slice(scaleDigits))) {
    throw new Error(`Decimal has more than ${scaleDigits} fractional digits`);
  }
  const whole = match[1];
  if (whole === undefined) throw new Error("Invalid positive decimal value");
  const result = BigInt(whole) * scale + BigInt(fraction.slice(0, scaleDigits) || "0");
  if (result <= 0n) throw new Error("Decimal value must be positive");
  return result;
}

function fixedSnapshot(rate: string): ExchangeRateSnapshot {
  const timestamp = new Date().toISOString();
  return {
    base: "USD",
    quote: "CNY",
    rate: parseDecimalToScaled(rate, RATE_SCALE),
    source: "configuration",
    effectiveDate: timestamp.slice(0, 10),
    fetchedAt: timestamp,
  };
}

function validateSnapshot(snapshot: ExchangeRateSnapshot): void {
  if (snapshot.base !== "USD" || snapshot.quote !== "CNY" || snapshot.rate <= 0n ||
      !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.effectiveDate) || !Number.isFinite(Date.parse(snapshot.fetchedAt))) {
    throw new Error("Invalid exchange rate snapshot");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
