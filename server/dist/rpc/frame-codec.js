import { EventEmitter } from "node:events";
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
/** A 20 MiB PDF becomes just under 28 MiB when represented as canonical
 * base64 in fs.writeBase64. Keep server framing in lockstep with core. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export function encodeFrame(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_MESSAGE_BYTES)
        throw new Error("RPC message exceeds 32 MiB");
    return Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
        body,
    ]);
}
export class FrameDecoder extends EventEmitter {
    buffer = Buffer.alloc(0);
    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.decodeOne()) {
            // Drain every complete frame before waiting for more bytes.
        }
    }
    decodeOne() {
        const separator = this.buffer.indexOf(HEADER_SEPARATOR);
        if (separator < 0) {
            if (this.buffer.length > 8192)
                this.fail(new Error("RPC header exceeds 8 KiB"));
            return false;
        }
        if (separator > 8192)
            return this.fail(new Error("RPC header exceeds 8 KiB"));
        const headerText = this.buffer.subarray(0, separator).toString("ascii");
        const lines = headerText.split("\r\n");
        let contentLength;
        for (const line of lines) {
            const colon = line.indexOf(":");
            if (colon < 1)
                return this.fail(new Error("Malformed RPC header"));
            const name = line.slice(0, colon).trim().toLowerCase();
            if (name !== "content-length")
                continue;
            if (contentLength !== undefined)
                return this.fail(new Error("Duplicate Content-Length"));
            const raw = line.slice(colon + 1).trim();
            if (!/^(0|[1-9]\d*)$/.test(raw))
                return this.fail(new Error("Invalid Content-Length"));
            contentLength = Number(raw);
        }
        if (contentLength === undefined)
            return this.fail(new Error("Missing Content-Length"));
        if (!Number.isSafeInteger(contentLength) || contentLength > MAX_MESSAGE_BYTES) {
            return this.fail(new Error("RPC message exceeds 32 MiB"));
        }
        const bodyStart = separator + HEADER_SEPARATOR.length;
        if (this.buffer.length < bodyStart + contentLength)
            return false;
        const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
        this.buffer = this.buffer.subarray(bodyStart + contentLength);
        try {
            this.emit("message", JSON.parse(body.toString("utf8")));
        }
        catch (error) {
            return this.fail(error instanceof Error ? error : new Error(String(error)));
        }
        return true;
    }
    fail(error) {
        this.buffer = Buffer.alloc(0);
        this.emit("error", error);
        return false;
    }
}
