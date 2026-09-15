import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * swarm 共享讨论板：同一次 spawn_swarm 的成员经一个 JSONL 文件互相讨论。
 * 行格式 { id, ts, from, text, kind?, to?, priority?, replyTo? }，另有两种系统贴：
 * roster（kind:"roster"，members 数组记录分工）与 lifecycle（kind:"lifecycle"，成员终态）。
 * 旧行（{ts, from, text}，无 id/kind）向后兼容：读侧补临时序号 id，缺省 kind=finding/广播。
 * 追加写用 fs.appendFile 单条原子写（Windows 多进程并发 append 无需锁）；
 * 全部读写失败静默降级（返回空/假），不拖垮子代理。
 */

/** 成员帖的协作语义分类（办公协作 kind）。 */
export const SWARM_BOARD_KINDS = ["finding", "question", "request", "blocker", "progress", "decision"] as const;
export type SwarmBoardKind = (typeof SWARM_BOARD_KINDS)[number];

export function isSwarmBoardKind(value: string): value is SwarmBoardKind {
  return (SWARM_BOARD_KINDS as readonly string[]).includes(value);
}

/** 系统贴作者署名（roster/lifecycle）。 */
const SWARM_SYSTEM_FROM = "#system";

/** roster 成员条目：分工互相可见（角色/模型/任务摘要）。 */
export interface SwarmRosterMember {
  /** 1 起始的 swarm 内序号。 */
  index: number;
  /** 发帖署名（成员名；重名时 spawn 侧加 -2/-3 后缀保证唯一）。 */
  member: string;
  agent?: string;
  role?: string;
  model?: string;
  /** 填充后 prompt 截断（分工摘要）。 */
  taskExcerpt?: string;
}

export interface SwarmBoardEntry {
  id: string;
  ts: string;
  from: string;
  text: string;
  kind?: string;
  /** 私聊接收人（roster 成员名）；缺省 = 广播。 */
  to?: string;
  priority?: "normal" | "high";
  /** 引用回复的帖 id。 */
  replyTo?: string;
  /** lifecycle 帖：成员生命周期事件。 */
  event?: "started" | "finished" | "failed";
  /** lifecycle 帖：事件所属成员名。 */
  member?: string;
  /** lifecycle 帖：终态原因（截断）。 */
  reason?: string;
  /** roster 帖：成员表。 */
  members?: SwarmRosterMember[];
}

export interface SwarmBoardPostOptions {
  kind?: SwarmBoardKind;
  to?: string;
  priority?: "normal" | "high";
  replyTo?: string;
}

/** 成员最新生命周期状态（由 lifecycle 帖解析，全板扫描）。 */
interface SwarmBoardMemberStatus {
  event: "started" | "finished" | "failed";
  ts: string;
  reason?: string;
}

export interface SwarmBoardReadOptions {
  /** 行偏移增量读（原始文件行号）。 */
  since?: number;
  /** 读侧身份：可见性过滤（公开 + 发给我的 + 我发的）与 @提及识别；缺省不过滤（digest/主 agent 视角）。 */
  viewer?: string;
  /** 仅看指定 kind。 */
  kind?: string;
  /** 仅看指定作者。 */
  from?: string;
  /** 仅看发给指定成员的帖。 */
  to?: string;
  /** 只看我发的/发给我的（需传 viewer）。 */
  mine?: boolean;
}

export interface SwarmBoardRead {
  /** 新段原文（可见帖，含私聊/提及，最近段）。 */
  entries: SwarmBoardEntry[];
  /** 旧段中的私聊/@提及帖原文（不参与聚合，防被聚合统计吞掉）。 */
  priority: SwarmBoardEntry[];
  /** 旧段广播帖的确定性聚合行（>80 条时生成）。 */
  aggregated: string[];
  /** roster 成员表（未写 roster 时为空）。 */
  members: SwarmRosterMember[];
  /** 各成员最新生命周期状态。 */
  memberStatus: Record<string, SwarmBoardMemberStatus>;
  /** 当前总行数，作为下次增量读的 since。 */
  offset: number;
  /** 板上条目总数。 */
  total: number;
}

