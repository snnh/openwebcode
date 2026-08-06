import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/context/model-profile.js";

describe("estimateTokens", () => {
  it("ASCII 按 ~4 字符/token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(1);
  });

  it("非 ASCII（CJK）按 ~1.5 字符/token 加权，不再低估 3-4 倍", () => {
    // 4 个汉字：旧口径 ceil(4/4)=1，实际约 4 token，新口径 ceil(4/1.5)=3
    expect(estimateTokens("你好世界")).toBe(3);
    expect(estimateTokens("你")).toBe(1);
  });

  it("中英混排分段加权", () => {
    // "abcd" → 1，"你好" → ceil 边界内合计 ceil(1 + 1.333) = 3
    expect(estimateTokens("abcd你好")).toBe(3);
    // 长中文串的估算量级接近实际 token 数（约 1 字符/token）
    const text = "中文会话内容".repeat(100);
    expect(estimateTokens(text)).toBeGreaterThan(text.length / 4);
  });
});
