/**
 * Indexed, bounded-memory JSONL message reading for session pagination.
 *
 * The first access builds an in-memory byte-offset index without parsing every
 * JSON object. Later pages stat the file and read only their byte range. The
 * append-only growth extends the cached index from the previous EOF after a
 * bounded tail-integrity check. Rewrites fall back to a full rebuild. The
 * cache is LRU-bounded across sessions and additionally released when idle
 * (see cache-policy.ts / sessionCacheIdleMinutes).
 */
import { open, stat } from "node:fs/promises";
import { isCacheEntryIdle } from "../cache-policy.js";

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
  /** 最近一次命中/重建时间：空闲逐出用（见 cache-policy.ts） */
  lastAccess: number;
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
 * 活动段读取：从 boundaryId 所在行（**含边界行**）读到文件尾。
 * 用途：agent run 热路径只驻留「/clear 或压缩锚点之后」的活动段而非整表。
 * 段首即边界消息——buildView 的 clearIndexIn/compactionIndexIn 按 id 命中返回 index+1
 * 正好裁掉它，边界语义与整表空间自动一致（调用方零适配）。
 * 回退义务在调用方：boundaryFound=false（边界 id 已被截断/改写抹掉）或
 * leafInSegment=false（requireId=activeLeafId 在边界之下——用户分叉回历史）时回退整表读。
 * 索引复用分页路径的同一字节索引（只解码行首 id，不整表 JSON.parse）。
 */
export async function readMessagesAfter<T>(filePath: string, boundaryId: string, opts?: { requireId?: string }): Promise<{
  messages: T[];
  boundaryFound: boolean;
  leafInSegment: boolean;
  /** 段覆盖的文件字节数（含边界行；缓存驻留权重估算用） */
  segmentBytes: number;
  totalLines: number;
  recovery?: MessagePage<T>["recovery"];
}> {
  try {
    const index = await getIndex(filePath);
    const boundaryLine = index.byId.get(boundaryId);
    if (boundaryLine === undefined) {
      return { messages: [], boundaryFound: false, leafInSegment: false, segmentBytes: 0, totalLines: index.lines.length };
    }
    if (opts?.requireId !== undefined) {
      const requireLine = index.byId.get(opts.requireId);
      if (requireLine === undefined || requireLine < boundaryLine) {
        return { messages: [], boundaryFound: true, leafInSegment: false, segmentBytes: 0, totalLines: index.lines.length };
      }
    }
    const refs = index.lines.slice(boundaryLine);
    const lines = await readLines(filePath, refs);
    const { messages, recovery } = parsePage<T>(lines, true);
    let segmentBytes = 0;
    for (const ref of refs) segmentBytes += ref.length;
    return { messages, boundaryFound: true, leafInSegment: true, segmentBytes, totalLines: index.lines.length, ...(recovery ? { recovery } : {}) };
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { messages: [], boundaryFound: false, leafInSegment: false, segmentBytes: 0, totalLines: 0, recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }
}

/**
 * 头部有界读取：只解析文件前 limit 条非空记录后立刻停止（不做整表解析）。
 * 用于「只取决于首条用户消息」的派生标题等场景：大历史不必整表解析，也不建索引。
 */
export async function readMessagesHead<T>(filePath: string, limit: number): Promise<T[]> {
  const messages: T[] = [];
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return messages;
  }
  try {
    const info = await handle.stat();
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let fileOffset = 0;
    let stop = false;
    const consume = (bytes: Buffer): boolean => {
      if (isBlankLine(bytes)) return false;
      try {
        messages.push(JSON.parse(bytes.toString("utf8")) as T);
      } catch {
        // 头部读取不判定恢复状态：损坏记录跳过（调用方只会拿它派生标题）
      }
      return messages.length >= limit;
    };
    while (!stop && fileOffset < info.size) {
      const requested = Math.min(buffer.length, info.size - fileOffset);
      const { bytesRead } = await handle.read(buffer, 0, requested, fileOffset);
      if (bytesRead === 0) break;
      fileOffset += bytesRead;
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        const tail = buffer.subarray(lineStart, index);
        if (pendingLength === 0) stop = consume(tail);
        else {
          pending.push(Buffer.from(tail));
          pendingLength += tail.length;
          stop = consume(Buffer.concat(pending, pendingLength));
          pending = [];
          pendingLength = 0;
        }
        lineStart = index + 1;
        if (stop) break;
      }
      if (!stop && lineStart < bytesRead) {
        pending.push(Buffer.from(buffer.subarray(lineStart, bytesRead)));
        pendingLength += bytesRead - lineStart;
      }
    }
    if (!stop && pendingLength) consume(Buffer.concat(pending, pendingLength));
    return messages;
  } finally {
    await handle.close();
  }
}

/**
 * 整表读取（**不驻留**）：分块扫描 + 逐行 JSON.parse，返回解析后的消息数组。
 *
 * 与 readMessagesTail/Before 的区别：那两个走字节索引只读一部分；这里要全部消息，
 * 所以不建索引也不保留行数组/偏移表——峰值内存 = 64KB 块缓冲 + 解析后的消息对象本身，
 * 取代原先把整份文件读成字符串再 split 的做法（后者在 56MB 会话上要多复制 ~112MB
 * UTF-16 字符串并同时驻留全部行）。
 *
 * 恢复语义与 parsePage 一致：仅末条非空记录可损坏（recovered），更早的损坏行升格 needs_repair。
 * 调用方拿到数组后自行决定是否驻留（会话 store 按堆字节预算 + 空闲阈值决定缓存）。
 */