/** 新段原文上限（条）与字节上限：防爆上下文。 */
const SWARM_BOARD_RECENT_ENTRIES = 50;
const SWARM_BOARD_MAX_BYTES = 8 * 1024;
/** 超过该条数时旧段广播帖进聚合（私聊/提及除外）。 */
const SWARM_BOARD_AGGREGATE_THRESHOLD = 80;
/** 聚合段独立字节预算。 */
const SWARM_BOARD_AGGREGATE_BYTES = 4 * 1024;
/** 优先段（旧段私聊/提及）条数上限。 */
const SWARM_BOARD_PRIORITY_CAP = 20;
/** 汇总摘要里最后几条（digest）。 */
const SWARM_BOARD_DIGEST_TAIL = 3;
/** digest 中 decision/blocker 置顶段各列条数上限。 */
const SWARM_BOARD_DIGEST_PINNED = 5;
/** digest/成员帖子的单条文本截断长度。 */
const SWARM_BOARD_TEXT_LIMIT = 500;
/** roster taskExcerpt 截断长度。 */
export const SWARM_BOARD_EXCERPT_LIMIT = 80;

export function swarmBoardPath(contextRoot: string, swarmId: string): string {
  return path.join(contextRoot, "subagents", `swarm-${swarmId}-board.jsonl`);
}

