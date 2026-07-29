import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "./atomic-file.js";
import { isMissing } from "./fs-utils.js";
import { getUserAgent } from "./http.js";
import { getServerVersion } from "./version.js";

export interface UpdateCheckSnapshot {
  latestVersion: string;
  isNewer: boolean;
  htmlUrl: string;
  publishedAt: string;
  checkedAt: string;
}

interface StoredUpdateCheckSnapshot {
  latestVersion: string;
  isNewer: boolean;
  htmlUrl: string;
  publishedAt: string;
  checkedAt: string;
}

export interface UpdateCheckerOptions {
  cachePath: string;
  defaultUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Result of comparing two versions: positive if `a` is newer than `b`. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = pa[i]! - pb[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Strip a leading `v` from a release tag name (e.g. `v0.5.2` -> `0.5.2`). */
export function stripVersionPrefix(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export class UpdateChecker {
  private snapshot: UpdateCheckSnapshot | undefined;
  private refreshPromise: Promise<UpdateCheckSnapshot | undefined> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private lastSuccessfulRefresh = 0;
  private enabled = false;
  private url: string;
  private intervalHours = 24;

  constructor(private readonly options: UpdateCheckerOptions) {
    this.url = options.defaultUrl;
  }

  /** Configure enabled state, URL, and interval. Called at startup and on settings change. */
  configure(config: { enabled: boolean; url?: string; intervalHours: number }): void {
    this.enabled = config.enabled;
    if (typeof config.url === "string" && config.url.length > 0) this.url = config.url;
    this.intervalHours = config.intervalHours;
    this.scheduleTimer();
  }

  async initialize(): Promise<void> {
    this.snapshot = await this.loadCache();
    if (this.enabled) {
      await this.refresh().catch(() => undefined);
    }
    this.scheduleTimer();
  }

  close(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  current(): UpdateCheckSnapshot | undefined {
    return this.snapshot ? { ...this.snapshot } : undefined;
  }

  /** Trigger an immediate refresh regardless of throttle; no-op if disabled. */
  refresh(): Promise<UpdateCheckSnapshot | undefined> {
    if (!this.enabled) return Promise.resolve(this.current());
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async refreshOnce(): Promise<UpdateCheckSnapshot | undefined> {
    const now = Date.now();
    const throttleMs = this.intervalHours > 0 ? this.intervalHours * 60 * 60 * 1_000 : 0;
    if (throttleMs > 0 && this.lastSuccessfulRefresh > 0 && now - this.lastSuccessfulRefresh < throttleMs) {
      return this.current();
    }
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await fetchImpl(this.url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": getUserAgent(),
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as {
        tag_name?: unknown;
        html_url?: unknown;
        published_at?: unknown;
      };
      const tag = typeof body.tag_name === "string" ? body.tag_name : "";
      const latestVersion = stripVersionPrefix(tag);
      if (!latestVersion) throw new Error("GitHub response missing tag_name");
      const htmlUrl = typeof body.html_url === "string" ? body.html_url : "";
      const publishedAt = typeof body.published_at === "string" ? body.published_at : "";
      const snapshot: UpdateCheckSnapshot = {
        latestVersion,
        isNewer: compareSemver(latestVersion, getServerVersion()) > 0,
        htmlUrl,
        publishedAt,
        checkedAt: new Date().toISOString(),
      };
      this.snapshot = snapshot;
      this.lastSuccessfulRefresh = now;
      await this.saveCache(snapshot);
      return this.current();
    } finally {
      clearTimeout(timer);
    }
  }

  private scheduleTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (!this.enabled || this.intervalHours <= 0) return;
    const intervalMs = this.intervalHours * 60 * 60 * 1_000;
    this.refreshTimer = setTimeout(() => void this.refresh().catch(() => undefined), intervalMs);
    this.refreshTimer.unref();
  }

  private async loadCache(): Promise<UpdateCheckSnapshot | undefined> {
    try {
      const stored = JSON.parse(await readFile(this.options.cachePath, "utf8")) as StoredUpdateCheckSnapshot;
      return validateSnapshot(stored);
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError || error instanceof TypeError) return undefined;
      throw error;
    }
  }

  private async saveCache(snapshot: UpdateCheckSnapshot): Promise<void> {
    await mkdir(path.dirname(this.options.cachePath), { recursive: true });
    await writeUtf8Atomically(this.options.cachePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}

function validateSnapshot(value: unknown): UpdateCheckSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.latestVersion !== "string" || typeof record.htmlUrl !== "string" ||
      typeof record.publishedAt !== "string" || typeof record.checkedAt !== "string" ||
      typeof record.isNewer !== "boolean") {
    return undefined;
  }
  return {
    latestVersion: record.latestVersion,
    isNewer: record.isNewer,
    htmlUrl: record.htmlUrl,
    publishedAt: record.publishedAt,
    checkedAt: record.checkedAt,
  };
}
