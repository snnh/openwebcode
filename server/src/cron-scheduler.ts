import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeUtf8Atomically } from "./atomic-file.js";
import { isMissing } from "./fs-utils.js";

/**
 * 会话内 cron 定时任务（提交⑫）。
 * - 5 字段迷你 cron 解析（分 时 日 月 周；star、star/n、a-b、a-b/n、a,b 列表、单值），
 *   server 本地时区，零新增依赖；非法表达式在创建时拒绝并给出可读错误。
 * - 持久化 <数据目录>/cron.json（原子写）；重启恢复按 createdAt/lastFiredAt 重排下次触发。
 * - 触发经回调注入（agent-runner 的 follow-up 队列）；多次错过只补一次（coalesce）。
 * - recurring 任务 7 天到期后触发最后一次（stale）并自动删除；one-shot 触发一次后删除。
 * - 单 timer（最近触发点重排），不轮询；测试经 now() 注入时钟 + autoSchedule=false 手动 tick。
 */

export const CRON_MAX_JOBS_PER_SESSION = 50;
/** recurring 任务保留期：到期触发最后一次（stale）后自动删除。 */
const CRON_RECURRING_TTL_MS = 7 * 24 * 3_600_000;
/** setTimeout 上限（2^31-1 ms）；超出时截断，唤醒后重排。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** nextCronFire 前向搜索上限（4 年，覆盖闰年组合；找不到视为不可达）。 */
const SEARCH_DAYS = 366 * 4 + 2;

interface CronJob {
  id: string;
  sessionId: string;
  /** 原始 5 字段表达式（已校验）。 */
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: string;
  /** 最近一次触发时间（coalesce 基准；未触发过缺省）。 */
  lastFiredAt?: string;
}

/** REST/工具返回形状（sessionId 由路由参数携带，不重复）。 */
interface CronJobView {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: string;
  nextFireAt: string | null;
  stale: boolean;
}

interface CronDocument {
  version: 1;
  jobs: CronJob[];
}

/** 触发回调：stale=true 表示保留期到期的最后一次触发。 */
type CronFireHandler = (sessionId: string, prompt: string, meta: { stale: boolean; jobId: string }) => Promise<void> | void;

interface CronSchedulerOptions {
  /** cron.json 绝对路径（<数据目录>/cron.json）。 */
  file: string;
  fire: CronFireHandler;
  /** 注入时钟（测试确定性）；缺省 Date.now。 */
  now?: () => number;
  /** false 关闭内部 timer，测试用 check() 手动驱动；缺省 true。 */
  autoSchedule?: boolean;
  /** 后台 check 失败上报（缺省写 stderr）。 */
  onError?: (error: unknown) => void;
}

// ---------------------------------------------------------------------------
// 迷你 cron 解析
// ---------------------------------------------------------------------------

interface CronFields {
  /** 以下均为升序去重数值数组。 */
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  /** 0=周日 … 6=周六（表达式里的 7 已归一为 0）。 */
  dayOfWeek: number[];
  /** true 表示该字段未受限（覆盖完整值域）。 */
  domAny: boolean;
  dowAny: boolean;
}

const FIELD_SPECS = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day-of-week", min: 0, max: 7 },
] as const;

function parseField(spec: string, min: number, max: number, label: string): number[] {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    if (!part) throw new Error(`Invalid cron ${label} field "${spec}": empty list item`);
    const segments = part.split("/");
    if (segments.length > 2) throw new Error(`Invalid cron ${label} item "${part}": too many "/"`);
    const rangePart = segments[0]!;
    const stepPart = segments[1];
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`Invalid cron ${label} step "${stepPart}" (must be a positive integer)`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const match = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
      if (!match) throw new Error(`Invalid cron ${label} value "${rangePart}" (expected number, range a-b, or *)`);
      lo = Number(match[1]);
      // 标准语义：`a/n` 等价 `a-max/n`；单值无步长时 hi=lo
      hi = match[2] !== undefined ? Number(match[2]) : stepPart !== undefined ? max : lo;
      if (lo < min || hi > max) throw new Error(`Cron ${label} value "${rangePart}" out of range ${min}-${max}`);
      if (lo > hi) throw new Error(`Invalid cron ${label} range "${rangePart}" (start > end)`);
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  // day-of-week 的 7 归一为 0（周日）
  if (min === 0 && max === 7 && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return [...values].sort((a, b) => a - b);
}

/** 解析 5 字段 cron 表达式；非法时抛出可读 Error。 */
export function parseCronExpression(expression: string): CronFields {
  if (expression.length > 100) throw new Error("Cron expression is too long (max 100 characters)");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = FIELD_SPECS.map((spec, index) => parseField(parts[index]!, spec.min, spec.max, spec.label)) as [number[], number[], number[], number[], number[]];
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domAny: dayOfMonth.length === 31,
    dowAny: dayOfWeek.length === 7,
  };
}

