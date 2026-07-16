import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
export const RATE_SCALE = 1000000n;
export class HttpExchangeRateProvider {
    url;
    constructor(url) {
        this.url = url;
    }
    async fetch(signal) {
        const response = await fetch(this.url, { signal });
        if (!response.ok)
            throw new Error(`Exchange rate request failed with status ${response.status}`);
        const value = await response.json();
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
export class ExchangeRateService {
    options;
    snapshot;
    refreshPromise;
    refreshTimer;
    lastSuccessfulRefresh = 0;
    constructor(options) {
        this.options = options;
    }
    async initialize() {
        this.snapshot = await this.loadCache();
        if (!this.snapshot && this.options.fixedUsdCnyRate) {
            this.snapshot = fixedSnapshot(this.options.fixedUsdCnyRate);
        }
        if (!this.snapshot && this.options.provider) {
            await this.refresh().catch(() => undefined);
        }
        else {
            void this.refresh().catch(() => undefined);
        }
        if (this.options.provider) {
            this.refreshTimer = setInterval(() => void this.refresh().catch(() => undefined), 60 * 60 * 1_000);
            this.refreshTimer.unref();
        }
    }
    close() {
        if (this.refreshTimer)
            clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
    }
    current() {
        return this.snapshot ? { ...this.snapshot } : undefined;
    }
    refresh() {
        if (this.refreshPromise)
            return this.refreshPromise;
        this.refreshPromise = this.refreshOnce().finally(() => {
            this.refreshPromise = undefined;
        });
        return this.refreshPromise;
    }
    async refreshOnce() {
        if (!this.options.provider)
            return this.current();
        const now = Date.now();
        if (this.lastSuccessfulRefresh > 0 && now - this.lastSuccessfulRefresh < 24 * 60 * 60 * 1_000)
            return this.current();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
        try {
            const snapshot = await this.options.provider.fetch(controller.signal);
            validateSnapshot(snapshot);
            this.snapshot = snapshot;
            this.lastSuccessfulRefresh = now;
            await this.saveCache(snapshot);
            return this.current();
        }
        finally {
            clearTimeout(timer);
        }
    }
    async loadCache() {
        try {
            const stored = JSON.parse(await readFile(this.options.cachePath, "utf8"));
            const snapshot = { ...stored, rate: BigInt(stored.rate) };
            validateSnapshot(snapshot);
            return snapshot;
        }
        catch (error) {
            if (isMissing(error) || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)
                return undefined;
            throw error;
        }
    }
    async saveCache(snapshot) {
        await mkdir(path.dirname(this.options.cachePath), { recursive: true });
        const target = this.options.cachePath;
        const temporary = `${target}.${process.pid}.tmp`;
        const stored = { ...snapshot, rate: snapshot.rate.toString() };
        await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
        await rename(temporary, target);
    }
}
export function parseDecimalToScaled(value, scale) {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match)
        throw new Error("Invalid positive decimal value");
    const scaleDigits = scale.toString().length - 1;
    const fraction = (match[2] ?? "").padEnd(scaleDigits, "0");
    if (fraction.length > scaleDigits && /[1-9]/.test(fraction.slice(scaleDigits))) {
        throw new Error(`Decimal has more than ${scaleDigits} fractional digits`);
    }
    const whole = match[1];
    if (whole === undefined)
        throw new Error("Invalid positive decimal value");
    const result = BigInt(whole) * scale + BigInt(fraction.slice(0, scaleDigits) || "0");
    if (result <= 0n)
        throw new Error("Decimal value must be positive");
    return result;
}
function fixedSnapshot(rate) {
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
function validateSnapshot(snapshot) {
    if (snapshot.base !== "USD" || snapshot.quote !== "CNY" || snapshot.rate <= 0n ||
        !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.effectiveDate) || !Number.isFinite(Date.parse(snapshot.fetchedAt))) {
        throw new Error("Invalid exchange rate snapshot");
    }
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
function today() {
    return new Date().toISOString().slice(0, 10);
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
