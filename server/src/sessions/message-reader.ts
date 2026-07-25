/**
 * Efficient JSONL message reading for session pagination.
 *
 * Key optimisation: read the raw file once but only `JSON.parse` the lines
 * in the requested page. For a 100 K-line session this avoids parsing
 * 99 900 messages that will never be sent to the client.
 */
import { readFile } from "node:fs/promises";

export interface MessagePage<T> {
  messages: T[];
  /** Whether older messages exist beyond this page */
  hasMore: boolean;
  /** Total non-empty lines in the JSONL file */
  totalLines: number;
  /** Recovery status derived from the returned page only */
  recovery?: { state: "recovered" | "needs_repair"; message: string } | undefined;
}

/** Default number of messages returned on initial session load */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Read the last `limit` messages from a JSONL file.
 *
 * Reads the raw file once, splits into lines, then only `JSON.parse`s
 * the last `limit` non-empty lines. The rest are skipped without
 * any JSON parsing cost.
 */
export async function readMessagesTail<T>(
  filePath: string,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<MessagePage<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { messages: [], hasMore: false, totalLines: 0, recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }

  if (!raw.trim()) return { messages: [], hasMore: false, totalLines: 0 };

  const allLines = raw.split("\n");
  const nonEmpty: number[] = [];
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i]!.trim()) nonEmpty.push(i);
  }

  const total = nonEmpty.length;
  if (total === 0) return { messages: [], hasMore: false, totalLines: 0 };

  const hasMore = total > limit;
  const startIdx = hasMore ? total - limit : 0;
  const pageLines = nonEmpty.slice(startIdx);

  const messages: T[] = [];
  let corruptTail = false;
  let corruptMiddle = false;
  const lastIdx = pageLines[pageLines.length - 1];

  for (const idx of pageLines) {
    try {
      messages.push(JSON.parse(allLines[idx]!) as T);
    } catch {
      if (idx === lastIdx) corruptTail = true;
      else corruptMiddle = true;
    }
  }

  let recovery: MessagePage<T>["recovery"];
  if (corruptMiddle) recovery = { state: "needs_repair", message: "messages.jsonl contains corrupt non-tail records" };
  else if (corruptTail) recovery = { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" };

  return { messages, hasMore, totalLines: total, recovery };
}

/**
 * Read `limit` messages that appear **before** the given `beforeId` in the JSONL file.
 *
 * Scans line IDs via lightweight regex (no full JSON.parse) to find the
 * target message, then only parses the `limit` lines preceding it.
 */
export async function readMessagesBefore<T>(
  filePath: string,
  beforeId: string,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<MessagePage<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { messages: [], hasMore: false, totalLines: 0, recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }

  if (!raw.trim()) return { messages: [], hasMore: false, totalLines: 0 };

  const allLines = raw.split("\n");
  const nonEmpty: number[] = [];
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i]!.trim()) nonEmpty.push(i);
  }

  const total = nonEmpty.length;
  if (total === 0) return { messages: [], hasMore: false, totalLines: 0 };

  // Find the line index of beforeId using lightweight regex (no JSON.parse)
  let targetIdx = -1;
  for (let i = 0; i < nonEmpty.length; i++) {
    const lineIdx = nonEmpty[i]!;
    const id = extractId(allLines[lineIdx]!);
    if (id === beforeId) {
      targetIdx = i;
      break;
    }
  }

  // Message not found — return empty (caller should treat as no more)
  if (targetIdx === -1) return { messages: [], hasMore: false, totalLines: total };

  // Read `limit` messages before the target
  const startIdx = Math.max(0, targetIdx - limit);
  const pageLines = nonEmpty.slice(startIdx, targetIdx);

  const messages: T[] = [];
  for (const idx of pageLines) {
    try {
      messages.push(JSON.parse(allLines[idx]!) as T);
    } catch {
      // Skip corrupt lines in pagination
    }
  }

  return { messages, hasMore: startIdx > 0, totalLines: total };
}

/**
 * Check recovery status by reading only the last non-empty line.
 * Much faster than reading + parsing all messages.
 *
 * Only detects tail corruption (the common case from interrupted writes).
 * Middle corruption requires a full scan and is deferred to `readMessages()`.
 */
export async function checkRecovery(filePath: string): Promise<{ recovery?: { state: "recovered" | "needs_repair"; message: string } }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { recovery: { state: "needs_repair", message: "messages.jsonl is missing" } };
  }

  if (!raw.trim()) return {};

  // Find the last non-empty line without splitting the entire file
  const trimmed = raw.replace(/\n+$/, "");
  const lastNewline = trimmed.lastIndexOf("\n");
  const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);

  if (!lastLine.trim()) return {};

  try {
    JSON.parse(lastLine);
    return {};
  } catch {
    return { recovery: { state: "recovered", message: "Ignored a corrupt trailing messages.jsonl record" } };
  }
}

/** Fast extraction of the "id" field from a JSON line without full JSON.parse */
function extractId(line: string): string | undefined {
  const match = line.match(/"id"\s*:\s*"([0-9a-f-]{36})"/);
  return match?.[1];
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code: string }).code === "ENOENT";
}
