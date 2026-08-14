import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * swarm 共享讨论板：同一次 spawn_swarm 的成员经一个 JSONL 文件互相讨论。
 * 每行一条 { ts, from, text }；from 为成员标识（成员名或 taskId）。
 * 追加写用 fs.appendFile 单条原子写（Windows 多进程并发 append 无需锁）；
 * 全部读写失败静默降级（返回空/假），不拖垮子代理。
 */

interface SwarmBoardEntry {
  ts: string;
  from: string;
  text: string;
}

/** read 结果上限：最多最后 50 条 / 8KB，防爆上下文。 */
const SWARM_BOARD_MAX_ENTRIES = 50;
const SWARM_BOARD_MAX_BYTES = 8 * 1024;
/** 汇总摘要里最后几条（digest）。 */
const SWARM_BOARD_DIGEST_TAIL = 3;
/** digest/成员帖子的单条文本截断长度。 */
const SWARM_BOARD_TEXT_LIMIT = 500;

export function swarmBoardPath(contextRoot: string, swarmId: string): string {
  return path.join(contextRoot, "subagents", `swarm-${swarmId}-board.jsonl`);
}

/** 追加一条帖子；失败静默返回 false。text 先截断再写，避免单帖撑爆板。 */
export async function appendSwarmBoard(boardPath: string, from: string, text: string): Promise<boolean> {
  try {
    const entry: SwarmBoardEntry = {
      ts: new Date().toISOString(),
      from,
      text: text.length > SWARM_BOARD_TEXT_LIMIT ? `${text.slice(0, SWARM_BOARD_TEXT_LIMIT)}…` : text,
    };
    await mkdir(path.dirname(boardPath), { recursive: true });
    await appendFile(boardPath, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

interface SwarmBoardRead {
  entries: SwarmBoardEntry[];
  /** 当前总行数，作为下次增量读的 since。 */
  offset: number;
  /** 板上条目总数。 */
  total: number;
}

/** 读板：since 为行偏移增量读；结果限最后 50 条 / 8KB。文件不存在或损坏按空板处理。 */
export async function readSwarmBoard(boardPath: string, since = 0): Promise<SwarmBoardRead> {
  const lines = await readLines(boardPath);
  const total = lines.length;
  const start = Number.isInteger(since) && since > 0 ? Math.min(since, total) : 0;
  let entries = lines.slice(start).map(parseLine).filter((entry): entry is SwarmBoardEntry => entry !== undefined);
  if (entries.length > SWARM_BOARD_MAX_ENTRIES) entries = entries.slice(entries.length - SWARM_BOARD_MAX_ENTRIES);
  // 8KB 上限：从头丢弃，保留最新
  let bytes = Buffer.byteLength(entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  while (entries.length > 1 && bytes > SWARM_BOARD_MAX_BYTES) {
    bytes -= Buffer.byteLength(JSON.stringify(entries[0]), "utf8") + 1;
    entries = entries.slice(1);
  }
  return { entries, offset: total, total };
}

/** 汇总摘要（spawn_swarm 回传给主 agent 的 boardDigest）：路径、总条数、各成员发帖数、最后几条。 */
export async function digestSwarmBoard(boardPath: string): Promise<string | undefined> {
  const lines = await readLines(boardPath);
  const entries = lines.map(parseLine).filter((entry): entry is SwarmBoardEntry => entry !== undefined);
  if (entries.length === 0) return undefined;
  const perMember = new Map<string, number>();
  for (const entry of entries) perMember.set(entry.from, (perMember.get(entry.from) ?? 0) + 1);
  const counts = [...perMember.entries()].map(([from, count]) => `${from}=${count}`).join(", ");
  const tail = entries.slice(-SWARM_BOARD_DIGEST_TAIL)
    .map((entry) => `- [${entry.from}] ${truncate(entry.text, 120)}`)
    .join("\n");
  return `Board: ${boardPath} (${entries.length} entries; member posts: ${counts})\nLast entries:\n${tail}`;
}

async function readLines(boardPath: string): Promise<string[]> {
  try {
    const raw = await readFile(boardPath, "utf8");
    return raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function parseLine(line: string): SwarmBoardEntry | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.from !== "string" || typeof value.text !== "string") return undefined;
    return { ts: typeof value.ts === "string" ? value.ts : "", from: value.from, text: value.text };
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
