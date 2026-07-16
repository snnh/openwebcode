import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import defaultCatalog from "./default-model-pricing.json" with { type: "json" };
export class PricingValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "PricingValidationError";
    }
}
export class PricingCatalog {
    filePath;
    document;
    compiled = [];
    operation = Promise.resolve();
    constructor(filePath) {
        this.filePath = filePath;
    }
    async initialize() {
        await this.serial(async () => {
            try {
                const document = parseDocument(JSON.parse(await readFile(this.filePath, "utf8")));
                this.install(document);
            }
            catch (error) {
                const document = parseDocument(defaultCatalog);
                if (isMissing(error))
                    await this.persist(document);
                this.install(document);
            }
        });
    }
    get(provider, model, at = new Date()) {
        const time = at.getTime();
        const entry = this.compiled.find((candidate) => candidate.provider === provider && candidate.model === model &&
            candidate.fromTime <= time && (candidate.untilTime === undefined || time < candidate.untilTime));
        return entry ? { ...entry.pricing } : undefined;
    }
    list() {
        if (!this.document)
            throw new Error("Pricing catalog is not initialized");
        return cloneDocument(this.document);
    }
    async replace(value) {
        return this.serial(async () => {
            const document = parseDocument(value);
            await this.persist(document);
            this.install(document);
            return cloneDocument(document);
        });
    }
    install(document) {
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
    async persist(document) {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
        await rename(temporary, this.filePath);
    }
    serial(operation) {
        const result = this.operation.then(operation, operation);
        this.operation = result.then(() => undefined, () => undefined);
        return result;
    }
}
export function parsePricingDocument(value) {
    return parseDocument(value);
}
function parseDocument(value) {
    try {
        return parseDocumentValue(value);
    }
    catch (error) {
        if (error instanceof PricingValidationError)
            throw error;
        throw new PricingValidationError(error instanceof Error ? error.message : String(error));
    }
}
function parseDocumentValue(value) {
    const record = asRecord(value);
    if (record.version !== 1 || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) || !Array.isArray(record.entries)) {
        throw new Error("Pricing document requires version 1, valid updatedAt, and entries array");
    }
    const entries = record.entries.map(parseEntry);
    validateIntervals(entries);
    return { version: 1, updatedAt: record.updatedAt, entries };
}
function parseEntry(value) {
    const record = asRecord(value);
    const provider = nonEmpty(record.provider, "provider");
    const model = nonEmpty(record.model, "model");
    const currency = record.currency;
    if (currency !== "USD" && currency !== "CNY")
        throw new Error("Pricing currency must be USD or CNY");
    const effectiveFrom = date(record.effectiveFrom, "effectiveFrom");
    const effectiveUntil = record.effectiveUntil === undefined ? undefined : date(record.effectiveUntil, "effectiveUntil");
    if (effectiveUntil !== undefined && effectiveUntil <= effectiveFrom)
        throw new Error("effectiveUntil must be after effectiveFrom");
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
function validateIntervals(entries) {
    const groups = new Map();
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
function cloneDocument(document) {
    return { ...document, entries: document.entries.map((entry) => ({ ...entry })) };
}
function integer(value, name) {
    if (typeof value !== "string" || !/^\d+$/.test(value))
        throw new Error(`${name} must be a non-negative integer string`);
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(`${name} exceeds the supported limit`);
    return parsed.toString();
}
function date(value, name) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${name} must be a valid YYYY-MM-DD date`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`${name} must be a valid YYYY-MM-DD date`);
    }
    return value;
}
function dateTime(value) {
    return Date.parse(`${value}T00:00:00.000Z`);
}
function nonEmpty(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must be a non-empty string`);
    return value;
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Pricing document must be an object");
    return value;
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
