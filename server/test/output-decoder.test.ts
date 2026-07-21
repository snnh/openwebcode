import { describe, expect, it } from "vitest";
import { decodeChildProcessOutput, decodeProcessOutputChunks } from "../src/agent/output-decoder.js";

describe("child-process output decoding", () => {
  it("keeps valid UTF-8 intact before considering a Windows fallback", () => {
    expect(decodeChildProcessOutput(Buffer.from("中文 UTF-8", "utf8"), "win32")).toBe("中文 UTF-8");
  });

  it("decodes Chinese Windows CP936/GBK output without replacement characters", () => {
    // "中文" encoded by the default simplified-Chinese Windows code page.
    const cp936 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeChildProcessOutput(cp936, "win32")).toBe("中文");
  });

  it("joins adjacent pipe reads before GBK decoding, while retaining stdout/stderr order", () => {
    const decoded = decodeProcessOutputChunks([
      { stream: "stdout", data: Buffer.from([0xd6, 0xd0]).toString("base64"), seq: 2 },
      { stream: "stdout", data: Buffer.from([0xce, 0xc4]).toString("base64"), seq: 3 },
      { stream: "stderr", data: Buffer.from("失败", "utf8").toString("base64"), seq: 4 },
      { stream: "stdout", data: Buffer.from("\n", "utf8").toString("base64"), seq: 5 },
    ], "win32");

    expect(decoded).toEqual([
      { stream: "stdout", data: "中文" },
      { stream: "stderr", data: "失败" },
      { stream: "stdout", data: "\n" },
    ]);
  });

  it("does not reinterpret malformed output as GBK off Windows", () => {
    expect(decodeChildProcessOutput(Buffer.from([0xd6, 0xd0]), "linux")).toContain("\uFFFD");
  });
});