function newPostId(): string {
  return `p_${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

async function appendLine(boardPath: string, entry: SwarmBoardEntry): Promise<boolean> {
  try {
    await mkdir(path.dirname(boardPath), { recursive: true });
    await appendFile(boardPath, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 追加一条成员帖；失败静默返回 false。text 先截断再写，避免单帖撑爆板。 */
export async function appendSwarmBoard(boardPath: string, from: string, text: string, options?: SwarmBoardPostOptions): Promise<boolean> {
  const entry: SwarmBoardEntry = {
    id: newPostId(),
    ts: new Date().toISOString(),
    from,
    text: text.length > SWARM_BOARD_TEXT_LIMIT ? `${text.slice(0, SWARM_BOARD_TEXT_LIMIT)}…` : text,
    ...(options?.kind ? { kind: options.kind } : {}),
    ...(options?.to ? { to: options.to } : {}),
    ...(options?.priority && options.priority !== "normal" ? { priority: options.priority } : {}),
    ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
  };
  return appendLine(boardPath, entry);
}

/** spawn_swarm 启动时写 roster 系统贴：全员角色/模型/分工互相可见。 */
export async function writeSwarmRoster(boardPath: string, members: SwarmRosterMember[]): Promise<boolean> {
  const summary = members
    .map((member) => {
      const tags = [member.agent, member.role, member.model].filter(Boolean).join("/");
      return `${member.member}${tags ? ` (${tags})` : ""}${member.taskExcerpt ? ` — ${member.taskExcerpt}` : ""}`;
    })
    .join("; ");
  return appendLine(boardPath, {
    id: newPostId(),
    ts: new Date().toISOString(),
    from: SWARM_SYSTEM_FROM,
    kind: "roster",
    text: `Roster: ${summary}`,
    members,
  });
}

/** 成员生命周期系统贴（started/finished/failed）：供 wait 提前退出与全队进度可见。 */
export async function writeSwarmLifecycle(
  boardPath: string,
  member: string,
  event: "started" | "finished" | "failed",
  reason?: string,
): Promise<boolean> {
  return appendLine(boardPath, {
    id: newPostId(),
    ts: new Date().toISOString(),
    from: SWARM_SYSTEM_FROM,
    kind: "lifecycle",
    text: `${member} ${event}${reason ? `: ${truncate(reason, 200)}` : ""}`,
    event,
    member,
    ...(reason ? { reason: truncate(reason, 200) } : {}),
  });
}

/** 从 lifecycle 帖还原成员状态（新格式用 member 字段；旧格式无 lifecycle 帖，无需兼容）。 */
function parseLifecycle(entry: SwarmBoardEntry): { member: string; event: "started" | "finished" | "failed"; reason?: string } | undefined {
  if (entry.kind !== "lifecycle" || !entry.event || !entry.member) return undefined;
  return { member: entry.member, event: entry.event, ...(entry.reason ? { reason: entry.reason } : {}) };
}

/** 可见性过滤：广播（无 to）全员可见；私聊仅收发双方可见；无 viewer（digest/主 agent）不过滤。 */
function visibleTo(entry: SwarmBoardEntry, viewer: string | undefined): boolean {
  if (!viewer || !entry.to) return true;
  return entry.to === viewer || entry.from === viewer;
}

/** @提及判定：广播帖文本含 @成员名。 */
function mentions(entry: SwarmBoardEntry, viewer: string | undefined): boolean {
  return !!viewer && entry.from !== viewer && entry.text.includes(`@${viewer}`);
}

/** 私聊（发给我的）或 @提及我的帖：进优先段、不参与聚合。 */
function isPriorityFor(entry: SwarmBoardEntry, viewer: string | undefined): boolean {
  if (!viewer) return false;
  return (entry.to === viewer && entry.from !== viewer) || mentions(entry, viewer);
}

/** 读板：since 为行偏移增量读；viewer 触发可见性过滤与提及识别。 */
export async function readSwarmBoard(boardPath: string, options: SwarmBoardReadOptions = {}): Promise<SwarmBoardRead> {
  const lines = await readLines(boardPath);
  const total = lines.length;
  const since = options.since;
  const start = Number.isInteger(since) && since !== undefined && since > 0 ? Math.min(since, total) : 0;

  // 全板解析（roster/memberStatus 需要完整视图；板很小，成本可忽略）
  const parsed: Array<SwarmBoardEntry | undefined> = lines.map((line, index) => parseLine(line, index));
  let members: SwarmRosterMember[] = [];
  const memberStatus: Record<string, SwarmBoardMemberStatus> = {};
  for (const entry of parsed) {
    if (!entry) continue;
    if (entry.kind === "roster" && Array.isArray(entry.members)) members = entry.members;
    const lifecycle = parseLifecycle(entry);
    if (lifecycle) memberStatus[lifecycle.member] = { event: lifecycle.event, ts: entry.ts, ...(lifecycle.reason ? { reason: lifecycle.reason } : {}) };
  }

  // 内容窗口：since 之后 + 可见性 + 过滤条件；roster 帖不进内容流（经 members 呈现）
  const windowEntries = parsed.slice(start).filter((entry): entry is SwarmBoardEntry => {
    if (!entry) return false;
    if (entry.kind === "roster") return false;
    if (!visibleTo(entry, options.viewer)) return false;
    // 旧行 kind 缺省按 finding 语义参与过滤
    if (options.kind && (entry.kind ?? "finding") !== options.kind) return false;
    if (options.from && entry.from !== options.from) return false;
    if (options.to && entry.to !== options.to) return false;
    if (options.mine && options.viewer && entry.from !== options.viewer && entry.to !== options.viewer) return false;
    return true;
  });

  let priority: SwarmBoardEntry[] = [];
  let aggregated: string[] = [];
  let entries = windowEntries;
  if (windowEntries.length > SWARM_BOARD_AGGREGATE_THRESHOLD) {
    const oldSegment = windowEntries.slice(0, windowEntries.length - SWARM_BOARD_RECENT_ENTRIES);
    entries = windowEntries.slice(windowEntries.length - SWARM_BOARD_RECENT_ENTRIES);
    // 私聊/@提及帖不进聚合：原文进优先段；lifecycle 系统贴由 memberStatus 承载，不进聚合
    priority = oldSegment.filter((entry) => isPriorityFor(entry, options.viewer)).slice(-SWARM_BOARD_PRIORITY_CAP);
    aggregated = aggregateBroadcast(oldSegment.filter((entry) =>
      entry.kind !== "lifecycle" && !entry.to && !mentions(entry, options.viewer)));
  }

  // 8KB 上限：从头丢弃，保留最新
  let bytes = Buffer.byteLength(entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  while (entries.length > 1 && bytes > SWARM_BOARD_MAX_BYTES) {
    bytes -= Buffer.byteLength(JSON.stringify(entries[0]), "utf8") + 1;
    entries = entries.slice(1);
  }
  return { entries, priority, aggregated, members, memberStatus, offset: total, total };
}

/** 旧段广播帖的确定性聚合：按成员+kind 统计条数与首末帖摘要，4KB 预算截断。 */
function aggregateBroadcast(entries: SwarmBoardEntry[]): string[] {
  const groups = new Map<string, { count: number; first: string; last: string }>();
  for (const entry of entries) {
    const key = `${entry.from} · ${entry.kind ?? "finding"}`;
    const group = groups.get(key);
    const summary = truncate(entry.text.replace(/\s+/g, " "), 60);
    if (group) {
      group.count += 1;
      group.last = summary;
    } else {
      groups.set(key, { count: 1, first: summary, last: summary });
    }
  }
  const lines: string[] = [];
  let bytes = 0;
  for (const [key, group] of groups) {
    const line = group.count > 1
      ? `${key} ×${group.count} (first: "${group.first}" last: "${group.last}")`
      : `${key}: "${group.first}"`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > SWARM_BOARD_AGGREGATE_BYTES && lines.length > 0) {
      lines.push(`…(${groups.size - lines.length} more groups)`);
      break;
    }
    bytes += lineBytes;
    lines.push(line);
  }
  return lines;
}

/** 汇总摘要（spawn_swarm 回传给主 agent 的 boardDigest）：kind 分组统计 + decision/blocker 置顶段 + 末帖段。 */
export async function digestSwarmBoard(boardPath: string): Promise<string | undefined> {
  const lines = await readLines(boardPath);
  const entries = lines.map((line, index) => parseLine(line, index)).filter((entry): entry is SwarmBoardEntry => entry !== undefined);
  const memberPosts = entries.filter((entry) => entry.from !== SWARM_SYSTEM_FROM);
  if (memberPosts.length === 0) return undefined;
  const byKind = new Map<string, number>();
  const perMember = new Map<string, number>();
  for (const entry of memberPosts) {
    byKind.set(entry.kind ?? "finding", (byKind.get(entry.kind ?? "finding") ?? 0) + 1);
    perMember.set(entry.from, (perMember.get(entry.from) ?? 0) + 1);
  }
  const kindCounts = [...byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(", ");
  const memberCounts = [...perMember.entries()].map(([from, count]) => `${from}=${count}`).join(", ");
  const pinned = (kind: string): string => {
    const list = memberPosts.filter((entry) => entry.kind === kind).slice(-SWARM_BOARD_DIGEST_PINNED);
    if (list.length === 0) return "";
    return `\n${kind === "decision" ? "Decisions" : "Blockers"}:\n${list.map((entry) => `- [${entry.from}] ${truncate(entry.text, 120)}`).join("\n")}`;
  };
  const tail = memberPosts.slice(-SWARM_BOARD_DIGEST_TAIL)
    .map((entry) => `- [${entry.from}] ${truncate(entry.text, 120)}`)
    .join("\n");
  return `Board: ${boardPath} (${memberPosts.length} entries; by kind: ${kindCounts}; member posts: ${memberCounts})${pinned("decision")}${pinned("blocker")}\nLast entries:\n${tail}`;
}

type SwarmWaitOutcome = "hit" | "terminal" | "timeout" | "aborted";

export interface SwarmWaitOptions {
  /** 等待者身份（可见性过滤 + toMe/提及判定）。 */
  viewer: string;
  /** 等指定成员的任意新帖。 */
  from?: string;
  /** 等发给我的私聊或 @我（from/any 均未给时的默认）。 */
  toMe?: boolean;
  /** 等任意新帖。 */
  any?: boolean;
  /** 行偏移（缺省从当前末尾等起）。 */
  since?: number;
  /** 超时秒数（默认 120，上限 300）。 */
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface SwarmWaitResult {
  outcome: SwarmWaitOutcome;
  /** 命中时的新帖（可见范围内，不含自己发的）。 */
  entries: SwarmBoardEntry[];
  /** 最新行偏移（下次 read/wait 的 since）。 */
  offset: number;
  note?: string;
}

const SWARM_WAIT_DEFAULT_TIMEOUT = 120;
const SWARM_WAIT_MAX_TIMEOUT = 300;
/** fs.watch 不可用时回落轮询间隔。 */
const SWARM_WAIT_POLL_MS = 1000;
/** watch 事件去抖：发帖 burst 合并成一次唤醒。 */
const SWARM_WAIT_DEBOUNCE_MS = 100;

/**
 * swarm_wait：等待板上出现满足条件的新帖。唤醒条件三态：
 * from=指定成员任意新帖；toMe（默认）=发给我的私聊或 @我；any=任意新帖。
 * from 模式下目标成员到达终态（finished/failed）且无新帖时提前返回 terminal。
 * fs.watch 监听板文件（失败回落 1s 轮询），signal 中止。本函数不抛错（中止除外由 outcome 表达）。
 */
export async function waitSwarmBoard(boardPath: string, options: SwarmWaitOptions): Promise<SwarmWaitResult> {
  const timeoutSeconds = Number.isInteger(options.timeoutSeconds) && options.timeoutSeconds! > 0
    ? Math.min(options.timeoutSeconds!, SWARM_WAIT_MAX_TIMEOUT)
    : SWARM_WAIT_DEFAULT_TIMEOUT;
  const deadline = Date.now() + timeoutSeconds * 1000;
  const mode: "from" | "any" | "toMe" = options.from ? "from" : options.any ? "any" : "toMe";
  let offset = options.since ?? (await readSwarmBoard(boardPath)).offset;

  for (;;) {
    if (options.signal?.aborted) return { outcome: "aborted", entries: [], offset };
    const read = await readSwarmBoard(boardPath, { since: offset, viewer: options.viewer });
    const visible = [...read.priority, ...read.entries];
    const fresh = visible.filter((entry) => entry.from !== options.viewer && entry.from !== SWARM_SYSTEM_FROM);
    const hits = fresh.filter((entry) => {
      if (mode === "from") return entry.from === options.from;
      if (mode === "any") return true;
      return entry.to === options.viewer || mentions(entry, options.viewer);
    });
    if (hits.length > 0) return { outcome: "hit", entries: hits, offset: read.offset };
    // from 模式：目标成员终态且无新帖 → 提前返回（不傻等满超时）
    if (mode === "from") {
      const status = read.memberStatus[options.from!];
      if (status && status.event !== "started") {
        return {
          outcome: "terminal",
          entries: [],
          offset: read.offset,
          note: `${options.from} ${status.event}${status.reason ? `: ${status.reason}` : ""} (no new posts)`,
        };
      }
    }
    // 注：toMe/any 模式不做「全员终态提前退出」——只承诺 from 模式语义（计划边界）。
    offset = read.offset;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { outcome: "timeout", entries: [], offset, note: `timeout after ${timeoutSeconds}s` };
    await waitForBoardChange(boardPath, remaining, options.signal);
  }
}

/** 等待板文件变化：优先 fs.watch（事件去抖 100ms）；watch 不可用回落 1s 轮询切片。 */
function waitForBoardChange(boardPath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let watcher: FSWatcher | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (debounce) clearTimeout(debounce);
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    let watchOk = false;
    try {
      watcher = watch(boardPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(done, SWARM_WAIT_DEBOUNCE_MS);
      });
      watcher.on("error", done);
      watchOk = true;
    } catch {
      watchOk = false;
    }
    // 回落轮询：watch 打开失败（如文件尚不存在）时 1s 切片返回，由外层循环重读
    if (!watchOk) setTimeout(done, Math.min(SWARM_WAIT_POLL_MS, timeoutMs));
    if (signal) {
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    }
  });
}

async function readLines(boardPath: string): Promise<string[]> {
  try {
    const raw = await readFile(boardPath, "utf8");
    return raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/** 行解析：旧行（无 id/kind）兼容——读侧补临时序号 id，缺省 kind 留空（按 finding 语义处理）。 */
function parseLine(line: string, lineIndex: number): SwarmBoardEntry | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.from !== "string" || typeof value.text !== "string") return undefined;
    const entry: SwarmBoardEntry = {
      id: typeof value.id === "string" && value.id ? value.id : `l${lineIndex + 1}`,
      ts: typeof value.ts === "string" ? value.ts : "",
      from: value.from,
      text: value.text,
    };
    if (typeof value.kind === "string") entry.kind = value.kind;
    if (typeof value.to === "string") entry.to = value.to;
    if (value.priority === "normal" || value.priority === "high") entry.priority = value.priority;
    if (typeof value.replyTo === "string") entry.replyTo = value.replyTo;
    if (value.event === "started" || value.event === "finished" || value.event === "failed") entry.event = value.event;
    if (typeof value.member === "string") entry.member = value.member;
    if (typeof value.reason === "string") entry.reason = value.reason;
    if (Array.isArray(value.members)) {
      entry.members = value.members.filter((member): member is SwarmRosterMember =>
        !!member && typeof member === "object" &&
        typeof (member as SwarmRosterMember).index === "number" &&
        typeof (member as SwarmRosterMember).member === "string");
    }
    return entry;
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
