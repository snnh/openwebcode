export interface PricingEntry {
  provider: string;
  model: string;
  currency: "USD" | "CNY";
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

/** Result returned by a remote catalog or pricing synchronization attempt. */
export type SyncResult =
  | { ok: true; count: number; updatedAt: string }
  | { ok: false; error: string };

/** Persisted status of the remote model-catalog layer. */
export interface CatalogSyncStatus {
  count: number;
  updatedAt?: string;
}
