import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/rpc/frame-codec.js";

describe("FrameDecoder", () => {
  it("decodes fragmented and adjacent UTF-8 frames", () => {
    const decoder = new FrameDecoder();
    const messages: unknown[] = [];
    decoder.on("message", (message) => messages.push(message));
    const first = encodeFrame({ text: "你好" });
    const second = encodeFrame({ value: 2 });
    const input = Buffer.concat([first, second]);
    decoder.push(input.subarray(0, 7));
    decoder.push(input.subarray(7, first.length + 3));
    decoder.push(input.subarray(first.length + 3));
    expect(messages).toEqual([{ text: "你好" }, { value: 2 }]);
  });

  it("rejects duplicate Content-Length headers", () => {
    const decoder = new FrameDecoder();
    const errors: Error[] = [];
    decoder.on("error", (error) => errors.push(error));
    decoder.push(Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"));
    expect(errors[0]?.message).toContain("Duplicate");
  });

  it("rejects a complete oversized header", () => {
    const decoder = new FrameDecoder();
    const errors: Error[] = [];
    decoder.on("error", (error) => errors.push(error));
    decoder.push(Buffer.from(`X-Fill: ${"x".repeat(8192)}\r\nContent-Length: 2\r\n\r\n{}`));
    expect(errors[0]?.message).toContain("header exceeds");
  });

  it("keeps the 32 MiB core frame boundary and rejects larger declarations", () => {
    const atLimit = new FrameDecoder();
    const acceptedErrors: Error[] = [];
    atLimit.on("error", (error) => acceptedErrors.push(error));
    // No body yet: a legal maximum declaration remains buffered rather than
    // rejected, which avoids allocating a synthetic 32 MiB test payload.
    atLimit.push(Buffer.from("Content-Length: 33554432\r\n\r\n"));
    expect(acceptedErrors).toEqual([]);

    const overLimit = new FrameDecoder();
    const errors: Error[] = [];
    overLimit.on("error", (error) => errors.push(error));
    overLimit.push(Buffer.from("Content-Length: 33554433\r\n\r\n"));
    expect(errors[0]?.message).toContain("32 MiB");
  });
});
