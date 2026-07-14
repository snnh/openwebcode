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
});
