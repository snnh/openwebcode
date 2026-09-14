import { EventEmitter } from "node:events";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
/** A 20 MiB PDF becomes just under 28 MiB when represented as canonical
 * base64 in fs.writeBase64. Keep server framing in lockstep with core. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("RPC message exceeds 32 MiB");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

export class FrameDecoder extends EventEmitter {
  /**
   * 分块累积 + 单次拼接：大帧（fs.readBase64/index.scan/diff，可达 32 MiB）以
   * 16–64 KiB chunk 分批到达。逐 chunk Buffer.concat 会把已累积内容反复重拷
   * （帧越大拷贝量越接近平方级）；改为 chunk 列表，只有帧完整时才一次性拼出 body。
   * 头部解析只需要前 8 KiB+4 字节的前缀视图，拼接面积极小且不回退。
   */
  private chunks: Buffer[] = [];
  private buffered = 0;
  private contentLength = -1;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.decodeOne()) {
      // Drain every complete frame before waiting for more bytes.
    }
  }

  /** 从块列表头部取走 n 字节（调用前须保证 buffered >= n）。 */
  private take(n: number): Buffer {
    this.buffered -= n;
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0]!;
      const need = n - offset;
      if (chunk.length <= need) {
        chunk.copy(out, offset);
        offset += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, offset, 0, need);
        this.chunks[0] = chunk.subarray(need);
        offset += need;
      }
    }
    return out;
  }

  /** 把头若干块合并成单块前缀（至多 limit 字节），供 header 分隔符查找。 */
  private compactPrefix(limit: number): void {
    if (this.chunks.length === 0 || this.chunks[0]!.length >= limit) return;
    let total = 0;
    let count = 0;
    while (count < this.chunks.length && total < limit) {
      total += this.chunks[count]!.length;
      count += 1;
    }
    this.chunks.splice(0, count, Buffer.concat(this.chunks.slice(0, count)));
  }

  private decodeOne(): boolean {
    if (this.contentLength < 0) {
      this.compactPrefix(8192 + HEADER_SEPARATOR.length);
      const head = this.chunks[0];
      if (!head) return false;
      const separator = head.indexOf(HEADER_SEPARATOR);
      if (separator < 0) {
        if (head.length >= 8192 + HEADER_SEPARATOR.length) this.fail(new Error("RPC header exceeds 8 KiB"));
        return false;
      }
      if (separator > 8192) return this.fail(new Error("RPC header exceeds 8 KiB"));

      const headerText = head.subarray(0, separator).toString("ascii");
      const lines = headerText.split("\r\n");
      let contentLength: number | undefined;
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon < 1) return this.fail(new Error("Malformed RPC header"));
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name !== "content-length") continue;
        if (contentLength !== undefined) return this.fail(new Error("Duplicate Content-Length"));
        const raw = line.slice(colon + 1).trim();
        if (!/^(0|[1-9]\d*)$/.test(raw)) return this.fail(new Error("Invalid Content-Length"));
        contentLength = Number(raw);
      }

      if (contentLength === undefined) return this.fail(new Error("Missing Content-Length"));
      if (!Number.isSafeInteger(contentLength) || contentLength > MAX_MESSAGE_BYTES) {
        return this.fail(new Error("RPC message exceeds 32 MiB"));
      }
      this.take(separator + HEADER_SEPARATOR.length);
      this.contentLength = contentLength;
    }

    if (this.buffered < this.contentLength) return false;
    const body = this.take(this.contentLength);
    this.contentLength = -1;

    try {
      this.emit("message", JSON.parse(body.toString("utf8")) as unknown);
    } catch (error) {
      return this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  private fail(error: Error): false {
    this.chunks = [];
    this.buffered = 0;
    this.contentLength = -1;
    this.emit("error", error);
    return false;
  }
}
