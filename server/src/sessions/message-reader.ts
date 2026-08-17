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

interface MessagePage<T> {
  messages: T[];
  hasMore: boolean;
  totalLines: number;
  recovery?: { state: "recovered" | "needs_repair"; message: string } | undefined;
}

export const DEFAULT_PAGE_SIZE = 100;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CACHED_INDEXES = 32;
const PREFIX_FINGERPRINT_BYTES = 64;
/** 取消息 id 只解码的行首切片大小：id 是序列化 JSON 的首字段，常规行落在行首几十字节内。 */
const ID_PREFIX_BYTES = 1024;

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

/**
 * list() 的恢复检测：只 stat + 读文件尾部窗口取末条非空记录试解析，
 * 不建全量字节索引（索引留给真正的分页路径 readMessagesTail/readMessagesBefore）。
 * 末条记录比窗口还长（内嵌大 base64 块）时窗口指数扩大，最坏读全文件——
 * 语义与逐行全扫完全一致，只是常见路径 O(尾窗口)。
 */
export async function checkRecoveryTail(filePath: string): Promise<{ recovery?: { state: "recovered" | "needs_repair"; message: string } }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }
  try {
    const info = await handle.stat();
    const last = await readLastRecord(handle, info.size);
    if (last === undefined) return {};
    try {
      JSON.parse(last);
      return {};
    } catch {
      return { recovery: { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" } };
    }
  } finally {
    await handle.close();
  }
}

const TAIL_WINDOW_BYTES = 256 * 1024;

/** 读文件末条非空记录（不含换行符）；文件无记录返回 undefined。窗口不足时指数扩大至全文件。 */
async function readLastRecord(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string | undefined> {
  let window = Math.min(size, TAIL_WINDOW_BYTES);
  for (;;) {
    if (window === 0) return undefined;
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    while (read < window) {
      const result = await handle.read(buffer, read, window - read, size - window + read);
      if (result.bytesRead === 0) throw new Error("messages.jsonl changed while checking its tail");
      read += result.bytesRead;
    }
    // 从窗口尾向前找末条非空记录：记录以 \n 分隔（末尾记录可无终止 \n）
    let end = buffer.length;
    while (end > 0) {
      const newline = buffer.lastIndexOf(0x0a, end - 1);
      const start = newline < 0 ? 0 : newline + 1;
      const text = buffer.subarray(start, end).toString("utf8");
      if (text.trim()) {
        // 记录起点不在窗口内（窗口未覆盖其开头的 \n）说明记录比窗口长：扩大窗口重读
        if (newline < 0 && window < size) break;
        return text;
      }
      if (newline < 0) break;
      end = newline;
    }
    if (window === size) return undefined;
    window = Math.min(size, window * 4);
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
  // 跨块未完结的行分段暂存，遇到换行（或文件尾）才一次性拼接：超长单行
  //（内嵌 base64 截图）不再逐块 Buffer.concat 整体搬运，O(n²) 降为摊还 O(n)。
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let pendingStart = start;
  let fileOffset = start;
  let lastByte: number | undefined;
  const record = (bytes: Buffer, recordStart: number): void => {
    if (isBlankLine(bytes)) return;
    const lineIndex = lines.length;
    lines.push({ start: recordStart, length: bytes.length });
    // 消息 id 恒为序列化 JSON 首字段（本仓库所有写入路径均为 {id, role, content,
    // createdAt} 顺序），常规行 id 落在行首几十字节内：只解码行首切片取 id，避免
    // 超长行（内嵌 base64 截图）的整行 UTF-8 解码与整行正则扫描。
    // 行首切片无匹配（非常规布局的历史/外部文件）时回退整行正则：行首切片内的首个
    // 匹配必然等于整行首个匹配，前缀无匹配时全行扫描与旧实现结果一致，逐字节等价。
    const id = bytes.length <= ID_PREFIX_BYTES
      ? extractId(bytes.toString("utf8"))
      : extractId(bytes.subarray(0, ID_PREFIX_BYTES).toString("utf8")) ?? extractId(bytes.toString("utf8"));
    if (id) byId.set(id, lineIndex);
  };
  // 一行完结：bytes 为该行的完整字节（不含 \n），recordStart 为其文件偏移
  const finishLine = (tail: Buffer, tailOffset: number): void => {
    if (pendingLength === 0) {
      record(tail, tailOffset);
      return;
    }
    pending.push(tail);
    pendingLength += tail.length;
    record(Buffer.concat(pending, pendingLength), pendingStart);
    pending = [];
    pendingLength = 0;
  };
  while (fileOffset < end) {
    const requested = Math.min(buffer.length, end - fileOffset);
    const { bytesRead } = await handle.read(buffer, 0, requested, fileOffset);
    if (bytesRead === 0) throw new Error("messages.jsonl changed while indexing");
    const chunkBase = fileOffset;
    fileOffset += bytesRead;
    lastByte = buffer[bytesRead - 1];
    let lineStart = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      // 完结段在同一块内可直接 subarray（record 同步消费）；跨块暂存段需拷贝
      const segment = pendingLength === 0
        ? buffer.subarray(lineStart, index)
        : Buffer.from(buffer.subarray(lineStart, index));
      finishLine(segment, pendingLength === 0 ? chunkBase + lineStart : pendingStart);
      lineStart = index + 1;
    }
    // 块尾无换行的余段进入暂存（buffer 下一轮复用，必须拷贝）
    if (lineStart < bytesRead) {
      if (pendingLength === 0) pendingStart = chunkBase + lineStart;
      pending.push(Buffer.from(buffer.subarray(lineStart, bytesRead)));
      pendingLength += bytesRead - lineStart;
    }
  }
  if (pendingLength) record(Buffer.concat(pending, pendingLength), pendingStart);
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

/**
 * 逐字节判断一行是否为空白行，语义与 `bytes.toString("utf8").trim() === ""`
 * 完全一致，但不触发整行 UTF-8 解码（超长行的主成本）。等价性依据 ECMA-262
 * 的 WhiteSpace ∪ LineTerminator（String.prototype.trim 移除的字符集）：
 * - ASCII：TAB(0x09)/LF(0x0A)/VT(0x0B)/FF(0x0C)/CR(0x0D)/SP(0x20) 为空白；
 *   其余任意 ASCII（含控制符）非空白（scanRange 按 \n 拆行，行内本不含 LF，
 *   这里一并处理使函数对任意输入等价）；
 * - 多字节：仅当完整序列解码为 trim 空白字符（U+00A0、U+1680、U+2000-200A、
 *   U+2028/2029、U+202F、U+205F、U+3000、U+FEFF）时视为空白；
 * - 其余任何字节（含非法/截断的 UTF-8 序列）经 toString 解码为 U+FFFD
 *   （非空白）→ 整行非空白。
 */
function isBlankLine(bytes: Buffer): boolean {
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte < 0x80) {
      if (byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d || byte === 0x20) {
        index += 1;
        continue;
      }
      return false;
    }
    let length = 0;
    if (byte === 0xc2) length = bytes[index + 1] === 0xa0 ? 2 : 0;
    else if (byte === 0xe1) length = bytes[index + 1] === 0x9a && bytes[index + 2] === 0x80 ? 3 : 0;
    else if (byte === 0xe2) {
      const next = bytes[index + 1];
      if (next === 0x80) {
        const third = bytes[index + 2];
        length = third !== undefined && ((third >= 0x80 && third <= 0x8a) || third === 0xa8 || third === 0xa9 || third === 0xaf) ? 3 : 0;
      } else if (next === 0x81) {
        length = bytes[index + 2] === 0x9f ? 3 : 0;
      } else {
        length = 0;
      }
    } else if (byte === 0xe3) length = bytes[index + 1] === 0x80 && bytes[index + 2] === 0x80 ? 3 : 0;
    else if (byte === 0xef) length = bytes[index + 1] === 0xbb && bytes[index + 2] === 0xbf ? 3 : 0;
    else length = 0;
    if (length === 0) return false;
    index += length;
  }
  return true;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code: string }).code === "ENOENT";
}
