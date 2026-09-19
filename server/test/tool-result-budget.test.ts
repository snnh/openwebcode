import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateTokens, maxPrefixWithinTokenBudget } from "../src/context/model-profile.js";
import { boundToolResult } from "../src/context/tool-result-budget.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("maxPrefixWithinTokenBudget 与 estimateTokens 同口径", () => {
  it("ASCII / 中文 / 代理对前缀：token 数不超预算，且不切开代理对", () => {
    expect(maxPrefixWithinTokenBudget("abcdefgh", 1)).toBe(4); // ASCII 4 字符/token
    expect(maxPrefixWithinTokenBudget("中文中文", 2)).toBe(3); // CJK 1.5 字符/token
    // 😀 是代理对：整对计一次 token，预算不足时截在代理对之前（不产出孤立高位代理）
    expect(maxPrefixWithinTokenBudget("ab😀cd", 1)).toBe(2);

    const mixed = "x".repeat(50) + "中文😀".repeat(30) + "y".repeat(50);
    for (const budget of [1, 2, 5, 13, 40, 100]) {
      const prefix = mixed.slice(0, maxPrefixWithinTokenBudget(mixed, budget));
      expect(estimateTokens(prefix)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("boundToolResult 截断口径与 estimateTokens 一致", () => {
  it("纯中文结果：截断后 estimateTokens ≤ 预算（旧实现按 4 字符/token 会超约 2.7 倍）", async () => {
    const root = await tempRoot("owc-tool-budget-cjk-");
    const content = "中文内容重复".repeat(4_000); // 24000 字符，按 1.5 字符/token 约 16000 tokens
    const bounded = await boundToolResult(root, "grep", content); // grep 预算 4000 tokens

    expect(bounded.truncated).toBe(true);
    expect(bounded.originalTokens).toBe(estimateTokens(content));
    // 旧实现取 budget*4 = 16000 字符（约 10667 tokens）：中文会静默超预算，压缩阈值因此不触发
    expect(estimateTokens(bounded.content)).toBeLessThanOrEqual(4_000);
    const visible = bounded.content.split("\n[truncated:")[0] ?? "";
    expect(visible.length).toBeGreaterThan(4_000); // 中文按 1.5 字符/token 可留更多字符
    expect(content.startsWith(visible)).toBe(true);

    // 全文仍可从 artifact 续读
    const artifact = await readFile(path.join(root, "artifacts", `${bounded.artifactId}.txt`), "utf8");
    expect(artifact).toBe(content);

    // 未超预算：原样返回，不落 artifact
    expect(await boundToolResult(root, "grep", "短结果")).toEqual({
      content: "短结果",
      truncated: false,
      originalTokens: estimateTokens("短结果"),
    });
  });

  it("混合内容（ASCII + 中文 + emoji）：截断后不超预算且不产出孤立代理码元", async () => {
    const root = await tempRoot("owc-tool-budget-mixed-");
    const content = ("console.log(\"hi\")\n" + "中文日志😀".repeat(20)).repeat(1_000);
    const bounded = await boundToolResult(root, "grep", content);

    expect(bounded.truncated).toBe(true);
    expect(estimateTokens(bounded.content)).toBeLessThanOrEqual(4_000);
    expect(estimateTokens(bounded.content)).toBeGreaterThan(3_600); // 截断点仍应把预算用满（含截断提示自身）
    // 代理对不被切开：孤立代理码元经 UTF-8 往返会变成 U+FFFD
    expect(Buffer.from(bounded.content, "utf8").toString("utf8")).toBe(bounded.content);
  });
});