/** 标准 cron 日匹配：日/周都受限时取或，任一不受限时取另一个。 */
function dayMatches(fields: CronFields, date: Date): boolean {
  if (fields.domAny && fields.dowAny) return true;
  const dom = fields.dayOfMonth.includes(date.getDate());
  const dow = fields.dayOfWeek.includes(date.getDay());
  if (fields.domAny) return dow;
  if (fields.dowAny) return dom;
  return dom || dow;
}

/**
 * afterMs 之后（严格大于）的下一个触发点（本地时区，分钟分辨率）。
 * 4 年内不可达返回 null（如 `0 0 31 2 *` 这类合法但无触发点的表达式）。
 */
export function nextCronFire(fields: CronFields, afterMs: number): number | null {
  const start = new Date(afterMs);
  for (let day = 0; day <= SEARCH_DAYS; day += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    if (!fields.month.includes(date.getMonth() + 1)) continue;
    if (!dayMatches(fields, date)) continue;
    for (const hour of fields.hour) {
      for (const minute of fields.minute) {
        const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime();
        if (at > afterMs) return at;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 调度器
// ---------------------------------------------------------------------------

export class CronScheduler {
  private jobs: CronJob[] = [];
  private timer: NodeJS.Timeout | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly autoSchedule: boolean;
  private readonly onError: (error: unknown) => void;

  constructor(private readonly options: CronSchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.autoSchedule = options.autoSchedule !== false;
    this.onError = options.onError ?? ((error: unknown) => process.stderr.write(`[cron] check failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }

  /** 启动：读取 cron.json 恢复任务，随后立即 check 一次（重启期间错过的触发点 coalesce 补一次）。 */
  async load(): Promise<void> {
    try {
      const document = JSON.parse(await readFile(this.options.file, "utf8")) as CronDocument;
      if (document.version !== 1 || !Array.isArray(document.jobs)) throw new Error("Invalid cron.json");
      this.jobs = document.jobs.filter((job) =>
        job && typeof job.id === "string" && typeof job.sessionId === "string" &&
        typeof job.cron === "string" && typeof job.prompt === "string" &&
        typeof job.createdAt === "string" && typeof job.recurring === "boolean");
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.jobs = [];
    }
    await this.check();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 创建任务：校验表达式、每会话上限 50、表达式须 4 年内可达。 */
  async create(sessionId: string, input: { cron: string; prompt: string; recurring?: boolean }): Promise<CronJobView> {
    const cron = input.cron.trim();
    if (!cron) throw new Error("cron_create requires a cron expression");
    const fields = parseCronExpression(cron);
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("cron_create requires a non-empty prompt");
    if (this.jobs.filter((job) => job.sessionId === sessionId).length >= CRON_MAX_JOBS_PER_SESSION) {
      throw new Error(`Cron job limit reached (${CRON_MAX_JOBS_PER_SESSION} per session)`);
    }
    const nowMs = this.now();
    if (nextCronFire(fields, nowMs) === null) throw new Error(`Cron expression has no fire time within 4 years: ${cron}`);
    const job: CronJob = {
      id: randomUUID(),
      sessionId,
      cron,
      prompt,
      recurring: input.recurring ?? true,
      createdAt: new Date(nowMs).toISOString(),
    };
    this.jobs.push(job);
    await this.persist();
    this.reschedule();
    return this.view(job, nowMs);
  }

  async list(sessionId: string): Promise<CronJobView[]> {
    const nowMs = this.now();
    return this.jobs
      .filter((job) => job.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((job) => this.view(job, nowMs));
  }

  async delete(sessionId: string, id: string): Promise<boolean> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => !(job.sessionId === sessionId && job.id === id));
    if (this.jobs.length === before) return false;
    await this.persist();
    this.reschedule();
    return true;
  }

  /** 会话删除级联：清空该会话全部任务。 */
  async deleteForSession(sessionId: string): Promise<void> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.sessionId !== sessionId);
    if (this.jobs.length === before) return;
    await this.persist();
    this.reschedule();
  }

  /**
   * 到期检查（timer 回调与测试手动驱动共用）：
   * - recurring 超过保留期：stale 触发最后一次并删除；
   * - 理想触发点（lastFiredAt ?? createdAt 之后的第一个 cron 点）已过：触发一次（coalesce，
   *   错过多个点也只补一次），recurring 更新 lastFiredAt，one-shot 删除。
   * fire 失败不阻断其他任务；本条仍推进状态（该次触发丢弃，避免立即重试热循环）。
   */
  async check(): Promise<void> {
    const nowMs = this.now();
    const due: Array<{ job: CronJob; stale: boolean }> = [];
    for (const job of this.jobs) {
      const expiryMs = job.recurring ? Date.parse(job.createdAt) + CRON_RECURRING_TTL_MS : null;
      if (expiryMs !== null && nowMs >= expiryMs) {
        due.push({ job, stale: true });
        continue;
      }
      const referenceMs = Date.parse(job.lastFiredAt ?? job.createdAt);
      const next = nextCronFire(parseCronExpression(job.cron), referenceMs);
      if (next !== null && next <= nowMs) due.push({ job, stale: false });
    }
    for (const { job, stale } of due) {
      try {
        await this.options.fire(job.sessionId, job.prompt, { stale, jobId: job.id });
      } catch (error) {
        this.onError(error);
      }
      if (stale || !job.recurring) {
        this.jobs = this.jobs.filter((entry) => entry.id !== job.id);
      } else {
        job.lastFiredAt = new Date(nowMs).toISOString();
      }
    }
    if (due.length > 0) await this.persist();
    this.reschedule();
  }

  /** 单 timer：重排到最近的下一触发点；无任务时停表。 */
  private reschedule(): void {
    this.stop();
    if (!this.autoSchedule || this.jobs.length === 0) return;
    const nowMs = this.now();
    let nearest: number | null = null;
    for (const job of this.jobs) {
      const at = this.nextActionAt(job, nowMs);
      if (at !== null && (nearest === null || at < nearest)) nearest = at;
    }
    if (nearest === null) return;
    const delay = Math.min(Math.max(nearest - nowMs, 0), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check().catch(this.onError);
    }, delay);
    this.timer.unref();
  }

  /** 任务的下一动作时间：recurring 取 min(下一 cron 点, 保留期到期点)；one-shot 取创建后第一个 cron 点。 */
  private nextActionAt(job: CronJob, nowMs: number): number | null {
    const fields = parseCronExpression(job.cron);
    if (job.recurring) {
      const expiryMs = Date.parse(job.createdAt) + CRON_RECURRING_TTL_MS;
      if (nowMs >= expiryMs) return nowMs;
      const next = nextCronFire(fields, Date.parse(job.lastFiredAt ?? job.createdAt));
      return Math.min(next ?? expiryMs, expiryMs);
    }
    return nextCronFire(fields, Date.parse(job.createdAt));
  }

  private view(job: CronJob, nowMs: number): CronJobView {
    const stale = job.recurring && nowMs >= Date.parse(job.createdAt) + CRON_RECURRING_TTL_MS;
    const next = stale ? null : this.nextActionAt(job, nowMs);
    return {
      id: job.id,
      cron: job.cron,
      prompt: job.prompt,
      recurring: job.recurring,
      createdAt: job.createdAt,
      nextFireAt: next === null ? null : new Date(next).toISOString(),
      stale,
    };
  }

  /** 串行化原子写（同 message-queue 的 writes 链）。 */
  private persist(): Promise<void> {
    const operation = this.writes
      .catch(() => undefined)
      .then(() => writeUtf8Atomically(this.options.file, `${JSON.stringify({ version: 1, jobs: this.jobs } satisfies CronDocument, null, 2)}\n`));
    this.writes = operation;
    return operation;
  }
}
