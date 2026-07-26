/**
 * Indexed, bounded-memory JSONL message reading for session pagination.
 *
 * The first access builds an in-memory byte-offset index without parsing every
 * JSON object. Later pages stat the file and read only their byte range. The
 * append-only growth extends the cached index from the previous EOF after a
 * bounded tail-integrity check. Rewrites fall back to a full rebuild. The
 * cache is LRU-bounded across sessions.
 */
import { open, stat } from "node:fs/promises";

export interface MessagePage<T> {
  messages: T[];
  hasMore: boolean;
  totalLines: number;
  recovery?: { state: "recovered" | "needs_repair"; message: string } | undefined;
}

export const DEFAULT_PAGE_SIZE = 100;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CACHED_INDEXES = 32;
const PREFIX_FINGERPRINT_BYTES = 64;

interface LineRef { start: number; length: number }
interface MessageFileIndex {
  size: number;
  modifiedMs: number;
  changedMs: number;
  device: number;
  inode: number;
  endsWithNewline: boolean;
  prefixTail: Buffer;
  lines: LineRef[];
  byId: Map<string, number>;
}

const indexes = new Map<string, MessageFileIndex>();

export async function readMessagesTail<T>(filePath: string, limit: number = DEFAULT_PAGE_SIZE): Promise<MessagePage<T>> {
  try {
    const index = await getIndex(filePath);
    if (index.lines.length === 0) return { messages: [], hasMore: false, totalLines: 0 };
    const refs = index.lines.slice(Math.max(0, index.lines.length - limit));
    const lines = await readLines(filePath, refs);
    const { messages, recovery } = parsePage<T>(lines, true);
    return { messages, hasMore: index.lines.length > limit, totalLines: index.lines.length, recovery };
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { messages: [], hasMore: false, totalLines: 0, recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }
}

export async function readMessagesBefore<T>(filePath: string, beforeId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<MessagePage<T>> {
  try {
    const index = await getIndex(filePath);
    const target = index.byId.get(beforeId);
    if (target === undefined) return { messages: [], hasMore: false, totalLines: index.lines.length };
    const start = Math.max(0, target - limit);
    const lines = await readLines(filePath, index.lines.slice(start, target));
    return { messages: parsePage<T>(lines, false).messages, hasMore: start > 0, totalLines: index.lines.length };
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { messages: [], hasMore: false, totalLines: 0, recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }
}

export async function checkRecovery(filePath: string): Promise<{ recovery?: { state: "recovered" | "needs_repair"; message: string } }> {
  try {
    const index = await getIndex(filePath);
    const last = index.lines.at(-1);
    if (!last) return {};
    const [line] = await readLines(filePath, [last]);
    try {
      JSON.parse(line!);
      return {};
    } catch {
      return { recovery: { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" } };
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }
}

async function getIndex(filePath: string): Promise<MessageFileIndex> {
  const info = await stat(filePath);
  const cached = indexes.get(filePath);
  if (cached && cached.size === info.size && cached.modifiedMs === info.mtimeMs && cached.changedMs === info.ctimeMs) {
    indexes.delete(filePath);
    indexes.set(filePath, cached);
    return cached;
  }

  if (cached && info.size > cached.size && cached.endsWithNewline && cached.device === info.dev && cached.inode === info.ino) {
    const handle = await open(filePath, "r");
    try {
      const prefixTail = await readTail(handle, cached.size);
      if (prefixTail.equals(cached.prefixTail)) {
        const scan = await scanRange(handle, cached.size, info.size, cached.lines, cached.byId);
        cached.size = info.size;
        cached.modifiedMs = info.mtimeMs;
        cached.changedMs = info.ctimeMs;
        cached.endsWithNewline = scan.endsWithNewline;
        cached.prefixTail = await readTail(handle, info.size);
        touchIndex(filePath, cached);
        return cached;
      }
    } catch {
      // A concurrent rewrite/read failure invalidates the partially extended
      // entry. The full rebuild below starts from authoritative file bytes.
      indexes.delete(filePath);
    } finally {
      await handle.close();
    }
  }

  const lines: LineRef[] = [];
  const byId = new Map<string, number>();
  const handle = await open(filePath, "r");
  let scan: { endsWithNewline: boolean };
  let prefixTail: Buffer;
  try {
    scan = await scanRange(handle, 0, info.size, lines, byId);
    prefixTail = await readTail(handle, info.size);
  } finally {
    await handle.close();
  }

  const built = {
    size: info.size,
    modifiedMs: info.mtimeMs,
    changedMs: info.ctimeMs,
    device: info.dev,
    inode: info.ino,
    endsWithNewline: scan.endsWithNewline,
    prefixTail,
    lines,
    byId,
  };
  touchIndex(filePath, built);
  return built;
}

async function scanRange(handle: Awaited<ReturnType<typeof open>>, start: number, end: number, lines: LineRef[], byId: Map<string, number>): Promise<{ endsWithNewline: boolean }> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let remainder = Buffer.alloc(0);
  let fileOffset = start;
  let lastByte: number | undefined;
  const record = (bytes: Buffer, recordStart: number): void => {
    const text = bytes.toString("utf8");
    if (!text.trim()) return;
    const lineIndex = lines.length;
    lines.push({ start: recordStart, length: bytes.length });
    const id = extractId(text);
    if (id) byId.set(id, lineIndex);
  };
  while (fileOffset < end) {
    const requested = Math.min(buffer.length, end - fileOffset);
    const { bytesRead } = await handle.read(buffer, 0, requested, fileOffset);
    if (bytesRead === 0) throw new Error("messages.jsonl changed while indexing");
    const dataBase = fileOffset - remainder.length;
    const incoming = buffer.subarray(0, bytesRead);
    const data = remainder.length ? Buffer.concat([remainder, incoming]) : incoming;
    fileOffset += bytesRead;
    lastByte = incoming[bytesRead - 1];
    let lineStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      record(data.subarray(lineStart, index), dataBase + lineStart);
      lineStart = index + 1;
    }
    remainder = Buffer.from(data.subarray(lineStart));
  }
  if (remainder.length) record(remainder, end - remainder.length);
  return { endsWithNewline: end === 0 || lastByte === 0x0a };
}

async function readTail(handle: Awaited<ReturnType<typeof open>>, end: number): Promise<Buffer> {
  const length = Math.min(PREFIX_FINGERPRINT_BYTES, end);
  const tail = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(tail, read, length - read, end - length + read);
    if (result.bytesRead === 0) throw new Error("messages.jsonl changed while validating its index");
    read += result.bytesRead;
  }
  return tail;
}

function touchIndex(filePath: string, index: MessageFileIndex): void {
  indexes.delete(filePath);
  indexes.set(filePath, index);
  while (indexes.size > MAX_CACHED_INDEXES) indexes.delete(indexes.keys().next().value!);
}

/** Read one contiguous page range, then slice individual UTF-8 records. */
async function readLines(filePath: string, refs: LineRef[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const first = refs[0]!;
  const last = refs.at(-1)!;
  const length = last.start + last.length - first.start;
  const bytes = Buffer.allocUnsafe(length);
  const handle = await open(filePath, "r");
  let read = 0;
  try {
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, first.start + read);
      if (result.bytesRead === 0) throw new Error("messages.jsonl changed while reading a page");
      read += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return refs.map((ref) => bytes.subarray(ref.start - first.start, ref.start - first.start + ref.length).toString("utf8"));
}

function parsePage<T>(lines: string[], detectRecovery: boolean): { messages: T[]; recovery?: MessagePage<T>["recovery"] } {
  const messages: T[] = [];
  let corruptTail = false;
  let corruptMiddle = false;
  for (let index = 0; index < lines.length; index += 1) {
    try { messages.push(JSON.parse(lines[index]!) as T); }
    catch {
      if (detectRecovery && index === lines.length - 1) corruptTail = true;
      else corruptMiddle = true;
    }
  }
  if (corruptMiddle) return { messages, recovery: { state: "needs_repair", message: "messages.jsonl contains corrupt non-tail records" } };
  if (corruptTail) return { messages, recovery: { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" } };
  return { messages };
}

function extractId(line: string): string | undefined {
  return /"id"\s*:\s*"([0-9a-f-]{36})"/.exec(line)?.[1];
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code: string }).code === "ENOENT";
}
