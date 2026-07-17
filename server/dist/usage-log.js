import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const EMPTY = {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usdMicroUnits: "0",
    cnyMicroUnits: "0",
    unpricedTokens: 0,
};
function mutableMetrics() {
    return { ...EMPTY, usdMicroUnits: 0n, cnyMicroUnits: 0n };
}
function addEvent(target, event) {
    target.runs += 1;
    target.inputTokens += event.inputTokens;
    target.outputTokens += event.outputTokens;
    target.cacheRead += event.cacheRead;
    target.cacheWrite += event.cacheWrite;
    if (event.priced) {
        if (event.usdMicroUnits)
            target.usdMicroUnits += BigInt(event.usdMicroUnits);
        if (event.cnyMicroUnits)
            target.cnyMicroUnits += BigInt(event.cnyMicroUnits);
    }
    else {
        target.unpricedTokens += event.inputTokens + event.outputTokens + event.cacheRead + event.cacheWrite;
    }
}
function freeze(metrics) {
    return { ...metrics, usdMicroUnits: metrics.usdMicroUnits.toString(), cnyMicroUnits: metrics.cnyMicroUnits.toString() };
}
/** 报表按服务器本地时区划日（报表是给人看的，与「今天」的直觉一致）。 */
function localDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
function isRecord(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return typeof record.at === "string" &&
        typeof record.sessionId === "string" &&
        typeof record.provider === "string" &&
        typeof record.model === "string" &&
        typeof record.inputTokens === "number" &&
        typeof record.outputTokens === "number" &&
        typeof record.cacheRead === "number" &&
        typeof record.cacheWrite === "number" &&
        typeof record.priced === "boolean";
}
/**
 * 全局用量日志：dataDir/usage-events.jsonl 追加写，读取时现场聚合。
 * 每行约 200B，1 万次调用约 2MB，v0.1 不做轮转。
 */
export class UsageLog {
    filePath;
    queue = Promise.resolve();
    constructor(dataDir) {
        this.filePath = path.join(dataDir, "usage-events.jsonl");
    }
    async record(event) {
        const line = `${JSON.stringify(event)}\n`;
        // catch 兜底：一次写入失败（磁盘满/权限）不能让后续所有记录静默丢失
        this.queue = this.queue.catch(() => { }).then(async () => {
            await mkdir(path.dirname(this.filePath), { recursive: true });
            await appendFile(this.filePath, line, "utf8");
        });
        return this.queue;
    }
    /** 测试与将来压缩/重写用。 */
    async replaceAll(events) {
        const text = events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
        this.queue = this.queue.catch(() => { }).then(async () => {
            await mkdir(path.dirname(this.filePath), { recursive: true });
            await writeFile(this.filePath, text, "utf8");
        });
        return this.queue;
    }
    async readAll() {
        // 先等队列排空，保证读到所有已接受的记录（含中途失败后的后续写入）
        await this.queue.catch(() => { });
        let text;
        try {
            text = await readFile(this.filePath, "utf8");
        }
        catch {
            return [];
        }
        const events = [];
        for (const line of text.split("\n")) {
            if (line.trim() === "")
                continue;
            try {
                const parsed = JSON.parse(line);
                if (isRecord(parsed))
                    events.push(parsed);
            }
            catch {
                // 跳过截断/损坏行（进程在 append 中途被杀时可能出现）
            }
        }
        return events;
    }
    /** from/to 为本地日期 YYYY-MM-DD（闭区间），缺省不限。 */
    async report(range = {}) {
        const events = await this.readAll();
        const totals = mutableMetrics();
        const byDay = new Map();
        const byDayProvider = new Map();
        const bySession = new Map();
        const bySessionProvider = new Map();
        const bucket = (map, key) => {
            let found = map.get(key);
            if (!found) {
                found = mutableMetrics();
                map.set(key, found);
            }
            return found;
        };
        for (const event of events) {
            const date = localDate(event.at);
            if (date === "")
                continue;
            if (range.from && date < range.from)
                continue;
            if (range.to && date > range.to)
                continue;
            addEvent(totals, event);
            addEvent(bucket(byDay, date), event);
            addEvent(bucket(byDayProvider, `${date}${event.provider}·${event.model}`), event);
            addEvent(bucket(bySession, event.sessionId), event);
            addEvent(bucket(bySessionProvider, `${event.sessionId}${event.provider}·${event.model}`), event);
        }
        const breakdown = (source, prefix) => {
            const rows = [];
            for (const [key, metrics] of source) {
                if (!key.startsWith(prefix))
                    continue;
                const rest = key.slice(prefix.length);
                const separator = rest.indexOf("·");
                const provider = separator === -1 ? rest : rest.slice(0, separator);
                const model = separator === -1 ? "" : rest.slice(separator + 1);
                rows.push({ provider, model, ...freeze(metrics) });
            }
            return rows.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
        };
        return {
            generatedAt: new Date().toISOString(),
            ...(range.from ? { from: range.from } : {}),
            ...(range.to ? { to: range.to } : {}),
            totals: freeze(totals),
            days: [...byDay.entries()]
                .map(([date, metrics]) => ({ date, ...freeze(metrics), providers: breakdown(byDayProvider, `${date}`) }))
                .sort((a, b) => b.date.localeCompare(a.date)),
            sessions: [...bySession.entries()]
                .map(([sessionId, metrics]) => ({
                sessionId,
                ...freeze(metrics),
                providers: breakdown(bySessionProvider, `${sessionId}`),
            }))
                .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)),
        };
    }
}
