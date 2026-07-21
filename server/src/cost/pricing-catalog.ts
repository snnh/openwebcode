import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import defaultCatalog from "./default-model-pricing.json" with { type: "json" };
import type { Currency, ModelPricing } from "../context/model-profile.js";

export interface PricingEntry {
  provider: string;
  model: string;
  currency: Currency;
  effectiveFrom: string;
  effectiveUntil?: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

export interface PricingDocument {
  version: 1;
  updatedAt: string;
  entries: PricingEntry[];
}

/** Result returned by a remote catalog synchronization attempt. */
export type SyncResult =
  | { ok: true; count: number; updatedAt: string }
  | { ok: false; error: string };

export interface PricingSyncOptions {
  /** Injectable for tests and alternate transport implementations. */
  fetchImpl?: typeof fetch;
  /** Request deadline in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;
}

interface CompiledEntry extends PricingEntry {
  pricing: ModelPricing;
  fromTime: number;
  untilTime?: number;
}

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingValidationError";
  }
}

export class PricingCatalog {
  private document: PricingDocument | undefined;
  private compiled: CompiledEntry[] = [];
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await this.serial(async () => {
      try {
        const document = parseDocument(JSON.parse(await readFile(this.filePath, "utf8")));
        this.install(document);
      } catch (error) {
        const document = parseDocument(defaultCatalog);
        if (isMissing(error)) await this.persist(document);
        this.install(document);
      }
    });
  }

  get(provider: string, model: string, at: Date = new Date()): ModelPricing | undefined {
    const time = at.getTime();
    const entry = this.compiled.find((candidate) =>
      candidate.provider === provider && candidate.model === model &&
      candidate.fromTime <= time && (candidate.untilTime === undefined || time < candidate.untilTime));
    return entry ? { ...entry.pricing } : undefined;
  }

  list(): PricingDocument {
    if (!this.document) throw new Error("Pricing catalog is not initialized");
    return cloneDocument(this.document);
  }

  async replace(value: unknown): Promise<PricingDocument> {
    return this.serial(async () => {
      const document = parseDocument(value);
      return this.replaceDocument(document);
    });
  }

  /**
   * Fetch and atomically install a remote pricing document.  Validation is
   * completed before the catalog is committed, so a bad response never
   * changes the active catalog. The complete fetch-to-commit operation is
   * serialized: a later invocation cannot be overwritten by an older, slower
   * response.
   */
  async syncFromUrl(url: string, options: PricingSyncOptions = {}): Promise<SyncResult> {
    return this.serial(async () => {
      try {
        const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const document = parseDocument(await response.json());
        const installed = await this.replaceDocument(document);
        return { ok: true, count: installed.entries.length, updatedAt: installed.updatedAt };
      } catch (error) {
        return { ok: false, error: syncErrorMessage(error) };
      }
    });
  }

  /** Commit a document that has already passed parseDocument validation. */
  private async replaceDocument(document: PricingDocument): Promise<PricingDocument> {
    await this.persist(document);
    this.install(document);
    return cloneDocument(document);
  }

  private install(document: PricingDocument): void {
    this.document = cloneDocument(document);
    this.compiled = document.entries.map((entry) => ({
      ...entry,
      pricing: {
        currency: entry.currency,
        input: BigInt(entry.input),
        output: BigInt(entry.output),
        cacheRead: BigInt(entry.cacheRead),
        cacheWrite: BigInt(entry.cacheWrite),
      },
      fromTime: dateTime(entry.effectiveFrom),
      ...(entry.effectiveUntil ? { untilTime: dateTime(entry.effectiveUntil) } : {}),
    }));
  }

  private async persist(document: PricingDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function parsePricingDocument(value: unknown): PricingDocument {
  return parseDocument(value);
}

function parseDocument(value: unknown): PricingDocument {
  try {
    return parseDocumentValue(value);
  } catch (error) {
    if (error instanceof PricingValidationError) throw error;
    throw new PricingValidationError(error instanceof Error ? error.message : String(error));
  }
}

function parseDocumentValue(value: unknown): PricingDocument {
  const record = asRecord(value);
  if (record.version !== 1 || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) || !Array.isArray(record.entries)) {
    throw new Error("Pricing document requires version 1, valid updatedAt, and entries array");
  }
  const entries = record.entries.map(parseEntry);
  validateIntervals(entries);
  return { version: 1, updatedAt: record.updatedAt, entries };
}

function parseEntry(value: unknown): PricingEntry {
  const record = asRecord(value);
  const provider = nonEmpty(record.provider, "provider");
  const model = nonEmpty(record.model, "model");
  const currency = record.currency;
  if (currency !== "USD" && currency !== "CNY") throw new Error("Pricing currency must be USD or CNY");
  const effectiveFrom = date(record.effectiveFrom, "effectiveFrom");
  const effectiveUntil = record.effectiveUntil === undefined ? undefined : date(record.effectiveUntil, "effectiveUntil");
  if (effectiveUntil !== undefined && effectiveUntil <= effectiveFrom) throw new Error("effectiveUntil must be after effectiveFrom");
  return {
    provider,
    model,
    currency,
    effectiveFrom,
    ...(effectiveUntil ? { effectiveUntil } : {}),
    input: integer(record.input, "input"),
    output: integer(record.output, "output"),
    cacheRead: integer(record.cacheRead, "cacheRead"),
    cacheWrite: integer(record.cacheWrite, "cacheWrite"),
  };
}

function validateIntervals(entries: PricingEntry[]): void {
  const groups = new Map<string, PricingEntry[]>();
  for (const entry of entries) {
    const key = `${entry.provider}\0${entry.model}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
    for (let index = 1; index < group.length; index++) {
      const previous = group[index - 1];
      const current = group[index];
      if (!previous || !current || previous.effectiveUntil === undefined || current.effectiveFrom < previous.effectiveUntil) {
        throw new Error("Pricing effective intervals overlap");
      }
    }
  }
}

function cloneDocument(document: PricingDocument): PricingDocument {
  return { ...document, entries: document.entries.map((entry) => ({ ...entry })) };
}

function integer(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer string`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} exceeds the supported limit`);
  return parsed.toString();
}

function date(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function dateTime(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pricing document must be an object");
  return value as Record<string, unknown>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function syncErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to sync model pricing";
}
