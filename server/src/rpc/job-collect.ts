import type { CoreClientLike } from "../core-client.js";

/**
 * 轮询收集 index.scan / index.extract 等 JSONL job 输出。
 *
 * 语义与行为（与 index-manager 原私有实现一致）：
 * - 增量解码：chunk.data 是 base64（docs/protocol.md §job.output），按块挂到行尾缓冲上，
 *   切出完整行才 UTF-8 解码——换行符是单字节，多字节字符不会跨行被截成 U+FFFD。
 * - 每轮（含终态）循环读取直到 nextSeq 不再前进：单次 limit:128（core 上限）可能读不完残留输出。
 * - core 输出 ring 溢出（truncated）意味着中间有行丢失：静默损坏不如显式失败。
 * - 终态冲刷残余半行（无终止换行的末行）。
 */
export async function collectJobJsonLines(
  core: Pick<CoreClientLike, "jobStatus" | "jobOutput">,
  sessionId: string,
  jobId: string,
  signal: AbortSignal,
  jobKind: string,
  onLine: (line: string) => void,
  pollMs = 200,
): Promise<{ summary: Record<string, unknown> | undefined }> {
  let seq = 0;
  let tail = Buffer.alloc(0);
  let lastLine: string | undefined;
  const emitChunk = (incoming: Buffer): void => {
    const data = tail.length ? Buffer.concat([tail, incoming]) : incoming;
    let lineStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      const line = data.subarray(lineStart, index).toString("utf8").trim();
      if (line) {
        lastLine = line;
        onLine(line);
      }
      lineStart = index + 1;
    }
    // 拷贝残余半行，避免 subarray 长期挂住整块 data
    tail = Buffer.from(data.subarray(lineStart));
  };
  for (;;) {
    if (signal.aborted) throw new Error("cancelled");
    const status = await core.jobStatus({ sessionId, jobId });
    let output = await core.jobOutput({ sessionId, jobId, afterSeq: seq, limit: 128 });
    for (;;) {
      // core 输出 ring 溢出意味着中间有行丢失：静默损坏不如显式失败（调用方可整体重建）
      if (output.truncated) throw new Error(`${jobKind} job output truncated by core ring buffer`);
      for (const chunk of output.chunks) {
        if (chunk.stream === "stdout") emitChunk(Buffer.from(chunk.data, "base64"));
      }
      if (output.nextSeq === seq || output.chunks.length === 0) break;
      seq = output.nextSeq;
      output = await core.jobOutput({ sessionId, jobId, afterSeq: seq, limit: 128 });
    }
    if (status.state !== "running") {
      if (status.state !== "completed") {
        throw new Error(`${jobKind} job ${status.state}${status.error ? `: ${status.error}` : ""}`);
      }
      // 终态冲刷残余半行（无终止换行的末行）
      if (tail.length) {
        const line = tail.toString("utf8").trim();
        if (line) {
          lastLine = line;
          onLine(line);
        }
      }
      return { summary: lastLine ? trailingJobSummary(lastLine) : undefined };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** JSONL 末行若是 {"summary":{...}} 则取出（index.scan/index.extract 约定的终止行）；解析失败按无 summary。 */
function trailingJobSummary(line: string): Record<string, unknown> | undefined {
  try {
    const record = JSON.parse(line) as { summary?: unknown };
    return record.summary && typeof record.summary === "object" ? (record.summary as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}