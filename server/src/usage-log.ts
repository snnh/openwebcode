import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 一次模型调用的用量/成本事件（追加写入 usage-events.jsonl，一行一条）。 */
export interface UsageEventRecord {
  at: string;
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  priced: boolean;
  usdMicroUnits?: string;
  cnyMicroUnits?: string;
}

export interface ReportMetrics {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  usdMicroUnits: string;
  cnyMicroUnits: string;
  unpricedTokens: number;
}

export type ProviderBreakdown = ReportMetrics & { provider: string; model: string };

export interface CostReport {
  generatedAt: string;
  from?: string;
  to?: string;
  totals: ReportMetrics;
  days: Array<ReportMetrics & { date: string; providers: ProviderBreakdown[] }>;
  sessions: Array<ReportMetrics & { sessionId: string; providers: ProviderBreakdown[] }>;
}

const EMPTY: ReportMetrics = {
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usdMicroUnits: "0",
  cnyMicroUnits: "0",
  unpricedTokens: 0,
};

interface MutableMetrics extends Omit<ReportMetrics, "usdMicroUnits" | "cnyMicroUnits"> {
  usdMicroUnits: bigint;
  cnyMicroUnits: bigint;
}

function mutableMetrics(): MutableMetrics {
  return { ...EMPTY, usdMicroUnits: 0n, cnyMicroUnits: 0n };
}

function addEvent(target: MutableMetrics, event: UsageEventRecord): void {
  target.runs += 1;
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.cacheRead += event.cacheRead;
  target.cacheWrite += event.cacheWrite;
  if (event.priced) {
    if (event.usdMicroUnits) target.usdMicroUnits += BigInt(event.usdMicroUnits);
    if (event.cnyMicroUnits) target.cnyMicroUnits += BigInt(event.cnyMicroUnits);
  } else {
    target.unpricedTokens += event.inputTokens + event.outputTokens + event.cacheRead + event.cacheWrite;
  }
}

function freeze(metrics: MutableMetrics): ReportMetrics {
  return { ...metrics, usdMicroUnits: metrics.usdMicroUnits.toString(), cnyMicroUnits: metrics.cnyMicroUnits.toString() };
}

/** 报表按服务器本地时区划日（报表是给人看的，与「今天」的直觉一致）。 */
function localDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isRecord(value: unknown): value is UsageEventRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
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
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();
  /** report 聚合结果缓存（按 from/to 区间键控）：文件 mtimeMs+size 指纹未变时复用，generatedAt 仍每次现取。 */
  private readonly reportCache = new Map<string, { mtimeMs: number; size: number; body: Omit<CostReport, "generatedAt"> }>();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "usage-events.jsonl");
  }

  async record(event: UsageEventRecord): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    // 主动失效聚合缓存（双保险：指纹也会随 append 变化）
    this.reportCache.clear();
    // catch 兜底：一次写入失败（磁盘满/权限）不能让后续所有记录静默丢失
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });
    return this.queue;
  }

  /** 测试与将来压缩/重写用。 */
  async replaceAll(events: UsageEventRecord[]): Promise<void> {
    const text = events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
    this.reportCache.clear();
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, text, "utf8");
    });
    return this.queue;
  }

  async readAll(): Promise<UsageEventRecord[]> {
    // 先等队列排空，保证读到所有已接受的记录（含中途失败后的后续写入）
    await this.queue.catch(() => {});
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const events: UsageEventRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) events.push(parsed);
      } catch {
        // 跳过截断/损坏行（进程在 append 中途被杀时可能出现）
      }
    }
    return events;
  }

  /** 文件指纹；缺失/不可读返回 null（此时不写聚合缓存，行为同 readAll 的空结果路径）。 */
  private async fingerprint(): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const stats = await stat(this.filePath);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }

  /** from/to 为本地日期 YYYY-MM-DD（闭区间），缺省不限。 */
  async report(range: { from?: string; to?: string } = {}): Promise<CostReport> {
    // 先等队列排空（同 readAll），再取指纹：文件只增不轮转，mtimeMs+size 未变即内容未变
    await this.queue.catch(() => {});
    const fingerprint = await this.fingerprint();
    const cacheKey = `${range.from ?? ""}${range.to ?? ""}`;
    const cached = this.reportCache.get(cacheKey);
    if (fingerprint && cached && cached.mtimeMs === fingerprint.mtimeMs && cached.size === fingerprint.size) {
      return { generatedAt: new Date().toISOString(), ...cached.body };
    }
    const events = await this.readAll();
    const totals = mutableMetrics();
    const byDay = new Map<string, MutableMetrics>();
    const byDayProvider = new Map<string, MutableMetrics>();
    const bySession = new Map<string, MutableMetrics>();
    const bySessionProvider = new Map<string, MutableMetrics>();
    const bucket = (map: Map<string, MutableMetrics>, key: string): MutableMetrics => {
      let found = map.get(key);
      if (!found) {
        found = mutableMetrics();
        map.set(key, found);
      }
      return found;
    };

    for (const event of events) {
      const date = localDate(event.at);
      if (date === "") continue;
      if (range.from && date < range.from) continue;
      if (range.to && date > range.to) continue;
      addEvent(totals, event);
      addEvent(bucket(byDay, date), event);
      addEvent(bucket(byDayProvider, `${date}${event.provider}·${event.model}`), event);
      addEvent(bucket(bySession, event.sessionId), event);
      addEvent(bucket(bySessionProvider, `${event.sessionId}${event.provider}·${event.model}`), event);
    }

    const breakdown = (source: Map<string, MutableMetrics>, prefix: string): ProviderBreakdown[] => {
      const rows: ProviderBreakdown[] = [];
      for (const [key, metrics] of source) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const separator = rest.indexOf("·");
        const provider = separator === -1 ? rest : rest.slice(0, separator);
        const model = separator === -1 ? "" : rest.slice(separator + 1);
        rows.push({ provider, model, ...freeze(metrics) });
      }
      return rows.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
    };

    const body: Omit<CostReport, "generatedAt"> = {
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
    if (fingerprint) this.reportCache.set(cacheKey, { mtimeMs: fingerprint.mtimeMs, size: fingerprint.size, body });
    return { generatedAt: new Date().toISOString(), ...body };
  }
}