export async function readAllMessages<T>(filePath: string): Promise<{ messages: T[]; recovery?: MessagePage<T>["recovery"] }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { messages: [], recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }
  try {
    const info = await handle.stat();
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const messages: T[] = [];
    // 跨块未完结的行分段（超长单行：内嵌 base64 截图）
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let fileOffset = 0;
    // 非空行序号与「第几条非空行解析失败」：只保留计数，不驻留行文本
    let nonBlank = 0;
    let lastCorrupt = -1;
    const consume = (bytes: Buffer): void => {
      if (isBlankLine(bytes)) return;
      nonBlank += 1;
      try {
        messages.push(JSON.parse(bytes.toString("utf8")) as T);
      } catch {
        lastCorrupt = nonBlank;
      }
    };
    while (fileOffset < info.size) {
      const requested = Math.min(buffer.length, info.size - fileOffset);
      const { bytesRead } = await handle.read(buffer, 0, requested, fileOffset);
      if (bytesRead === 0) throw new Error("messages.jsonl changed while reading");
      fileOffset += bytesRead;
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        const tail = buffer.subarray(lineStart, index);
        if (pendingLength === 0) consume(tail);
        else {
          pending.push(Buffer.from(tail));
          pendingLength += tail.length;
          consume(Buffer.concat(pending, pendingLength));
          pending = [];
          pendingLength = 0;
        }
        lineStart = index + 1;
      }
      if (lineStart < bytesRead) {
        pending.push(Buffer.from(buffer.subarray(lineStart, bytesRead)));
        pendingLength += bytesRead - lineStart;
      }
    }
    if (pendingLength) consume(Buffer.concat(pending, pendingLength));
    if (lastCorrupt < 0) return { messages };
    if (lastCorrupt === nonBlank) {
      return { messages, recovery: { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" } };
    }
    return { messages, recovery: { state: "needs_repair", message: "messages.jsonl contains corrupt non-tail records" } };
  } finally {
    await handle.close();
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
      JSON.parse(last.text);
      return {};
    } catch {
      return { recovery: { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" } };
    }
  } finally {
    await handle.close();
  }
}

/** 末条非空记录的位置与文本（text 不含换行符）。 */
export interface LastRecordRange {
  /** 记录首字节的文件偏移。 */
  start: number;
  /** 记录末字节之后的文件偏移（不含终止换行）。 */
  end: number;
  text: string;
  /** 记录之后是否紧跟换行符（false 表示文件未以 \n 终止）。 */
  terminated: boolean;
}

/**
 * 读文件末条非空记录的位置与文本；文件不存在或无记录返回 undefined。
 * 供读侧恢复检测（checkRecoveryTail）与写侧的尾行修复（截掉损坏尾记录）共用。
 */
export async function readLastRecordRange(filePath: string): Promise<LastRecordRange | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return undefined;
  }
  try {
    const info = await handle.stat();
    return await readLastRecord(handle, info.size);
  } finally {
    await handle.close();
  }
}

const TAIL_WINDOW_BYTES = 256 * 1024;

/** 读文件末条非空记录（不含换行符）；文件无记录返回 undefined。窗口不足时指数扩大至全文件。 */
async function readLastRecord(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<LastRecordRange | undefined> {
  let window = Math.min(size, TAIL_WINDOW_BYTES);
  for (;;) {
    if (window === 0) return undefined;
    const base = size - window;
    const buffer = Buffer.allocUnsafe(window);
    let read = 0;
    while (read < window) {
      const result = await handle.read(buffer, read, window - read, base + read);
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
        return { start: base + start, end: base + end, text, terminated: end < buffer.length };
      }
      if (newline < 0) break;
      end = newline;
    }
    if (window === size) return undefined;
    window = Math.min(size, window * 4);
  }
}

/**
 * 主动失效某文件的字节索引缓存（B7）。
 *
 * 索引缓存只以 size+mtimeMs+ctimeMs 指纹判定，改写路径（truncate/格式升级/
 * 尾行修复/导入）在「同尺寸」或「同毫秒」落盘时指纹可能不变（见 session-store
 * writeMeta 的同款注释），缓存会误命中陈旧索引（分页读到旧偏移）。写入侧改写
 * 完成后必须显式调用本函数，不只依赖指纹自动失配。
 */
export function invalidateMessageIndex(filePath: string): void {
  indexes.delete(filePath);
}

/**
 * 空闲逐出（设置项 sessionCacheIdleMinutes）：释放长时间没被访问的字节索引。
 * 索引本身也占内存（每会话 = 行偏移表 + 全量消息 id 表，15k 条消息约 1.5MB），
 * 过去只有 32 条的 LRU、空转时不释放。下次分页读取自动重建。
 */
export function sweepIdleMessageIndexes(now: number = Date.now()): number {
  let evicted = 0;
  for (const [filePath, index] of indexes) {
    if (isCacheEntryIdle(index.lastAccess, now)) {
      indexes.delete(filePath);
      evicted += 1;
    }
  }
  return evicted;
}

async function getIndex(filePath: string): Promise<MessageFileIndex> {
  const now = Date.now();
  // 惰性清扫：任意一次索引访问顺带释放空闲条目（不依赖定时器）
  sweepIdleMessageIndexes(now);
  const info = await stat(filePath);
  const cached = indexes.get(filePath);
  if (cached && cached.size === info.size && cached.modifiedMs === info.mtimeMs && cached.changedMs === info.ctimeMs) {
    cached.lastAccess = now;
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
        cached.lastAccess = now;
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

  const built: MessageFileIndex = {
    size: info.size,
    lastAccess: now,
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
